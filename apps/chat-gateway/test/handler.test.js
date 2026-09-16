const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const core = require('@buddy/core');
const { createEventHandler } = require('../src/handler');
const { createApp } = require('../src/app');
const { ACTIONS, clockTime } = require('../src/cards');

const quietLog = { info() {}, warn() {}, error() {}, child() { return quietLog; } };
const ROBIN = { name: 'users/111', email: 'robin@example.com', type: 'HUMAN' };
const REMY = { name: 'users/222', email: 'remy@example.com', type: 'HUMAN' };
const DM = { name: 'spaces/dm1', spaceType: 'DIRECT_MESSAGE' };
const SPACE = { name: 'spaces/team', spaceType: 'SPACE' };

function fakeChat() {
  const log = [];
  let n = 0;
  return {
    log,
    postText: async (space, thread, text) => { log.push({ op: 'post', text }); return `${space}/messages/${++n}`; },
    postCard: async (space, thread, text, cardsV2) => { log.push({ op: 'card', text, cardsV2 }); return `${space}/messages/${++n}`; },
    replaceText: async (name, space, thread, text) => { log.push({ op: 'replace', name, text }); },
    replaceWithCard: async (name, text, cardsV2) => { log.push({ op: 'card', name, text, cardsV2 }); },
    download: async () => Buffer.from(''),
  };
}

/**
 * A stand-in OAuth module: a read tool and a batch "create" tool that splits per task.
 * `state.connected` controls whether it offers tools or asks the user to connect.
 */
function tasksModule(executed, state) {
  return {
    name: 'tasks',
    allowedIn: ['DM'],
    commands: {
      tasks: {
        description: 'd',
        run: async (ctx, args) => (args === 'card'
          ? { title: 'Tasks', text: 'Pick one', buttons: [{ text: 'Status', command: 'tasks', args: 'status', replace: true }] }
          : `tasks ${args || 'ok'}`),
      },
    },
    oauth: {
      label: 'Tasks', authorizeUrl: 'https://vendor.test/authorize', tokenUrl: 'https://vendor.test/token',
      clientIdSetting: 'TASKS_ID', clientSecretSetting: 'TASKS_SECRET', saveTokens: async () => {},
    },
    connected: async () => state.connected,
    quickActions: async ctx => (state.connected ? [] : [{ text: 'Connect Tasks', url: await ctx.core.startOAuth() }]),
    tools: async () => (!state.connected ? { connect: { reason: state.reason || 'not_connected' } } : {
      definitions: [{ name: 'list', input_schema: { type: 'object' } }, { name: 'create', input_schema: { type: 'object' } }],
      needsApproval: name => name !== 'list',
      split: (name, input) => (input.tasks || [input]).map(t => ({ tasks: [t] })),
      describe: async (name, input) => ({ title: 'Create task', effect: 'create', fields: [{ label: 'Task title', value: input.tasks[0].name }] }),
      execute: async (name, input) => { executed.push({ name, input }); return { content: `${name} ok` }; },
    }),
  };
}

function setup(claudeScript, { connected = true, reason, now } = {}) {
  const store = core.createMemoryStore();
  const chat = fakeChat();
  const executed = [];
  const background = [];
  const script = [...claudeScript];
  const claudeCalls = [];
  const state = { connected, reason };
  const registry = core.createRegistry({ modules: [require('@buddy/module-basics'), tasksModule(executed, state)], env: {}, log: quietLog });
  const handle = createEventHandler({
    registry, chat, store, log: quietLog, appName: 'Buddy-Asana',
    allowedUsers: ['robin@example.com', 'remy@example.com'],
    threads: core.createThreads({ store, maxMessages: 20, ttlDays: 30 }),
    usage: core.createUsage({ store, capUsd: 15, prices: { inPerMTok: 2, outPerMTok: 10 } }),
    oauthFlows: core.createOAuthFlows({ store, secret: 'k'.repeat(40), baseUrl: 'https://oauth.test' }),
    claude: {
      create: async params => {
        claudeCalls.push(structuredClone(params));
        const r = script.shift();
        if (!r) throw new Error('no more scripted replies');
        return { usage: {}, ...r };
      },
    },
    makeModuleContext: core.createContextFactory({ store, sealer: core.createLocalSealer(), env: {}, log: quietLog }),
    defer: p => background.push(p),
    ...(now ? { now } : {}),
  });
  const settle = async () => { while (background.length) await background.shift(); };
  return { handle, chat, executed, store, settle, claudeCalls, state };
}

const message = (user, space, text, id = Math.random().toString(36)) => ({
  type: 'MESSAGE', user, space, common: { timeZone: { id: 'America/Argentina/Buenos_Aires' } },
  message: { name: `${space.name}/messages/${id}`, text, argumentText: text, thread: { name: `${space.name}/threads/t1` } },
});
const click = (user, fn, parameters) => ({
  type: 'CARD_CLICKED', user, space: DM,
  common: { invokedFunction: fn, parameters: Object.fromEntries(Object.entries(parameters).map(([k, v]) => [k, String(v)])) },
  message: { name: 'spaces/dm1/messages/card' },
});
const toolUse = (id, name, input = {}) => ({ type: 'tool_use', id, name, input });
const textReply = text => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });

const lastCard = chat => chat.log.filter(l => l.op === 'card').at(-1).cardsV2[0].card;
const buttonsOf = card => card.sections.flatMap(s => s.widgets).filter(w => w.buttonList).flatMap(w => w.buttonList.buttons);
const param = (button, key) => button.onClick.action.parameters.find(p => p.key === key).value;
const cardText = card => JSON.stringify(card);

const CREATE_TWO = toolUse('w', 'tasks__create', { tasks: [{ name: 'Report' }, { name: 'Burn after reading' }] });

/* ---------- access and basics ---------- */

test('people not on the allowlist get nothing', async () => {
  const { handle, chat } = setup([]);
  const res = await handle(message({ name: 'users/999', email: 'stranger@gmail.com', type: 'HUMAN' }, DM, 'hi'));
  assert.match(res.text, /isn't enabled/);
  assert.equal(chat.log.length, 0);
});

test('a redelivered event is processed only once', async () => {
  const { handle, settle, chat } = setup([textReply('hello!')]);
  const ev = message(ROBIN, DM, 'hi', 'same');
  await handle(ev);
  await handle(ev);
  await settle();
  assert.equal(chat.log.filter(l => l.op === 'post').length, 1);
  assert.equal(chat.log.at(-1).text, 'hello!');
});

test('DM-only commands are refused in spaces with a friendly pointer to a private chat', async () => {
  const { handle, settle, store } = setup([textReply('no tools here')]);
  assert.match((await handle(message(ROBIN, SPACE, '/tasks'))).text, /private chat with me\. Open a chat with Buddy-Asana/);
  await handle(message(ROBIN, SPACE, 'delete everything'));
  await settle();
  assert.deepEqual(store.dump().core__pending || {}, {});
});

test('welcome in a DM is a card with buttons, not instructions to type commands', async () => {
  const { handle } = setup([], { connected: false });
  const res = await handle({ type: 'ADDED_TO_SPACE', user: ROBIN, space: DM });
  const card = res.cardsV2[0].card;
  assert.equal(card.header.title, 'Hi, I\'m Buddy-Asana 👋');
  const [help, connect] = buttonsOf(card);
  assert.equal(param(help, 'command'), 'help');
  assert.match(connect.onClick.openLink.url, /^https:\/\/oauth\.test\/auth\/tasks\/start\?s=/);
});

test('command buttons run the command as the clicker and can update the card in place', async () => {
  const { handle } = setup([]);
  const res = await handle(message(ROBIN, DM, '/tasks card'));
  const [status] = buttonsOf(res.cardsV2[0].card);
  const clicked = await handle(click(ROBIN, ACTIONS.COMMAND, { command: param(status, 'command'), args: param(status, 'args'), replace: param(status, 'replace') }));
  assert.equal(clicked.actionResponse.type, 'UPDATE_MESSAGE');
  assert.equal(clicked.text, 'tasks status');

  const inSpace = await handle({ ...click(ROBIN, ACTIONS.COMMAND, { command: 'tasks', args: '', replace: '0' }), space: SPACE });
  assert.match(inSpace.text, /private chat/, 'a button cannot bypass where a command is allowed');
});

/* ---------- connecting ---------- */

test('first request needing a service shows a Connect card; continue re-runs the original message', async () => {
  const { handle, settle, chat, state, claudeCalls } = setup([
    { stop_reason: 'tool_use', content: [toolUse('c', 'tasks__connect_account')] },
    textReply('You have 3 tasks due today.'),
  ], { connected: false });

  await handle(message(ROBIN, DM, 'check my tasks for today'));
  await settle();
  assert.ok(claudeCalls[0].tools.some(t => t.name === 'tasks__connect_account'));

  const card = lastCard(chat);
  assert.equal(card.header.title, 'Connect your Tasks first');
  const [connect, cont] = buttonsOf(card);
  assert.match(connect.onClick.openLink.url, /^https:\/\/oauth\.test\/auth\/tasks\/start\?s=/);
  const requestId = param(cont, 'requestId');

  // Clicking continue before connecting: same card, fresh link, a hint.
  const early = await handle(click(ROBIN, ACTIONS.CONTINUE, { requestId, module: 'tasks' }));
  assert.match(cardText(early.cardsV2), /can't see your Tasks connection yet/);

  const stolen = await handle(click(REMY, ACTIONS.CONTINUE, { requestId, module: 'tasks' }));
  assert.match(stolen.text, /Only the person who asked/);

  state.connected = true;
  const ok = await handle(click(ROBIN, ACTIONS.CONTINUE, { requestId, module: 'tasks' }));
  assert.match(ok.cardsV2[0].card.header.title, /Tasks connected/);
  const again = await handle(click(ROBIN, ACTIONS.CONTINUE, { requestId, module: 'tasks' }));
  await settle();

  assert.match(cardText(again.cardsV2), /expired|already/);
  assert.equal(claudeCalls.length, 2, 'the original request ran exactly once more');
  assert.deepEqual(claudeCalls[1].messages.at(-1).content.at(-1), { type: 'text', text: 'check my tasks for today' });
  assert.equal(chat.log.at(-1).text, 'You have 3 tasks due today.');
});

test('a connection that stopped working gets Reconnect wording', async () => {
  const { handle, settle, chat } = setup([
    { stop_reason: 'tool_use', content: [toolUse('c', 'tasks__connect_account')] },
  ], { connected: false, reason: 'expired' });
  await handle(message(ROBIN, DM, 'check my tasks'));
  await settle();
  assert.equal(lastCard(chat).header.title, 'Reconnect your Tasks');
  assert.match(cardText(lastCard(chat)), /stopped working/);
});

/* ---------- errors ---------- */

test('an unexpected error offers Try again, which re-runs the message once', async () => {
  const { handle, settle, chat, claudeCalls } = setup([]); // no scripted reply → Claude call throws
  await handle(message(ROBIN, DM, 'hello'));
  await settle();
  const card = lastCard(chat);
  assert.equal(card.header.title, 'That didn\'t work');
  const requestId = param(buttonsOf(card)[0], 'requestId');

  assert.match((await handle(click(REMY, ACTIONS.RETRY, { requestId }))).text, /Only the person who asked/);
  await handle(click(ROBIN, ACTIONS.RETRY, { requestId }));
  await handle(click(ROBIN, ACTIONS.RETRY, { requestId }));
  await settle();
  assert.equal(claudeCalls.length, 2, 'original + exactly one retry');
});

/* ---------- approvals ---------- */

test('approval card: plain-language header, one section per task, expiry time in the user\'s time zone', async () => {
  const { handle, settle, chat, executed } = setup([{ stop_reason: 'tool_use', content: [CREATE_TWO] }]);
  await handle(message(ROBIN, DM, 'create two tasks'));
  await settle();

  assert.equal(executed.length, 0, 'nothing runs before a click');
  const card = lastCard(chat);
  assert.equal(card.header.title, 'Review before Buddy makes changes');
  assert.match(cardText(card), /Nothing will change until you click <b>Approve<\/b>/);
  assert.match(cardText(card.sections[1]), /Task title:<\/b> Report/);
  assert.match(cardText(card.sections[2]), /Burn after reading/);
  assert.deepEqual(buttonsOf(card).map(b => b.text), ['Approve', 'Cancel', 'Approve', 'Cancel', 'Approve all', 'Cancel all']);
  assert.match(cardText(card), /expires at \d\d:\d\d \(15 minutes\)\. After that, just send your message again/);
});

test('approve one, cancel the other: only the approved task is created, then Claude summarises', async () => {
  const { handle, settle, chat, executed, store, claudeCalls } = setup([
    { stop_reason: 'tool_use', content: [CREATE_TWO] },
    textReply('Created Report; skipped the other.'),
  ]);
  await handle(message(ROBIN, DM, 'create two tasks'));
  await settle();
  const first = buttonsOf(lastCard(chat))[0];
  const ids = { pendingId: param(first, 'pendingId'), requestId: param(first, 'requestId') };

  assert.match((await handle(click(REMY, ACTIONS.APPROVE, { ...ids, item: 0 }))).text, /Only the person who asked/);

  const approved = await handle(click(ROBIN, ACTIONS.APPROVE, { ...ids, item: 0 }));
  assert.equal(approved.actionResponse.type, 'UPDATE_MESSAGE');
  assert.match(cardText(approved.cardsV2), /Working on it/);
  await settle();
  assert.deepEqual(executed, [{ name: 'create', input: { tasks: [{ name: 'Report' }] } }]);
  assert.equal(claudeCalls.length, 1, 'Claude waits until every item is decided');

  await handle(click(ROBIN, ACTIONS.APPROVE, { ...ids, item: 0 }));
  await settle();
  assert.equal(executed.length, 1, 'double click does not create twice');

  await handle(click(ROBIN, ACTIONS.CANCEL, { ...ids, item: 1 }));
  await settle();
  assert.equal(executed.length, 1);
  assert.equal(chat.log.at(-1).text, 'Created Report; skipped the other.');
  const result = claudeCalls[1].messages.at(-1).content[0].content;
  assert.match(result, /Part 1 of 2.*create ok/s);
  assert.match(result, /Part 2 of 2.*declined/s);

  const stale = await handle(click(ROBIN, ACTIONS.APPROVE, { ...ids, item: 1 }));
  assert.equal(stale.text, 'This request expired');
  assert.deepEqual(store.dump().core__pending, {});
});

test('approve all creates every task exactly once; cancel all creates nothing', async () => {
  const a = setup([{ stop_reason: 'tool_use', content: [CREATE_TWO] }, textReply('Both created.')]);
  await a.handle(message(ROBIN, DM, 'create two tasks'));
  await a.settle();
  const idsA = { pendingId: param(buttonsOf(lastCard(a.chat))[0], 'pendingId') };
  await a.handle(click(ROBIN, ACTIONS.APPROVE_ALL, idsA));
  await a.handle(click(ROBIN, ACTIONS.APPROVE_ALL, idsA));
  await a.settle();
  assert.deepEqual(a.executed.map(e => e.input.tasks[0].name), ['Report', 'Burn after reading']);
  assert.equal(a.chat.log.at(-1).text, 'Both created.');

  const b = setup([{ stop_reason: 'tool_use', content: [CREATE_TWO] }, textReply('OK, nothing created.')]);
  await b.handle(message(ROBIN, DM, 'create two tasks'));
  await b.settle();
  await b.handle(click(ROBIN, ACTIONS.CANCEL_ALL, { pendingId: param(buttonsOf(lastCard(b.chat))[0], 'pendingId') }));
  await b.settle();
  assert.equal(b.executed.length, 0);
  assert.equal(b.chat.log.at(-1).text, 'OK, nothing created.');
});

test('an expired approval offers Try again only if nothing was applied yet', async () => {
  let clock = Date.parse('2026-09-16T12:00:00Z');
  const { handle, settle, chat, executed, claudeCalls } = setup([
    { stop_reason: 'tool_use', content: [CREATE_TWO] },
    textReply('Nothing was created.'),
    { stop_reason: 'tool_use', content: [CREATE_TWO] },
  ], { now: () => clock });
  await handle(message(ROBIN, DM, 'create two tasks'));
  await settle();
  const first = buttonsOf(lastCard(chat))[0];

  clock += 16 * 60 * 1000;
  const res = await handle(click(ROBIN, ACTIONS.APPROVE, { pendingId: param(first, 'pendingId'), requestId: param(first, 'requestId'), item: 0 }));
  assert.equal(res.text, 'This request expired');
  const [tryAgain] = buttonsOf(res.cardsV2[0].card);
  assert.equal(tryAgain.text, 'Try again');
  await settle();
  assert.equal(executed.length, 0);

  await handle(click(ROBIN, ACTIONS.RETRY, { requestId: param(tryAgain, 'requestId') }));
  await settle();
  assert.equal(claudeCalls.length, 3, 'expired request summarised, then re-run from Try again');
  assert.equal(claudeCalls[2].messages.at(-1).content.at(-1).text, 'create two tasks');
});

test('expiry time uses the user\'s time zone', () => {
  const at = new Date('2026-09-16T17:32:00Z');
  assert.equal(clockTime(at, 'America/Argentina/Buenos_Aires'), '14:32');
  assert.equal(clockTime(at, 'Europe/London'), '18:32');
  assert.equal(clockTime(at, null), '17:32 UTC');
});

test('progress message names the service being checked', async () => {
  const { handle, settle, chat } = setup([
    { stop_reason: 'tool_use', content: [toolUse('r', 'tasks__list')] },
    textReply('Here you go.'),
  ]);
  await handle(message(ROBIN, DM, 'what is due?'));
  await settle();
  assert.ok(chat.log.some(l => l.op === 'replace' && l.text === '_Checking your Tasks…_'));
  assert.equal(chat.log.at(-1).text, 'Here you go.');
});

/* ---------- HTTP ---------- */

test('HTTP layer rejects requests that are not signed by Google Chat', async () => {
  const app = createApp({
    verifyChat: async header => { if (header !== 'Bearer good') throw new Error('bad'); },
    handleEvent: async () => ({ text: 'hi' }),
    log: quietLog,
  });
  const server = http.createServer(app).listen(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    const post = headers => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });
    assert.equal((await post({})).status, 401);
    assert.equal((await post({ authorization: 'Bearer forged' })).status, 401);
    const ok = await post({ authorization: 'Bearer good' });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('x-powered-by'), null);
  } finally {
    server.close();
  }
});
