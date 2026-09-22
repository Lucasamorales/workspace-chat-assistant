/**
 * Handles one verified Google Chat event. Returns the synchronous response body; slow
 * work (Claude, Asana) is handed to `defer` and reported back through the Chat API.
 */

const crypto = require('crypto');
const { runLoop, resumeLoop, executeApprovedItem, parseRule, Anthropic } = require('@buddy/core');
const {
  ACTIONS, approvalCard, connectCard, noticeCard, renderReply, simpleCard, updateMessage, newMessage,
} = require('./cards');
const { VOICE_GUIDE } = require('./voice');

const PENDING_TTL_MS = 15 * 60 * 1000;
// Saved original messages back "Try again" and "continue after connecting"; must outlive the 1 h connect link.
const REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
const EVENT_TTL_MS = 24 * 60 * 60 * 1000;
// Firestore documents max out at 1 MiB; leave room for per-item results added later.
const MAX_PENDING_BYTES = 500_000;
const MAX_ITEM_RESULT_CHARS = 10_000;
const MAX_REQUEST_TEXT_CHARS = 8_000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9_-]{20,64}$/;

const APPROVAL_ACTIONS = [ACTIONS.APPROVE, ACTIONS.CANCEL, ACTIONS.APPROVE_ALL, ACTIONS.CANCEL_ALL];

const BASE_PROMPT = VOICE_GUIDE;

const expose = message => Object.assign(new Error(message), { expose: true });
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const newId = () => crypto.randomBytes(24).toString('base64url');

function spaceKindOf(space = {}) {
  return space.spaceType === 'DIRECT_MESSAGE' || space.type === 'DM' || space.singleUserBotDm ? 'DM' : 'SPACE';
}

/** @mentions from Chat's own annotations; indexes refer to message.text. */
const mentionsOf = msg => (msg.annotations || [])
  .filter(a => a.type === 'USER_MENTION' && a.userMention && a.userMention.user && a.userMention.user.name)
  .map(a => ({
    userId: String(a.userMention.user.name),
    displayName: String(a.userMention.user.displayName || ''),
    type: String(a.userMention.user.type || 'HUMAN'),
    startIndex: Number(a.startIndex) || 0,
    length: Number(a.length) || 0,
  }))
  .sort((a, b) => a.startIndex - b.startIndex);

/** Chat attachment → the minimal metadata needed to download it again later. */
const attachmentMeta = att => ({
  name: att.contentName,
  contentType: att.contentType,
  source: att.source,
  resourceName: att.attachmentDataRef && att.attachmentDataRef.resourceName,
});

function createEventHandler(deps) {
  const {
    registry, chat, store, threads, usage, oauthFlows, claude,
    makeModuleContext, allowedUsers, log, defer, appName = 'Buddy', now = () => Date.now(),
    grants = null,
  } = deps;
  const events = store.collection('core__events');
  const pendingCol = store.collection('core__pending');
  const requests = store.collection('core__requests');
  // Who may talk to Buddy at all; each module then has its own BUDDY_ACCESS_<MODULE> rule.
  const allowed = parseRule(allowedUsers.join(','), 'BUDDY_ALLOWED_USERS');
  const privateOnly = `Ah, that one only works in a private chat with me, for privacy. Open a chat with ${appName} and ask me there.`;

  function isAllowed(user) {
    if (!user || user.type === 'BOT') return false;
    // Config first; then anyone an admin granted a module to, who would otherwise be told
    // Buddy is switched off for them and never reach the module they were given.
    return allowed({ email: user.email, id: user.name }) || Boolean(grants && grants.mayTalk(user));
  }

  function baseOf(event) {
    const msg = event.message || {};
    const thread = msg.thread && msg.thread.name;
    const tz = event.common && event.common.timeZone && event.common.timeZone.id;
    return {
      userId: String(event.user.name || '').split('/').pop(),
      userEmail: String(event.user.email || '').toLowerCase(),
      userDisplayName: String(event.user.displayName || ''),
      spaceKind: spaceKindOf(event.space),
      space: event.space && event.space.name,
      thread,
      threadKey: thread || msg.name || (event.space && event.space.name),
      timeZone: tz || null,
    };
  }

  const baseOfRecord = r => ({
    userId: r.userId, userEmail: r.userEmail, userDisplayName: r.userDisplayName || '', spaceKind: r.spaceKind,
    space: r.space, thread: r.thread, threadKey: r.threadKey, timeZone: r.timeZone || null,
  });

  /** Who is asking and where: decides which modules, commands and tools exist for them. */
  const scopeOf = base => ({
    kind: base.spaceKind,
    user: { email: base.userEmail, id: base.userId ? `users/${base.userId}` : '' },
  });

  const expired = record => new Date(record.expireAt).getTime() < now();

  function contextsFor(base) {
    return mod => makeModuleContext(mod, base, {
      listCommands: () => registry.listCommands(scopeOf(base)),
      moduleStatuses: () => registry.statuses(contextsFor(base), scopeOf(base)),
      examples: () => registry.examples(scopeOf(base)),
      quickActions: () => registry.quickActions(contextsFor(base), scopeOf(base)),
      usage: () => usage.forUser(base.userId).get(),
      resetThread: () => threads.reset(base.threadKey),
      startOAuth: () => startOAuth(base, mod.name),
    });
  }

  function startOAuth(base, moduleName) {
    const mod = registry.get(moduleName);
    if (!mod || !mod.oauth) throw new Error(`${moduleName} has no OAuth configuration`);
    if (base.spaceKind !== 'DM') throw expose(privateOnly);
    if (!base.userEmail) throw expose('Oh no, I couldn\'t read your Google account email, so I can\'t connect accounts right now.');
    return oauthFlows.createLink({ userId: base.userId, userEmail: base.userEmail, moduleName });
  }

  function systemFor(scope, notes, extra = []) {
    const where = scope.kind === 'DM'
      ? 'You are in a private direct message with the user.'
      : 'You are in a shared space: everyone in it can read your replies. Some features, like Asana, only work in a '
        + `private chat; if someone asks for them, tell them to open a private chat with ${appName}.`;
    return [
      { type: 'text', text: [BASE_PROMPT, where, ...registry.instructions(scope)].join('\n\n') },
      { type: 'text', text: [`Today is ${new Date(now()).toISOString().slice(0, 10)}.`, ...notes.map(n => `- ${n}`), ...extra].join('\n') },
    ];
  }

  // After an approval the card already shows every result, so Claude only adds what's new.
  const AFTER_APPROVAL = 'The user has just decided on the changes shown on the approval card, and that card already '
    + 'shows each result (done, skipped or failed). Do not repeat or list those results. Reply only with something new: '
    + 'a link, a next step, a problem, or the next part of the request. If there is nothing new, reply with one short '
    + 'line of at most six words.';

  /** Replace a placeholder message, or post a new one when there is none. Returns the message name. */
  async function showText(base, messageName, text) {
    if (messageName) {
      await chat.replaceText(messageName, base.space, base.thread, text);
      return messageName;
    }
    return chat.postText(base.space, base.thread, text);
  }

  async function showCard(base, messageName, card) {
    if (messageName) {
      await chat.replaceWithCard(messageName, card.text, card.cardsV2);
      return messageName;
    }
    return chat.postCard(base.space, base.thread, card.text, card.cardsV2);
  }

  /* ---------- saved requests (Try again / continue after connecting) ---------- */

  async function saveRequest(base, request) {
    const id = newId();
    await requests.set(id, {
      ...base,
      text: String(request.text || '').slice(0, MAX_REQUEST_TEXT_CHARS),
      attachments: request.attachments || [],
      expireAt: new Date(now() + REQUEST_TTL_MS),
    });
    return id;
  }

  /** Reads a saved request for a button click; returns {record} or {response} to send back. */
  async function claimRequest(requestId, base, { consume }) {
    if (!ID_PATTERN.test(requestId)) {
      return { response: updateMessage(noticeCard('This button\'s had its day', 'Just send your message again.')) };
    }
    const record = await requests.get(requestId);
    if (!record || expired(record)) {
      return { response: updateMessage(noticeCard('This one\'s expired', 'Nothing was changed. Just send your message again.')) };
    }
    if (record.userId !== base.userId) {
      log.warn('saved request clicked by a different user', { owner: record.userId, clicker: base.userId });
      return { response: newMessage({ text: 'Sorry, chap, only the person who asked can do this.' }) };
    }
    if (!consume) return { record };
    // Single use: a double click must not run the request twice.
    const taken = await requests.take(requestId);
    if (!taken) return { response: updateMessage(noticeCard('Already on it!', 'Sit tight, this one\'s being handled.')) };
    return { record: taken };
  }

  /* ---------- conversations ---------- */

  function userMessageFor(error, ref) {
    if (error.expose) return error.message;
    if (error instanceof Anthropic.RateLimitError || (error instanceof Anthropic.APIError && error.status === 529)) {
      return 'Oh no, I\'m a bit swamped right now. Give it a minute and try again?';
    }
    return `Oh no, something went wrong on my side. Give it another go? (ref ${ref})`;
  }

  async function fail(base, messageName, error, request) {
    const ref = crypto.randomBytes(3).toString('hex');
    if (!error.expose) log.error('request failed', { ref, userId: base.userId, error });
    const text = userMessageFor(error, ref);
    try {
      if (request && !error.expose) {
        const retryId = await saveRequest(base, request).catch(() => null);
        const card = noticeCard('That didn\'t quite work', text, retryId);
        if (messageName) await chat.replaceWithCard(messageName, card.text, card.cardsV2);
        else await chat.postCard(base.space, base.thread, card.text, card.cardsV2);
      } else if (messageName) {
        await chat.replaceText(messageName, base.space, base.thread, text);
      } else {
        await chat.postText(base.space, base.thread, text);
      }
    } catch (e) {
      log.error('could not report failure to chat', { ref, error: e });
    }
  }

  async function withToolset(base, fn) {
    const toolset = await registry.buildToolset(contextsFor(base), scopeOf(base));
    try {
      return await fn(toolset);
    } finally {
      await toolset.close();
    }
  }

  const historyTextOf = request => (request.attachments && request.attachments.length
    ? `${request.text}\n[attached: ${request.attachments.map(a => a.name).join(', ')}]`
    : request.text);

  async function finish(base, messageName, request, result) {
    if (result.status === 'needs_connection') {
      const requestId = await saveRequest(base, request);
      const url = await startOAuth(base, result.module);
      const card = connectCard({ label: result.label, reason: result.reason, url, requestId, module: result.module });
      await showCard(base, messageName, card);
      return;
    }

    if (result.status === 'needs_approval') {
      const loop = JSON.stringify(result.saved);
      if (Buffer.byteLength(loop) > MAX_PENDING_BYTES) {
        throw expose('That\'s a lot to check in one go! Try asking for fewer things at once.');
      }
      const requestId = await saveRequest(base, request);
      const id = newId();
      const expireAt = new Date(now() + PENDING_TTL_MS);
      await pendingCol.set(id, {
        ...base,
        historyText: historyTextOf(request),
        requestId,
        items: result.items,
        loop,
        cardMessage: messageName,
        resumed: false,
        expireAt,
      });
      const card = approvalCard(id, result.items, { expiresAt: expireAt, timeZone: base.timeZone, requestId });
      const shown = await showCard(base, messageName, card);
      if (shown !== messageName) {
        // No placeholder to replace (after an approval): remember the new card so clicks can update it.
        await pendingCol.update(id, doc => (doc ? { ...doc, cardMessage: shown } : undefined));
      }
      return;
    }

    let reply = result.text;
    if (result.stopReason === 'refusal') reply = 'Sorry, that\'s not one I can help with.';
    if (result.stopReason === 'max_tokens') reply += '\n\n_(Oops, I got cut off. Just ask me to carry on.)_';
    if (result.stopReason === 'max_steps') reply = `${reply ? `${reply}\n\n` : ''}_(That took a few too many steps. Try asking for one thing at a time?)_`;
    // A normal request always gets an answer; a follow-up after an approval may have nothing to add.
    if (!reply && !messageName) return;
    if (!reply) reply = '_(no reply)_';

    await threads.append(base.threadKey, request.historyText || historyTextOf(request), reply);
    await showText(base, messageName, reply);
  }

  async function postReply(base, reply) {
    const body = renderReply(reply);
    if (body.cardsV2) await chat.postCard(base.space, base.thread, body.text, body.cardsV2);
    else await chat.postText(base.space, base.thread, body.text);
  }

  /**
   * @param message  the original Chat message, for modules that handle messages directly.
   *                 Omitted for "Try again" / "continue", which always go to Claude.
   */
  async function converse(base, request, message) {
    let messageName;
    try {
      if (message) {
        const handled = await registry.handleMessage(contextsFor(base), message, scopeOf(base));
        if (handled) {
          await postReply(base, handled.reply);
          return;
        }
      }
      // Claude chat is a permission (the assistant module): without it, point to what they can use.
      if (!registry.canConverse(scopeOf(base))) {
        await postReply(base, await whatICanDo(base));
        return;
      }
      messageName = await chat.postText(base.space, base.thread, '_Hmm, give me a sec…_');
      const budget = usage.forUser(base.userId);
      await budget.check();

      const ctxFor = contextsFor(base);
      const blocks = [];
      for (const att of request.attachments || []) {
        blocks.push(...await registry.readAttachment(ctxFor, {
          name: att.name,
          contentType: att.contentType,
          source: att.source,
          download: maxBytes => {
            if (!att.resourceName) throw expose('this file can no longer be downloaded');
            return chat.download(att.resourceName, Math.min(maxBytes, MAX_FILE_BYTES));
          },
        }, scopeOf(base)));
      }
      blocks.push({ type: 'text', text: request.text || 'Please look at the attached file(s).' });
      const history = await threads.load(base.threadKey);

      await withToolset(base, async toolset => {
        let shown = '';
        const result = await runLoop({
          claude, toolset, budget, log,
          system: systemFor(scopeOf(base), toolset.notes),
          messages: [...history, { role: 'user', content: blocks }],
          onProgress: async names => {
            const labels = [...new Set(names.map(n => toolset.moduleOf(n)).filter(Boolean))].map(m => registry.label(m));
            const text = labels.length ? `_Having a look at your ${labels.join(' and ')}…_` : '';
            if (!text || text === shown) return;
            shown = text;
            await chat.replaceText(messageName, base.space, base.thread, text);
          },
        });
        await finish(base, messageName, request, result);
      });
    } catch (error) {
      await fail(base, messageName, error, request);
    }
  }

  /* ---------- approvals ---------- */

  async function refreshCard(id) {
    const record = await pendingCol.get(id);
    if (!record || record.resumed) return;
    const card = approvalCard(id, record.items, { expiresAt: new Date(record.expireAt), timeZone: record.timeZone, requestId: record.requestId });
    await chat.replaceWithCard(record.cardMessage, card.text, card.cardsV2);
  }

  /** Runs items that a click moved to 'running', saving each result as soon as it exists. */
  async function runApproved(id, record, indexes) {
    await withToolset(baseOfRecord(record), async toolset => {
      for (const i of indexes) {
        const r = await executeApprovedItem(toolset, record.items[i]);
        const result = { content: String(r.content ?? '').slice(0, MAX_ITEM_RESULT_CHARS), isError: Boolean(r.isError) };
        await pendingCol.update(id, doc => {
          if (!doc || !doc.items[i]) return undefined;
          doc.items[i].state = 'done';
          doc.items[i].result = result;
          return doc;
        });
      }
    });
  }

  /**
   * When nothing is pending or running, claim the record exactly once and let Claude
   * continue. With `expire`, anything still pending counts as declined.
   */
  async function finalizeIfDecided(id, { expire = false } = {}) {
    let claimed = null;
    await pendingCol.update(id, doc => {
      claimed = null; // transactions can retry; never trust a previous attempt
      if (!doc || doc.resumed) return undefined;
      if (expire) doc.items.forEach(it => { if (it.state === 'pending') it.state = 'declined'; });
      const open = doc.items.some(it => it.state === 'pending' || it.state === 'running');
      if (open) return expire ? doc : undefined;
      doc.resumed = true;
      claimed = doc;
      return doc;
    });
    if (!claimed) return;

    if (!expire) {
      const card = approvalCard(id, claimed.items);
      await chat.replaceWithCard(claimed.cardMessage, card.text, card.cardsV2).catch(error => log.warn('could not update approval card', { error }));
    }
    await pendingCol.delete(id);
    await resume(claimed, { cardId: expire ? null : id });
  }

  /**
   * Lets Claude continue after every change was decided. No "finishing up" message: the card
   * says so while Claude works, and switches to "Done" when it has finished.
   * @param opts.cardId  the approval card to mark as done afterwards (none when it expired)
   */
  async function resume(record, { cardId = null } = {}) {
    const base = baseOfRecord(record);
    try {
      await withToolset(base, async toolset => {
        const result = await resumeLoop({
          claude, toolset, log,
          budget: usage.forUser(base.userId),
          system: systemFor(scopeOf(base), toolset.notes, [AFTER_APPROVAL]),
          saved: JSON.parse(record.loop),
          items: record.items,
        });
        await finish(base, null, { text: record.historyText, historyText: record.historyText, attachments: [] }, result);
      });
    } catch (error) {
      await fail(base, null, error);
    } finally {
      if (cardId && record.cardMessage) {
        const card = approvalCard(cardId, record.items, { finished: true });
        await chat.replaceWithCard(record.cardMessage, card.text, card.cardsV2)
          .catch(error => log.warn('could not mark approval card as done', { error }));
      }
    }
  }

  async function onApprovalClick(fn, params, base) {
    const id = String(params.pendingId || '');
    const requestId = ID_PATTERN.test(String(params.requestId || '')) ? String(params.requestId) : null;
    const gone = retryId => updateMessage(noticeCard('This one\'s expired', 'Nothing was changed.', retryId));
    if (!ID_PATTERN.test(id)) return gone(null);

    const single = fn === ACTIONS.APPROVE || fn === ACTIONS.CANCEL;
    const index = Number(params.item);
    if (single && !(Number.isInteger(index) && index >= 0)) return gone(null);
    const approve = fn === ACTIONS.APPROVE || fn === ACTIONS.APPROVE_ALL;

    let outcome;
    const updated = await pendingCol.update(id, doc => {
      outcome = null; // transactions can retry; recompute every attempt
      if (!doc) { outcome = { kind: 'missing' }; return undefined; }
      if (doc.userId !== base.userId) { outcome = { kind: 'forbidden', owner: doc.userId }; return undefined; }
      if (expired(doc)) { outcome = { kind: 'expired', doc }; return undefined; }

      const targets = single ? [index] : doc.items.map((_, i) => i);
      const changed = targets.filter(i => doc.items[i] && doc.items[i].state === 'pending');
      if (!changed.length) { outcome = { kind: 'noop', doc }; return undefined; }

      for (const i of changed) doc.items[i].state = approve ? 'running' : 'declined';
      outcome = { kind: 'changed', changed };
      return doc;
    });

    switch (outcome.kind) {
      case 'missing':
        return gone(requestId);
      case 'forbidden':
        log.warn('approval attempted by a different user', { owner: outcome.owner, clicker: base.userId });
        return newMessage({ text: 'Sorry, chap, only the person who asked can approve this.' });
      case 'expired': {
        defer(finalizeIfDecided(id, { expire: true }));
        // Re-running the whole request after some changes were applied could duplicate them.
        const partlyApplied = outcome.doc.items.some(it => it.state !== 'pending');
        return partlyApplied
          ? updateMessage(noticeCard('This one\'s expired', 'Anything you didn\'t approve was left alone.'))
          : gone(requestId);
      }
      case 'noop':
        return updateMessage(approvalCard(id, outcome.doc.items, {
          expiresAt: new Date(outcome.doc.expireAt), timeZone: outcome.doc.timeZone, requestId: outcome.doc.requestId,
        }));
      default:
        break;
    }

    log.info(approve ? 'approval items approved' : 'approval items declined', {
      userId: base.userId, tools: outcome.changed.map(i => updated.items[i].name),
    });

    defer((async () => {
      try {
        if (approve) {
          await runApproved(id, updated, outcome.changed);
          await refreshCard(id);
        }
        await finalizeIfDecided(id);
      } catch (error) {
        await fail(baseOfRecord(updated), null, error);
      }
    })());

    return updateMessage(approvalCard(id, updated.items, { expiresAt: new Date(updated.expireAt), timeZone: updated.timeZone, requestId: updated.requestId }));
  }

  async function onContinueClick(params, base) {
    const moduleName = String(params.module || '');
    const mod = registry.get(moduleName);
    if (!mod || !mod.oauth) return updateMessage(noticeCard('This button no longer works', 'Just send your message again.'));
    const label = registry.label(moduleName);

    const { record, response } = await claimRequest(String(params.requestId || ''), base, { consume: false });
    if (response) return response;
    const requestBase = baseOfRecord(record);

    if (!(await registry.isConnected(contextsFor(requestBase), moduleName, scopeOf(requestBase)))) {
      const url = await startOAuth(requestBase, moduleName);
      return updateMessage(connectCard({
        label, reason: 'not_connected', url, requestId: String(params.requestId), module: moduleName,
        note: `Hmm, I can't see your ${label} connection yet. Click "Connect ${label}", approve it in ${label}, then click continue again.`,
      }));
    }

    const claimed = await claimRequest(String(params.requestId), base, { consume: true });
    if (claimed.response) return claimed.response;
    defer(converse(baseOfRecord(claimed.record), { text: claimed.record.text, attachments: claimed.record.attachments }));
    return updateMessage(simpleCard('connect', { title: `Yessss, ${label}'s connected!`, text: 'On it, working on your request…', image: 'talking' }));
  }

  async function onRetryClick(params, base) {
    const { record, response } = await claimRequest(String(params.requestId || ''), base, { consume: true });
    if (response) return response;
    defer(converse(baseOfRecord(record), { text: record.text, attachments: record.attachments }));
    return updateMessage(simpleCard('notice', { title: 'Sure thing, trying again…', image: 'thinking' }));
  }

  async function onCardClicked(event) {
    const common = event.common || {};
    const action = event.action || {};
    const fn = common.invokedFunction || action.actionMethodName;
    const params = common.parameters || Object.fromEntries((action.parameters || []).map(p => [p.key, p.value]));
    const base = baseOf(event);

    if (APPROVAL_ACTIONS.includes(fn)) return onApprovalClick(fn, params, base);
    if (fn === ACTIONS.CONTINUE) return onContinueClick(params, base);
    if (fn === ACTIONS.RETRY) return onRetryClick(params, base);
    if (fn === ACTIONS.COMMAND) {
      // Same as typing the command: it runs with the clicker's own identity and permissions.
      const body = renderReply(await runCommand(base, String(params.command || ''), String(params.args || '')));
      return params.replace === '1' ? updateMessage(body) : newMessage(body);
    }
    return {};
  }

  /* ---------- messages ---------- */

  /** @param message  the typed message, so commands can read mentions; absent for button clicks */
  async function runCommand(base, name, args, message) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) return 'Not sure what that is! Send /help to see what I can do.';
    // Commands someone may not use look exactly like unknown ones.
    const found = registry.findCommand(name, scopeOf(base));
    if (!found) return `Hmm, I don't know /${name}. Send /help to see what I can do.`;
    if (!found.placeAllowed) return privateOnly;
    const ctx = { ...contextsFor(base)(found.module), commandName: name, ...(message ? { message } : {}) };
    const r = await registry.runCommand(found, ctx, args);
    if (r.ok) return r.value || 'Done.';
    return r.error.expose ? r.error.message : `Oh no, /${name} didn't work. Give it another go?`;
  }

  async function onMessage(event) {
    const msg = event.message || {};
    if (!msg.name) return {};
    // Chat can redeliver an event; never act on the same message twice.
    const firstTime = await events.create(hash(msg.name), { expireAt: new Date(now() + EVENT_TTL_MS) });
    if (!firstTime) {
      log.info('duplicate message ignored');
      return {};
    }

    const base = baseOf(event);
    const raw = base.spaceKind === 'SPACE' && msg.argumentText !== undefined ? msg.argumentText : msg.text;
    const text = String(raw || '').trim();

    const chatMessage = {
      text: String(msg.text || ''),
      argumentText: String(msg.argumentText !== undefined ? msg.argumentText : msg.text || ''),
      mentions: mentionsOf(msg),
      space: { name: base.space, displayName: String(event.space.displayName || ''), kind: base.spaceKind },
      sender: { userId: String(event.user.name || ''), email: base.userEmail, displayName: base.userDisplayName },
    };

    const command = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/i.exec(text);
    if (command) return renderReply(await runCommand(base, command[1].toLowerCase(), (command[2] || '').trim(), chatMessage));

    defer(converse(base, { text, attachments: (msg.attachment || []).map(attachmentMeta) }, chatMessage));
    return {};
  }

  /** Free reply for people who can't chat with Claude: only what's actually available to them. */
  async function whatICanDo(base) {
    const scope = scopeOf(base);
    const examples = registry.examples(scope);
    const actions = await registry.quickActions(contextsFor(base), scope);
    const help = registry.findCommand('help', scope) ? [{ text: 'What can you do?', command: 'help' }] : [];
    return {
      title: 'Here\'s what I can help you with',
      text: examples.length ? examples.map(e => `• ${e}`).join('\n') : 'Nothing for me to help with here just yet.',
      buttons: [...actions, ...help],
    };
  }

  async function onAddedToSpace(event) {
    const base = baseOf(event);
    const scope = scopeOf(base);
    if (base.spaceKind !== 'DM') {
      return {
        text: registry.canConverse(scope)
          ? `Hey all, I'm ${appName}! Mention me when you need a hand. Some things, like Asana, only work in a private chat with me.`
          : `Hey all, I'm ${appName}! Mention me when you need a hand.`,
      };
    }
    const actions = await registry.quickActions(contextsFor(base), scope);
    return renderReply({
      title: `Hey, I'm ${appName}!`,
      image: 'talking',
      text: registry.canConverse(scope)
        ? 'Ask me anything, throw a file my way, or let me wrangle your work tools.'
        : 'Here\'s what I can help you with.',
      buttons: [{ text: 'What can you do?', command: 'help' }, ...actions],
    });
  }

  return async function handleEvent(event) {
    if (!event || !event.type || !event.space || !event.user) return {};
    // One cached read, so a permission changed in chat takes effect in seconds, not at the
    // next deploy. A failure here must never deny access that configuration already allows.
    if (grants) await grants.refresh().catch(error => log.warn('could not refresh grants', { error }));
    if (!isAllowed(event.user)) {
      log.warn('user not on the allowlist', { user: event.user.name, type: event.type });
      return ['MESSAGE', 'ADDED_TO_SPACE'].includes(event.type) ? { text: `Sorry, ${appName} isn't switched on for you just yet.` } : {};
    }

    switch (event.type) {
      case 'ADDED_TO_SPACE':
        return onAddedToSpace(event);
      case 'MESSAGE':
        return onMessage(event);
      case 'CARD_CLICKED':
        return onCardClicked(event);
      default:
        return {};
    }
  };
}

module.exports = { createEventHandler, spaceKindOf };
