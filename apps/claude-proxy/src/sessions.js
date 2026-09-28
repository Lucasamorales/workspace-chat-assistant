/**
 * Live CLI processes, and which request each one belongs to.
 *
 * The hot path is a *held* session. When the model asks for one of Buddy's tools, the CLI calls
 * our stub MCP server and waits inside that call. The proxy answers Buddy straight away with the
 * tool_use; Buddy runs the tool — behind its approval card when it writes — and sends the result
 * as its next request; the proxy recognises the tool_use ids, hands the result to the waiting
 * call, and the same process carries on. No cold start after the first turn, history is the
 * process's own, and the prompt cache stays warm.
 *
 * Everything else is a fallback, and logged as one:
 *   continuation  a new message in a thread whose last reply came from a process still alive
 *   spare         a process started in advance, so a new conversation skips the cold start
 *   replay        nothing alive knows this conversation: start one and hand it the history as
 *                 text. Correct but slower, and the path the spike showed needs care with tools.
 *
 * There is never a fallback to the API. If the CLI cannot answer on the subscription, the
 * request fails and says why — the experiment exists to find out where that happens.
 */

const crypto = require('crypto');
const {
  planFor, turnKind, replayText, userLine, textOf, asBlocks, zeroUsage, addUsage, responseFor, exchangeKey, fromCli, sameArgs,
} = require('./translate');
const { usageFields } = require('./log');

const DEFAULT_LIMITS = {
  turnMs: 5 * 60 * 1000,        // one answer, however many internal calls it takes
  holdMs: 16 * 60 * 1000,       // Buddy's approval cards expire after 15 minutes
  idleMs: 10 * 60 * 1000,       // keep a finished thread's process for its next message
  spareMs: 10 * 60 * 1000,
  unmatchedMs: 10 * 1000,       // a stub call that arrives before its tool_use has been parsed
  windowWaitMs: 1500,           // the subscription window is reported just after each reply
  maxProcesses: 4,
  spares: true,
};

const CONTINUE = 'The tool calls above have finished and their results are listed. Carry on with the request.';

const failure = (message, status = 502, type = 'api_error') => Object.assign(new Error(message), { status, type });

function createSessions({ spawnSession, log, limits: overrides = {}, now = () => Date.now(), timers = global }) {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  const sessions = new Map();
  const byToolUse = new Map();

  const brief = s => ({ sid: s.id.slice(0, 8), state: s.state });

  /* ---------- lifecycle ---------- */

  function start(plan) {
    evictIfFull();
    const proc = spawnSession(plan);
    const s = {
      id: proc.id, token: proc.token, proc, plan,
      state: 'starting', spare: false, authSource: undefined, guardFailed: null,
      rateLimit: null, turn: null, pending: new Map(), results: new Map(), unmatched: [],
      lastExchange: null, requestUserText: '', endReason: null, inits: 0, onWindow: null,
      createdAt: now(), lastActiveAt: now(), turns: 0, apiCalls: 0, timer: null,
    };
    sessions.set(s.id, s);

    // The CLI announces itself again at the start of every user turn; each one is re-checked.
    proc.parser.on('init', ev => {
      s.inits += 1;
      s.authSource = ev.apiKeySource;
      const servers = (ev.mcp_servers || []).map(m => `${m.name}:${m.status}`);
      if (s.inits === 1) {
        log.info('cli ready', {
          ...brief(s), ms: now() - s.createdAt, model: ev.model, buddyTools: (ev.tools || []).filter(t => fromCli(t)).length,
          builtins: (ev.tools || []).filter(t => !fromCli(t)), servers, authSource: ev.apiKeySource,
        });
      } else {
        log.info('cli started a new turn', { ...brief(s), turn: s.inits, authSource: ev.apiKeySource });
      }
      // The whole experiment rests on this: no API key, ever. 'none' means the subscription login.
      if (ev.apiKeySource !== 'none') guard(s, `the CLI authenticated with "${ev.apiKeySource}", not the subscription`);
      if (plan.tools.length && !servers.includes('buddy:connected')) log.warn('stub MCP server not connected', { ...brief(s), servers });
      if (s.state === 'starting') s.state = s.spare ? 'spare' : (s.turn ? 'busy' : 'idle');
    });

    proc.parser.on('rate_limit', info => {
      s.rateLimit = info;
      const w = info.unifiedWindows || {};
      log.info('subscription window', {
        ...brief(s), status: info.status, fiveHour: w.five_hour && w.five_hour.utilization,
        sevenDay: w.seven_day && w.seven_day.utilization, overage: info.isUsingOverage, overageStatus: info.overageStatus,
      });
      if (info.isUsingOverage === true) guard(s, 'the subscription is billing overage — that is pay-per-use');
      // Stronger than catching overage in the act: refuse to run at all while the account *could*
      // bill per use. The CLI reports the window once per process, not per reply, so a reply that
      // began overage could otherwise leave before the report arrived. With extra usage off, no
      // reply can be billed per use at all. ("rejected" is what an account without it reports.)
      else if (info.overageStatus !== undefined && info.overageStatus !== 'rejected') {
        guard(s, `extra usage is switched on for this Claude account (status "${info.overageStatus}"); turn it off so nothing can be billed per use`);
      }
      // A reply waiting on this report can go now — unless the guard above has just refused it.
      if (s.onWindow) {
        const release = s.onWindow;
        s.onWindow = null;
        release();
      }
    });

    proc.parser.on('message', msg => onMessage(s, msg));

    proc.parser.on('result', ev => {
      log.info('cli turn finished', { ...brief(s), subtype: ev.subtype, isError: Boolean(ev.is_error), apiMs: ev.duration_api_ms, apiEquivalentUsd: ev.total_cost_usd });
      if ((ev.is_error || ev.subtype !== 'success') && s.turn) failTurn(s, cliError(s, ev));
    });

    proc.parser.on('noise', line => log.warn('cli printed something that is not JSON', { ...brief(s), sample: line.slice(0, 120) }));

    proc.onExit(code => {
      const was = s.state;
      s.state = 'dead';
      clearExpiry(s);
      if (s.turn) failTurn(s, failure(`The Claude CLI stopped (exit ${code}). ${tailOf(s)}`.trim()), { alreadyDead: true });
      for (const [id, p] of s.pending) {
        if (p.respond) p.respond({ isError: true, content: 'The session ended before Buddy answered.' });
        byToolUse.delete(id);
      }
      for (const u of s.unmatched) u.resolve({ isError: true, content: 'The session ended.' });
      sessions.delete(s.id);
      log.info('session ended', {
        sid: s.id.slice(0, 8), was, code, reason: s.endReason || 'exited', lifetimeMs: now() - s.createdAt,
        turns: s.turns, apiCalls: s.apiCalls, heldCallsLeft: s.pending.size,
      });
    });

    return s;
  }

  const tailOf = s => {
    const t = (s.proc.stderrTail && s.proc.stderrTail()) || '';
    return t.trim() ? `Last output: ${t.trim().slice(-300)}` : '';
  };

  function cliError(s, ev) {
    const info = s.rateLimit || {};
    if (info.status === 'rejected') {
      const w = info.unifiedWindows || {};
      const resets = (w.five_hour && w.five_hour.resetsAt) || info.resetsAt;
      const when = resets ? new Date(resets * 1000).toISOString().slice(11, 16) : 'later';
      return failure(`Your Claude subscription limit is reached. It resets at ${when} UTC.`, 429, 'rate_limit_error');
    }
    const detail = ev.result || (ev.errors && ev.errors.join('; ')) || ev.subtype;
    return failure(`The Claude CLI could not answer: ${String(detail).slice(0, 300)}`);
  }

  function end(s, reason, { graceful = false } = {}) {
    if (s.state === 'dead') return;
    s.endReason = reason;
    clearExpiry(s);
    if (graceful) s.proc.closeInput();
    else s.proc.kill();
  }

  function guard(s, reason) {
    s.guardFailed = reason;
    log.error('guard refused the session', { ...brief(s), reason });
    const err = failure(`Refused: ${reason}. The subscription proxy never answers through API billing.`, 403, 'permission_error');
    if (s.turn) failTurn(s, err);
    else end(s, `guard: ${reason}`);
  }

  function armExpiry(s, ms, reason, { graceful = false } = {}) {
    clearExpiry(s);
    s.timer = timers.setTimeout(() => {
      log.info('session expired', { ...brief(s), reason, afterMs: ms });
      end(s, reason, { graceful });
    }, ms);
    if (s.timer && s.timer.unref) s.timer.unref();
  }
  function clearExpiry(s) {
    if (s.timer) timers.clearTimeout(s.timer);
    s.timer = null;
  }

  function evictIfFull() {
    if (sessions.size < limits.maxProcesses) return;
    const order = [...sessions.values()]
      .filter(s => s.state === 'spare' || (s.state === 'idle' && !s.turn))
      .sort((a, b) => (a.state === 'spare' ? -1 : 0) - (b.state === 'spare' ? -1 : 0) || a.lastActiveAt - b.lastActiveAt);
    if (!order.length) throw failure('Too many conversations in progress on the subscription proxy. Try again in a moment.', 503, 'overloaded_error');
    log.info('evicting to make room', { ...brief(order[0]), live: sessions.size });
    end(order[0], 'evicted', { graceful: order[0].state === 'idle' });
  }

  /* ---------- turns ---------- */

  function beginTurn(s, rid, { write } = {}) {
    if (s.guardFailed) return Promise.reject(failure(`Refused: ${s.guardFailed}.`, 403, 'permission_error'));
    if (s.turn) return Promise.reject(failure('That conversation is already answering a request.', 409, 'invalid_request_error'));
    return new Promise((resolve, reject) => {
      s.turn = {
        rid, resolve, reject, startedAt: now(), usage: zeroUsage(), apiCalls: 0, internal: 0,
        timer: timers.setTimeout(() => failTurn(s, failure(`No answer from the Claude CLI within ${Math.round(limits.turnMs / 1000)}s.`, 504)), limits.turnMs),
      };
      s.state = s.state === 'starting' ? 'starting' : 'busy';
      s.lastActiveAt = now();
      clearExpiry(s);
      if (write) s.proc.write(write);
    });
  }

  function takeTurn(s) {
    const t = s.turn;
    s.turn = null;
    if (t) timers.clearTimeout(t.timer);
    return t;
  }

  function failTurn(s, error, { alreadyDead = false } = {}) {
    const t = takeTurn(s);
    if (!t) return;
    log.error('request failed', { ...brief(s), rid: t.rid, ms: now() - t.startedAt, status: error.status, type: error.type, why: error.message.slice(0, 300) });
    t.reject(error);
    // A process that failed a turn is not trusted with the next one.
    if (!alreadyDead) end(s, `failed: ${error.type || 'error'}`);
  }

  function onMessage(s, msg) {
    s.apiCalls += 1;
    const t = s.turn;
    const types = msg.blocks.map(b => (b.type === 'tool_use' ? `tool_use:${fromCli(b.name) || b.name}` : b.type));
    if (!t) {
      log.warn('message arrived with no request waiting for it', { ...brief(s), stop: msg.stopReason, types });
      return;
    }
    addUsage(t.usage, msg.usage);
    t.apiCalls += 1;
    log.info('api call done', { ...brief(s), rid: t.rid, n: t.apiCalls, stop: msg.stopReason, types, usage: usageFields(msg.usage) });

    const buddyCalls = msg.blocks.filter(b => b.type === 'tool_use' && fromCli(b.name));
    if (buddyCalls.length) {
      for (const b of buddyCalls) {
        if (b.badJson) log.warn('tool call arguments were not valid JSON', { ...brief(s), tool: fromCli(b.name) });
        s.pending.set(b.id, { name: fromCli(b.name), input: b.input, claimed: false, respond: null, askedAt: now() });
        byToolUse.set(b.id, s);
      }
      matchUnmatched(s);
      s.state = 'holding';
      // Armed before answering: if the guard ends the session instead, ending clears the timer.
      armExpiry(s, limits.holdMs, 'held too long: Buddy never sent the tool results');
      finishAfterWindow(s, msg);
      return;
    }

    const builtin = msg.blocks.filter(b => b.type === 'tool_use');
    if (builtin.length || msg.stopReason === 'tool_use') {
      // ToolSearch runs inside the CLI; the answer comes in a later API call of the same turn.
      t.internal += builtin.length;
      log.info('cli used a built-in tool', { ...brief(s), rid: t.rid, tools: builtin.map(b => b.name) });
      return;
    }

    s.state = 'idle';
    armExpiry(s, limits.idleMs, 'idle', { graceful: true });
    finishAfterWindow(s, msg);
  }

  /**
   * The CLI reports the subscription window a few milliseconds *after* the first reply of a
   * process — and then only when something changes. Answering before that first report would
   * mean answering before anything is known about how the account bills (the first real run
   * caught exactly that). So a process's first reply waits for it; later ones answer at once,
   * and any later report still triggers the guard on the spot.
   */
  function finishAfterWindow(s, msg) {
    const t = s.turn;
    if (!t) return;
    if (s.rateLimit) {
      finishTurn(s, msg);
      return;
    }
    let timer = null;
    const release = () => {
      timers.clearTimeout(timer);
      if (s.turn === t) finishTurn(s, msg);
    };
    timer = timers.setTimeout(() => {
      s.onWindow = null;
      log.warn('no subscription window reported for this reply; answering on the last one known', { ...brief(s), rid: t.rid, waitedMs: limits.windowWaitMs });
      release();
    }, limits.windowWaitMs);
    s.onWindow = release;
  }

  function finishTurn(s, msg) {
    // Belt and braces: the init check already refused a non-subscription login.
    if (s.authSource !== 'none') {
      guard(s, `no confirmed subscription login (auth source ${s.authSource})`);
      return;
    }
    const t = takeTurn(s);
    if (!t) return;
    s.turns += 1;
    const response = responseFor({ message: msg, usage: t.usage, rateLimit: s.rateLimit, apiCalls: t.apiCalls, internalCalls: t.internal });
    // Keyed on the reply exactly as Buddy will store it, so the thread's next message finds us.
    if (response.stop_reason !== 'tool_use') s.lastExchange = exchangeKey(s.requestUserText, textOf(response.content));
    const sub = response.usage.buddy_subscription;
    log.info('request answered', {
      ...brief(s), rid: t.rid, ms: now() - t.startedAt, stop: response.stop_reason,
      toolCalls: response.content.filter(b => b.type === 'tool_use').map(b => b.name),
      usage: usageFields(t.usage), apiCalls: t.apiCalls, internal: t.internal,
      fiveHour: sub.five_hour_utilization, sevenDay: sub.seven_day_utilization,
    });
    t.resolve(response);
  }

  /* ---------- held tool calls ---------- */

  function findPending(s, name, args) {
    for (const [id, p] of s.pending) if (!p.claimed && p.name === name && sameArgs(p.input, args)) return id;
    return null;
  }

  function deliver(s, id) {
    const r = s.results.get(id);
    const p = s.pending.get(id);
    s.results.delete(id);
    s.pending.delete(id);
    byToolUse.delete(id);
    log.info('held call answered', { ...brief(s), tool: p && p.name, isError: r.isError, heldMs: p && p.calledAt ? now() - p.calledAt : null });
    return { content: r.content, isError: r.isError };
  }

  function claim(s, id) {
    const p = s.pending.get(id);
    p.claimed = true;
    p.calledAt = now();
    log.info('cli is waiting on a tool call', { ...brief(s), tool: p.name, sinceAskedMs: now() - p.askedAt });
    if (s.results.has(id)) return Promise.resolve(deliver(s, id));
    return new Promise(resolve => { p.respond = resolve; });
  }

  function matchUnmatched(s) {
    s.unmatched = s.unmatched.filter(u => {
      const id = findPending(s, u.name, u.args);
      if (!id) return true;
      timers.clearTimeout(u.timer);
      claim(s, id).then(u.resolve);
      return false;
    });
  }

  /** The stub MCP server relaying a call. Resolves when Buddy has the answer. */
  function onStubCall(sessionId, token, name, args) {
    const s = sessions.get(String(sessionId || ''));
    const ok = s && typeof token === 'string' && token.length === s.token.length
      && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(s.token));
    if (!ok) {
      log.warn('stub call refused: unknown session or bad token', { tool: name });
      return Promise.reject(failure('Unknown session.', 403, 'permission_error'));
    }
    const id = findPending(s, name, args);
    if (id) return claim(s, id);
    // The call can beat the parser: the CLI finishes the message, then calls us over another pipe.
    log.info('stub call arrived before its tool_use; waiting', { ...brief(s), tool: name });
    return new Promise(resolve => {
      const u = { name, args, resolve };
      u.timer = timers.setTimeout(() => {
        s.unmatched = s.unmatched.filter(x => x !== u);
        log.error('stub call matched no tool_use the model asked for', { ...brief(s), tool: name });
        resolve({ isError: true, content: 'Buddy did not ask for this call.' });
      }, limits.unmatchedMs);
      s.unmatched.push(u);
    });
  }

  function continueWithResults(s, results, rid) {
    const waiting = beginTurn(s, rid);
    for (const r of results) {
      s.results.set(r.id, r);
      const p = s.pending.get(r.id);
      if (p && p.respond) {
        const respond = p.respond;
        respond(deliver(s, r.id));
      }
    }
    return waiting;
  }

  /* ---------- finding the right process ---------- */

  function takeSpare(plan) {
    const s = [...sessions.values()].find(x => x.spare && x.plan.configHash === plan.configHash
      && (x.state === 'spare' || x.state === 'starting'));
    if (!s) return null;
    s.spare = false;
    clearExpiry(s);
    if (s.state === 'spare') s.state = 'idle';
    return s;
  }

  function startSpare(plan) {
    if (!limits.spares) return;
    const has = [...sessions.values()].some(x => x.spare && x.plan.configHash === plan.configHash);
    if (has || sessions.size >= limits.maxProcesses) return;
    try {
      const s = start(plan);
      s.spare = true;
      armExpiry(s, limits.spareMs, 'spare never used', { graceful: true });
      log.info('spare started', brief(s));
    } catch (error) {
      log.warn('could not start a spare', { why: error.message });
    }
  }

  function findContinuation(plan, messages) {
    if (messages.length < 3) return null;
    const u = messages[messages.length - 3];
    const a = messages[messages.length - 2];
    if (u.role !== 'user' || a.role !== 'assistant') return null;
    const key = exchangeKey(textOf(u.content), textOf(a.content));
    return [...sessions.values()].find(s => s.state === 'idle' && !s.spare && !s.turn
      && s.plan.configHash === plan.configHash && s.lastExchange === key) || null;
  }

  const requestTextOf = messages => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const blocks = asBlocks(messages[i].content);
      if (messages[i].role === 'user' && !blocks.some(b => b.type === 'tool_result')) return textOf(blocks);
    }
    return '';
  };

  function fresh(plan, { prior, current }, rid, { reason, requestText }) {
    const s = takeSpare(plan);
    const warm = Boolean(s);
    const session = s || start(plan);
    const history = replayText(prior);
    const blocks = history ? [{ type: 'text', text: history }, ...current] : current;
    session.requestUserText = requestText;
    log.info(warm ? 'using a spare' : 'starting a session', { ...brief(session), rid, reason, replayChars: history.length, priorMessages: prior.length });
    const waiting = beginTurn(session, rid, { write: userLine(blocks) });
    startSpare(plan);
    return waiting;
  }

  /* ---------- the entry point ---------- */

  async function handle(body, rid) {
    const plan = planFor(body);
    const turn = turnKind(body.messages);
    log.info('request', {
      rid, kind: turn.kind, model: plan.model, effort: plan.effort, tools: plan.tools.length, toolSearch: plan.toolSearch,
      messages: (body.messages || []).length, ignored: plan.ignored, live: sessions.size,
    });

    if (turn.kind === 'tool_results') {
      const ids = turn.results.map(r => r.id);
      const s = byToolUse.get(ids[0]);
      const live = s && s.state === 'holding' && !s.turn && s.pending.size === ids.length && ids.every(id => s.pending.has(id));
      if (live) {
        log.info('resuming a held session', { ...brief(s), rid, results: ids.length, declined: turn.results.filter(r => r.isError).length });
        return continueWithResults(s, turn.results, rid);
      }
      log.warn('replaying: no live session holds these tool calls', { rid, results: ids.length, found: s ? s.state : 'none' });
      // A stale process must never carry on alongside the replay.
      if (s) end(s, 'superseded by a replay');
      return fresh(plan, { prior: body.messages, current: [{ type: 'text', text: CONTINUE }] }, rid, {
        reason: 'replay_after_tools', requestText: requestTextOf(body.messages),
      });
    }

    const cont = findContinuation(plan, body.messages);
    if (cont) {
      log.info('continuing the thread in its own process', { ...brief(cont), rid });
      cont.requestUserText = textOf(turn.current);
      return beginTurn(cont, rid, { write: userLine(turn.current) });
    }
    return fresh(plan, turn, rid, { reason: turn.prior.length ? 'replay_history' : 'new', requestText: textOf(turn.current) });
  }

  function stats() {
    const byState = {};
    for (const s of sessions.values()) byState[s.state] = (byState[s.state] || 0) + 1;
    return { live: sessions.size, byState, heldCalls: byToolUse.size };
  }

  function shutdown() {
    for (const s of sessions.values()) end(s, 'proxy shutting down');
  }

  return { handle, onStubCall, stats, shutdown };
}

module.exports = { createSessions, DEFAULT_LIMITS, CONTINUE };
