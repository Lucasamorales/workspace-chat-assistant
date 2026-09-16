const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const core = require('@buddy/core');
const { createEventHandler } = require('../src/handler');
const { createApp } = require('../src/app');

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

/** A stand-in "tasks" module with one read tool and one delete tool. */
function tasksModule(executed) {
  return {
    name: 'tasks',
    allowedIn: ['DM'],
    commands: { tasks: { description: 'd', run: async () => 'tasks ok' } },
    tools: async () => ({
      definitions: [{ name: 'list', input_schema: { type: 'object' } }, { name: 'delete', input_schema: { type: 'object' } }],
      needsApproval: name => name !== 'list',
      describe: name => ({ title: name === 'delete' ? 'Delete task' : 'List tasks', destructive: name === 'delete' }),
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
  const registry = core.createRegistry({ modules: [require('@buddy/module-basics'), tasksModule(executed)], env: {}, log: quietLog });
  const handle = createEventHandler({
    registry, chat, store, log: quietLog,
    allowedUsers: ['robin@example.com', 'remy@example.com'],
    threads: core.createThreads({ store, maxMessages: 20, ttlDays: 30 }),
    usage: core.createUsage({ store, capUsd: 15, prices: { inPerMTok: 2, outPerMTok: 10 } }),
    oauthFlows: core.createOAuthFlows({ store, secret: 'k'.repeat(40), baseUrl: 'https://oauth.test' }),
    claude: { create: async () => { const r = script.shift(); if (!r) throw new Error('no more scripted replies'); return { usage: {}, ...r }; } },
    makeModuleContext: core.createContextFactory({ store, sealer: core.createLocalSealer(), env: {}, log: quietLog }),
    defer: p => background.push(p),
  });
  const settle = async () => { while (background.length) await background.shift(); };
  return { handle, chat, executed, store, settle };
}

const message = (user, space, text, id = Math.random().toString(36)) => ({
  type: 'MESSAGE', user, space, message: { name: `${space.name}/messages/${id}`, text, argumentText: text, thread: { name: `${space.name}/threads/t1` } },
});
const click = (user, fn, pendingId) => ({
  type: 'CARD_CLICKED', user, space: DM, common: { invokedFunction: fn, parameters: { pendingId } }, message: { name: 'spaces/dm1/messages/card' },
});
const toolUse = (id, name, input = {}) => ({ type: 'tool_use', id, name, input });

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

test('full approval flow: pause → card → wrong user refused → approve once → replay refused', async () => {
  const { handle, settle, chat, executed, store } = setup([
    { stop_reason: 'tool_use', content: [toolUse('a', 'tasks__list'), toolUse('b', 'tasks__delete', { id: 7 })] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Deleted task 7.' }] },
  ]);

  await handle(message(ROBIN, DM, 'delete task 7'));
  await settle();
  assert.deepEqual(executed.map(e => e.name), ['list'], 'delete must wait for approval');

  const card = chat.log.find(l => l.op === 'card');
  assert.ok(card, 'approval card shown');
  const pendingId = card.cardsV2[0].card.sections[0].widgets.at(-1).buttonList.buttons[0].onClick.action.parameters[0].value;

  const stolen = await handle(click(REMY, 'buddy.approve', pendingId));
  assert.match(stolen.text, /Only the person who asked/);
  assert.deepEqual(executed.map(e => e.name), ['list']);

  const ok = await handle(click(ROBIN, 'buddy.approve', pendingId));
  assert.equal(ok.actionResponse.type, 'UPDATE_MESSAGE');
  await settle();
  assert.deepEqual(executed, [{ name: 'list', input: {} }, { name: 'delete', input: { id: 7 } }]);
  assert.equal(chat.log.at(-1).text, 'Deleted task 7.');

  const replay = await handle(click(ROBIN, 'buddy.approve', pendingId));
  assert.match(replay.text, /expired or was already handled/);
  await settle();
  assert.equal(executed.filter(e => e.name === 'delete').length, 1, 'delete ran exactly once');
  assert.deepEqual(store.dump().core__pending, {});
});

test('cancel runs nothing and lets Claude acknowledge', async () => {
  const { handle, settle, chat, executed } = setup([
    { stop_reason: 'tool_use', content: [toolUse('b', 'tasks__delete', { id: 7 })] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'OK, I left it.' }] },
  ]);
  await handle(message(ROBIN, DM, 'delete task 7'));
  await settle();
  const card = chat.log.find(l => l.op === 'card');
  const pendingId = card.cardsV2[0].card.sections[0].widgets.at(-1).buttonList.buttons[1].onClick.action.parameters[0].value;
  await handle(click(ROBIN, 'buddy.cancel', pendingId));
  await settle();
  assert.equal(executed.length, 0);
  assert.equal(chat.log.at(-1).text, 'OK, I left it.');
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
