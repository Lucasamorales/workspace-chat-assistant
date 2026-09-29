const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const core = require('@buddy/core');
const { createTaskRunner } = require('../src/tasks');
const { createApp } = require('../src/app');

const quietLog = { info() {}, warn() {}, error() {}, child() { return quietLog; } };

/** A module that wants to announce something to a fixed list of people. */
const announcer = (to, reply = { title: 'New invoice', text: 'One arrived.' }) => ({
  name: 'invoices',
  allowedIn: ['DM'],
  onSchedule: async (ctx, task) => (task === 'daily' ? [{ to, reply }] : []),
});

function setup({ to, invoicesAccess = 'robin@example.com', allowedUsers = ['domain:example.com'], dms = {} }) {
  const modules = [announcer(to)];
  const access = core.createAccessPolicy({ modules, env: { BUDDY_ACCESS_INVOICES: invoicesAccess } });
  const registry = core.createRegistry({ modules, env: {}, log: quietLog, access });
  const posted = [];
  const chat = {
    findDirectMessage: async email => dms[email] || null,
    postText: async (space, thread, text) => { posted.push({ space, thread, text }); return `${space}/messages/1`; },
    postCard: async (space, thread, text, cardsV2) => { posted.push({ space, thread, text, cardsV2 }); return `${space}/messages/1`; },
  };
  const allowed = core.parseRule(allowedUsers.join(','), 'BUDDY_ALLOWED_USERS');
  const runTask = createTaskRunner({
    registry, chat, access, log: quietLog,
    makeModuleContext: core.createContextFactory({ store: core.createMemoryStore(), sealer: core.createLocalSealer(), env: {}, log: quietLog, access }),
    mayTalk: email => allowed({ email }),
  });
  return { runTask, posted };
}

test('a scheduled note reaches the people it names, in their DM with Buddy', async () => {
  const { runTask, posted } = setup({ to: ['Robin@Example.com'], dms: { 'robin@example.com': 'spaces/dm-robin' } });
  const summary = await runTask('daily');
  assert.equal(summary.sent, 1);
  assert.equal(posted[0].space, 'spaces/dm-robin', 'the DM Buddy looked up, not anywhere the module chose');
  assert.equal(posted[0].thread, null);
});

// A module's notify list can never reach past its access list.
test('someone without access to the module is never told, even if the module names them', async () => {
  const { runTask, posted } = setup({
    to: ['robin@example.com', 'eve@example.com'],
    dms: { 'robin@example.com': 'spaces/dm-robin', 'eve@example.com': 'spaces/dm-eve' },
  });
  const summary = await runTask('daily');
  assert.deepEqual(posted.map(p => p.space), ['spaces/dm-robin']);
  assert.equal(summary.skipped, 1);
});

test('someone not allowed on Buddy at all is never told, whatever the module\'s access says', async () => {
  const { runTask, posted } = setup({
    to: ['outsider@other.test'], invoicesAccess: 'outsider@other.test', allowedUsers: ['domain:example.com'],
    dms: { 'outsider@other.test': 'spaces/dm-x' },
  });
  await runTask('daily');
  assert.equal(posted.length, 0);
});

test('someone who never opened a chat with Buddy is skipped, not an error', async () => {
  const { runTask, posted } = setup({ to: ['robin@example.com'] });
  const summary = await runTask('daily');
  assert.equal(posted.length, 0);
  assert.equal(summary.skipped, 1);
});

test('a task name that is not a plain word is refused', async () => {
  const { runTask } = setup({ to: [] });
  await assert.rejects(runTask('../../etc'), err => err.status === 404);
});

/* ---------- the /tasks route ---------- */

async function serve(appOpts) {
  const app = createApp({ verifyChat: async () => {}, handleEvent: async () => ({}), log: quietLog, ...appOpts });
  const server = http.createServer(app).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, close: () => server.close() };
}

test('/tasks does not exist unless a scheduler account is configured', async () => {
  const s = await serve({});
  try {
    assert.equal((await fetch(`${s.url}/tasks/daily`, { method: 'POST' })).status, 404);
  } finally { s.close(); }
});

test('/tasks refuses anything not signed by the scheduler account, and runs what is', async () => {
  const ran = [];
  const s = await serve({
    verifyTask: async header => { if (header !== 'Bearer good') throw new Error('unexpected token issuer x'); },
    runTask: async task => { ran.push(task); return { task, sent: 0 }; },
  });
  try {
    assert.equal((await fetch(`${s.url}/tasks/daily`, { method: 'POST' })).status, 401);
    assert.equal((await fetch(`${s.url}/tasks/daily`, { method: 'POST', headers: { authorization: 'Bearer bad' } })).status, 401);
    assert.deepEqual(ran, [], 'nothing ran for an unsigned request');
    const ok = await fetch(`${s.url}/tasks/daily`, { method: 'POST', headers: { authorization: 'Bearer good' } });
    assert.equal(ok.status, 200);
    assert.deepEqual(ran, ['daily']);
  } finally { s.close(); }
});

test('the caller verifier pins the email: a valid Google token from anyone else is refused', async () => {
  const oauthClient = email => ({ verifyIdToken: async () => ({ getPayload: () => ({ email, email_verified: true }) }) });
  const expected = 'buddy-scheduler@your-gcp-project.iam.gserviceaccount.com';
  const good = core.createCallerVerifier({ audience: 'https://bot', oauthClient: oauthClient(expected), email: expected });
  await good('Bearer abc');
  const chatToken = core.createCallerVerifier({ audience: 'https://bot', oauthClient: oauthClient(core.CHAT_ISSUER), email: expected });
  await assert.rejects(chatToken('Bearer abc'), /unexpected token issuer/, 'even Chat itself cannot run tasks');
});
