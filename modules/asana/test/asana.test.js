const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryStore, createLocalSealer, createContextFactory, validateModule } = require('@buddy/core');
const asana = require('../src');
const tokens = require('../src/tokens');
const { createAsanaToolset, needsApprovalFor, mcpUrl } = require('../src/toolset');

const quietLog = { info() {}, warn() {}, error() {}, child() { return quietLog; } };
const ENV = { ASANA_CLIENT_ID: 'cid', ASANA_CLIENT_SECRET: 'csecret' };

function ctxFor({ env = ENV, fetchImpl, userId = '111', userEmail = 'robin@example.com', store = createMemoryStore(), sealer = createLocalSealer() } = {}) {
  const make = createContextFactory({ store, sealer, env, log: quietLog, fetchImpl: fetchImpl || (async () => { throw new Error('no network in tests'); }) });
  return make(asana, { userId, userEmail, spaceKind: 'DM' });
}

const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

test('module satisfies the contract and is DM-only with no scope parameter', () => {
  validateModule(asana);
  assert.deepEqual(asana.allowedIn, ['DM']);
  assert.equal(asana.oauth.extraAuthorizeParams, undefined);
});

test('tokens are stored encrypted, never in plain text', async () => {
  const store = createMemoryStore();
  const ctx = ctxFor({ store });
  await tokens.saveFromOAuth(ctx, { access_token: 'SECRET-AT', refresh_token: 'SECRET-RT', expires_in: 3600, data: { gid: '9', email: 'robin@example.com' } });
  const raw = JSON.stringify(store.dump());
  assert.doesNotMatch(raw, /SECRET-AT|SECRET-RT/);
  assert.equal(await tokens.accessToken(ctx), 'SECRET-AT');
});

test('a token copied to another user cannot be decrypted', async () => {
  const store = createMemoryStore();
  const sealer = createLocalSealer();
  const robin = ctxFor({ store, sealer });
  await tokens.saveFromOAuth(robin, { access_token: 'AT', data: { email: 'robin@example.com' } });
  const doc = await robin.store.collection('tokens').get('111');
  const remy = ctxFor({ store, sealer, userId: '222', userEmail: 'remy@example.com' });
  await remy.store.collection('tokens').set('222', doc);
  await assert.rejects(tokens.accessToken(remy));
});

test('an Asana account with a different email is rejected and revoked', async () => {
  const calls = [];
  const ctx = ctxFor({ fetchImpl: async url => { calls.push(url); return json(200, {}); } });
  await assert.rejects(
    tokens.saveFromOAuth(ctx, { access_token: 'AT', refresh_token: 'RT', data: { email: 'someone.else@gmail.com' } }),
    /doesn't match your Google account/,
  );
  assert.equal(await tokens.load(ctx), null);
  assert.ok(calls.some(u => u.includes('oauth_revoke')));
});

test('expired token is refreshed; a rejected refresh forces reconnect', async () => {
  let refreshStatus = 200;
  const ctx = ctxFor({ fetchImpl: async () => json(refreshStatus, { access_token: 'NEW', expires_in: 3600 }) });
  await tokens.saveFromOAuth(ctx, { access_token: 'OLD', refresh_token: 'RT', expires_in: 1, data: { email: 'robin@example.com' } });
  assert.equal(await tokens.accessToken(ctx), 'NEW');
  assert.equal((await tokens.load(ctx)).refresh_token, 'RT', 'keeps refresh token when Asana omits it');

  await tokens.saveFromOAuth(ctx, { access_token: 'OLD', refresh_token: 'RT', expires_in: 1, data: { email: 'robin@example.com' } });
  refreshStatus = 400;
  await assert.rejects(tokens.accessToken(ctx), e => e.notConnected === true);
  assert.equal(await tokens.load(ctx), null);
});

test('approval: only explicitly read-only, non-destructive tools skip it', () => {
  assert.equal(needsApprovalFor({ name: 'get', annotations: { readOnlyHint: true } }, []), false);
  assert.equal(needsApprovalFor({ name: 'weird', annotations: { readOnlyHint: true, destructiveHint: true } }, []), true);
  assert.equal(needsApprovalFor({ name: 'update_task' }, []), true);
  assert.equal(needsApprovalFor({ name: 'search' }, ['search']), false);
  assert.equal(needsApprovalFor(undefined, []), true);
});

test('the token can only ever be sent to mcp.asana.com', () => {
  assert.equal(mcpUrl({}).hostname, 'mcp.asana.com');
  assert.throws(() => mcpUrl({ ASANA_MCP_URL: 'https://attacker.example/mcp' }), /mcp\.asana\.com/);
  assert.throws(() => mcpUrl({ ASANA_MCP_URL: 'http://mcp.asana.com/v2/mcp' }), /mcp\.asana\.com/);
});

test('toolset: not connected → note for Claude; connected → MCP tools with bearer token', async () => {
  const notConnected = await createAsanaToolset(ctxFor());
  assert.match(notConnected.unavailable, /\/asana connect/);

  const ctx = ctxFor();
  await tokens.saveFromOAuth(ctx, { access_token: 'AT', expires_in: 3600, data: { email: 'robin@example.com' } });
  let usedToken;
  const fakeClient = {
    listTools: async () => ({ tools: [
      { name: 'get_task', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
      { name: 'delete_task', inputSchema: { type: 'object' }, annotations: { destructiveHint: true, title: 'Delete task' } },
    ] }),
    callTool: async ({ name }) => ({ content: [{ type: 'text', text: `${name} done` }] }),
    close: async () => {},
  };
  const ts = await createAsanaToolset(ctx, { connect: async (url, token) => { usedToken = token; return fakeClient; } });
  assert.equal(usedToken, 'AT');
  assert.deepEqual(ts.definitions.map(d => d.name), ['get_task', 'delete_task']);
  assert.equal(ts.needsApproval('get_task'), false);
  assert.equal(ts.needsApproval('delete_task'), true);
  assert.deepEqual(await ts.describe('delete_task', { task: 'abc' }), { effect: 'delete', title: 'Delete task', fields: [{ label: 'Task', value: 'abc' }] });
  assert.deepEqual(await ts.execute('delete_task', {}), { content: 'delete_task done', isError: false });
});

test('/asana tools lists what runs freely and what needs approval', async () => {
  const ctx = ctxFor();
  const notConnected = await asana.commands.asana.run({ ...ctx, core: {} }, 'tools');
  assert.match(notConnected, /not connected/);
});
