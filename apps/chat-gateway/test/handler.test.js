const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const core = require('@buddy/core');
const { createEventHandler } = require('../src/handler');
const { createApp } = require('../src/app');
const { ACTIONS } = require('../src/cards');

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
    replaceText: async (name, space, thread, text) => { log.push({ op: 'replace', name, text }); },
    replaceWithCard: async (name, text, cardsV2) => { log.push({ op: 'card', name, text, cardsV2 }); },
    download: async () => Buffer.from(''),
  };
}

/** A stand-in module with a read tool and a batch "create" tool that splits per task. */
function tasksModule(executed) {
  return {
    name: 'tasks',
    allowedIn: ['DM'],
    commands: { tasks: { description: 'd', run: async () => 'tasks ok' } },
    tools: async () => ({
      definitions: [{ name: 'list', input_schema: { type: 'object' } }, { name: 'create', input_schema: { type: 'object' } }],
      needsApproval: name => name !== 'list',
      split: (name, input) => (input.tasks || [input]).map(t => ({ tasks: [t] })),
      describe: async (name, input) => ({ title: 'Create task', effect: 'create', fields: [{ label: 'Task title', value: input.tasks[0].name }] }),
      execute: async (name, input) => { executed.push({ name, input }); return { content: `${name} ok` }; },
    }),
  };
}

function setup(claudeScript) {
  const store = core.createMemoryStore();
  const chat = fakeChat();
  const executed = [];
  const background = [];
  const script = [...claudeScript];
  const claudeCalls = [];
  const registry = core.createRegistry({ modules: [require('@buddy/module-basics'), tasksModule(executed)], env: {}, log: quietLog });
  const handle = createEventHandler({
    registry, chat, store, log: quietLog,
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
  });
  const settle = async () => { while (background.length) await background.shift(); };
  return { handle, chat, executed, store, settle, claudeCalls };
}

const message = (user, space, text, id = Math.random().toString(36)) => ({
  type: 'MESSAGE', user, space, message: { name: `${space.name}/messages/${id}`, text, argumentText: text, thread: { name: `${space.name}/threads/t1` } },
});
const click = (user, fn, pendingId, item) => ({
  type: 'CARD_CLICKED', user, space: DM,
  common: { invokedFunction: fn, parameters: { pendingId, ...(item !== undefined ? { item: String(item) } : {}) } },
  message: { name: 'spaces/dm1/messages/card' },
});
const toolUse = (id, name, input = {}) => ({ type: 'tool_use', id, name, input });

const lastCard = chat => chat.log.filter(l => l.op === 'card').at(-1).cardsV2[0].card;
const buttons = card => card.sections.flatMap(s => s.widgets).filter(w => w.buttonList).flatMap(w => w.buttonList.buttons);
const pendingIdOf = card => buttons(card)[0].onClick.action.parameters.find(p => p.key === 'pendingId').value;

const CREATE_TWO = toolUse('w', 'tasks__create', { tasks: [{ name: 'Report' }, { name: 'Burn after reading' }] });

test('people not on the allowlist get nothing', async () => {
  const { handle, chat } = setup([]);
  const res = await handle(message({ name: 'users/999', email: 'stranger@gmail.com', type: 'HUMAN' }, DM, 'hi'));
  assert.match(res.text, /isn't enabled/);
  assert.equal(chat.log.length, 0);
});

test('a redelivered event is processed only once', async () => {
  const { handle, settle, chat } = setup([{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'hello!' }] }]);
  const ev = message(ROBIN, DM, 'hi', 'same');
  await handle(ev);
  await handle(ev);
  await settle();
  assert.equal(chat.log.filter(l => l.op === 'post').length, 1);
  assert.equal(chat.log.at(-1).text, 'hello!');
});

test('DM-only commands and tools are refused in spaces', async () => {
  const { handle, settle, store } = setup([{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'no tools here' }] }]);
  assert.match((await handle(message(ROBIN, SPACE, '/tasks'))).text, /only works in a direct message/);
  assert.match((await handle(message(ROBIN, SPACE, '/help'))).text, /Commands/);
  await handle(message(ROBIN, SPACE, 'delete everything'));
  await settle();
  assert.deepEqual(store.dump().core__pending || {}, {});
});

test('the card shows one section per task with its own buttons, plus approve/cancel all', async () => {
  const { handle, settle, chat, executed } = setup([{ stop_reason: 'tool_use', content: [CREATE_TWO] }]);
  await handle(message(ROBIN, DM, 'create two tasks'));
  await settle();

  assert.equal(executed.length, 0, 'nothing runs before a click');
  const card = lastCard(chat);
  assert.match(JSON.stringify(card.sections[0]), /Task title:<\/b> Report/);
  assert.match(JSON.stringify(card.sections[1]), /Burn after reading/);
  assert.deepEqual(buttons(card).map(b => b.text), ['Approve', 'Cancel', 'Approve', 'Cancel', 'Approve all', 'Cancel all']);
});

test('approve one, cancel the other: only the approved task is created, then Claude summarises', async () => {
  const { handle, settle, chat, executed, store, claudeCalls } = setup([
    { stop_reason: 'tool_use', content: [CREATE_TWO] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Created Report; skipped the other.' }] },
  ]);
  await handle(message(ROBIN, DM, 'create two tasks'));
  await settle();
  const id = pendingIdOf(lastCard(chat));

  const stolen = await handle(click(REMY, ACTIONS.APPROVE, id, 0));
  assert.match(stolen.text, /Only the person who asked/);

  const first = await handle(click(ROBIN, ACTIONS.APPROVE, id, 0));
  assert.equal(first.actionResponse.type, 'UPDATE_MESSAGE');
  assert.match(JSON.stringify(first.cardsV2), /Working on it/);
  await settle();
  assert.deepEqual(executed, [{ name: 'create', input: { tasks: [{ name: 'Report' }] } }]);
  assert.equal(claudeCalls.length, 1, 'Claude waits until every item is decided');

  const again = await handle(click(ROBIN, ACTIONS.APPROVE, id, 0));
  await settle();
  assert.equal(executed.length, 1, 'double click does not create twice');
  assert.equal(again.actionResponse.type, 'UPDATE_MESSAGE');

  await handle(click(ROBIN, ACTIONS.CANCEL, id, 1));
  await settle();
  assert.equal(executed.length, 1);
  assert.equal(chat.log.at(-1).text, 'Created Report; skipped the other.');
  const result = claudeCalls[1].messages.at(-1).content[0].content;
  assert.match(result, /Part 1 of 2.*create ok/s);
  assert.match(result, /Part 2 of 2.*declined/s);

  const replay = await handle(click(ROBIN, ACTIONS.APPROVE, id, 1));
  assert.match(replay.text, /expired or was already handled/);
  assert.deepEqual(store.dump().core__pending, {});
});

test('approve all creates every task exactly once', async () => {
  const { handle, settle, chat, executed } = setup([
    { stop_reason: 'tool_use', content: [CREATE_TWO] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Both created.' }] },
  ]);
  await handle(message(ROBIN, DM, 'create two tasks'));
  await settle();
  const id = pendingIdOf(lastCard(chat));

  await handle(click(ROBIN, ACTIONS.APPROVE_ALL, id));
  await handle(click(ROBIN, ACTIONS.APPROVE_ALL, id));
  await settle();
  assert.deepEqual(executed.map(e => e.input.tasks[0].name), ['Report', 'Burn after reading']);
  assert.equal(chat.log.at(-1).text, 'Both created.');
});

test('cancel all runs nothing and lets Claude acknowledge', async () => {
  const { handle, settle, chat, executed } = setup([
    { stop_reason: 'tool_use', content: [CREATE_TWO] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'OK, nothing created.' }] },
  ]);
  await handle(message(ROBIN, DM, 'create two tasks'));
  await settle();
  await handle(click(ROBIN, ACTIONS.CANCEL_ALL, pendingIdOf(lastCard(chat))));
  await settle();
  assert.equal(executed.length, 0);
  assert.equal(chat.log.at(-1).text, 'OK, nothing created.');
});

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
