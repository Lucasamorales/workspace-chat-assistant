/**
 * The Claude tool loop, with a hard human-approval gate.
 *
 * Read-only tool calls run immediately. If Claude asks for any call that needs approval,
 * the loop STOPS and returns its full state; nothing that changes data has run. Each such
 * call is split into approval items (a batch "create 3 tasks" becomes 3 items) so the user
 * can approve them one by one. The caller runs approved items as they are clicked and,
 * once every item is decided, calls resumeLoop() with the outcomes — possibly on another
 * instance, minutes later. That pause is why this is a manual loop, not the SDK tool runner.
 */

const MAX_RESULT_CHARS = 30_000;
const MAX_APPROVAL_ITEMS = 20;
const DECLINED = 'The user declined this action. It was not performed. Do not retry it unless they ask again.';

function textOf(content) {
  return content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

function clip(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}\n[truncated]` : s;
}

function resultBlock(id, result) {
  return {
    type: 'tool_result',
    tool_use_id: id,
    content: clip(result.content, MAX_RESULT_CHARS),
    ...(result.isError ? { is_error: true } : {}),
  };
}

async function runTool(toolset, call) {
  try {
    return await toolset.execute(call.name, call.input);
  } catch (e) {
    return { content: `Tool failed: ${String(e.message).slice(0, 300)}`, isError: true };
  }
}

/** Runs one approved item exactly as it was shown to the user. */
function executeApprovedItem(toolset, item) {
  return runTool(toolset, { name: item.name, input: item.input });
}

/** One tool_use can have several items; Claude gets a single combined result for it. */
function combineItems(items) {
  const outcome = it => (it.state === 'done' ? it.result || { content: '(no content)' } : { content: DECLINED, isError: true });
  if (items.length === 1) return outcome(items[0]);

  const lines = items.map((it, i) => `Part ${i + 1} of ${items.length} (${it.title}): ${
    it.state === 'done' ? outcome(it).content : 'declined by the user, not performed.'}`);
  const allFailed = items.every(it => it.state !== 'done' || (it.result && it.result.isError));
  return { content: lines.join('\n\n'), isError: allFailed };
}

async function drive({ claude, system, toolset, budget, maxSteps, log, onProgress, model, effort, maxTokens }, messages, stepsUsed) {
  let steps = stepsUsed;
  while (steps < maxSteps) {
    await budget.check();
    const res = await claude.create({ system, tools: toolset.definitions, messages, model, effort, maxTokens });
    steps += 1;
    await budget.record(res.usage || {}, res.model || model);
    messages.push({ role: 'assistant', content: res.content });

    if (res.stop_reason === 'pause_turn') continue;
    if (res.stop_reason !== 'tool_use') {
      // Running out of room mid-answer and running out of room mid-tool-call look the same from
      // here, but only one of them can be carried on: a half-written tool call is thrown away, so
      // asking again produces the same half-written call. Name the two apart.
      const cutOffMidCall = res.stop_reason === 'max_tokens'
        && res.content.some(b => b.type === 'tool_use');
      return {
        status: 'done',
        text: textOf(res.content),
        stopReason: cutOffMidCall ? 'max_tokens_tool' : res.stop_reason,
        messages,
      };
    }

    const uses = res.content.filter(b => b.type === 'tool_use');

    // A connect request ends the turn: the user connects, then the original request re-runs.
    const connect = toolset.connectionRequest && uses.map(u => toolset.connectionRequest(u.name)).find(Boolean);
    if (connect) return { status: 'needs_connection', ...connect, messages };

    if (onProgress) {
      try { await onProgress(uses.map(u => u.name)); } catch { /* progress is cosmetic */ }
    }

    const results = {};
    const items = [];
    for (const use of uses) {
      if (!(await toolset.needsApproval(use.name, use.input))) {
        results[use.id] = await runTool(toolset, use);
        continue;
      }
      const parts = await toolset.split(use.name, use.input);
      for (let i = 0; i < parts.length; i += 1) {
        const info = await toolset.describe(use.name, parts[i], { part: i, of: parts.length });
        items.push({ useId: use.id, name: use.name, input: parts[i], state: 'pending', ...info });
      }
    }

    if (items.length > MAX_APPROVAL_ITEMS) {
      // Too many to review sensibly on one card: refuse them all and let Claude explain.
      for (const id of new Set(items.map(it => it.useId))) {
        results[id] = { content: `Too many changes in one request (${items.length}, max ${MAX_APPROVAL_ITEMS}). Ask the user to split it into smaller requests.`, isError: true };
      }
    } else if (items.length) {
      log.info('tool calls awaiting approval', { tools: [...new Set(items.map(it => it.name))], items: items.length });
      return { status: 'needs_approval', items, saved: { messages, results, steps } };
    }
    messages.push({ role: 'user', content: uses.map(u => resultBlock(u.id, results[u.id])) });
  }
  return { status: 'done', text: '', stopReason: 'max_steps', messages };
}

function withDefaults(opts) {
  return { maxSteps: 12, log: { info() {}, warn() {}, error() {} }, ...opts };
}

function runLoop(opts) {
  return drive(withDefaults(opts), [...opts.messages], 0);
}

/**
 * @param opts.saved  the `saved` object returned with status 'needs_approval'
 * @param opts.items  the approval items with their final state: 'done' (with result) or 'declined'
 */
async function resumeLoop(opts) {
  const o = withDefaults(opts);
  const { messages, results, steps } = opts.saved;
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant') throw new Error('saved loop state is not awaiting tool results');

  const uses = last.content.filter(b => b.type === 'tool_use');
  const blocks = uses.map(use => {
    if (results[use.id]) return resultBlock(use.id, results[use.id]);
    const mine = opts.items.filter(it => it.useId === use.id);
    return resultBlock(use.id, mine.length ? combineItems(mine) : { content: DECLINED, isError: true });
  });
  return drive(o, [...messages, { role: 'user', content: blocks }], steps);
}

module.exports = { runLoop, resumeLoop, executeApprovedItem, combineItems, textOf, DECLINED, MAX_APPROVAL_ITEMS };
