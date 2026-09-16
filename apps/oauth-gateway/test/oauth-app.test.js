const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const core = require('@buddy/core');
const { createOAuthApp } = require('../src/app');

const quietLog = { info() {}, warn() {}, error() {}, child() { return quietLog; } };

async function withServer(fn) {
  const store = core.createMemoryStore();
  const saved = [];
  const mod = {
    name: 'asana',
    oauth: {
      label: 'Asana', authorizeUrl: 'https://app.asana.com/-/oauth_authorize', tokenUrl: 'https://app.asana.com/-/oauth_token',
      clientIdSetting: 'ASANA_CLIENT_ID', clientSecretSetting: 'ASANA_CLIENT_SECRET',
      saveTokens: async (ctx, t) => saved.push({ userId: ctx.userId, token: t.access_token }),
    },
  };
  const env = { ASANA_CLIENT_ID: 'cid', ASANA_CLIENT_SECRET: 'sec' };
  const flows = core.createOAuthFlows({
    store, secret: 'k'.repeat(40), baseUrl: 'https://oauth.test',
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{"access_token":"AT"}' }),
  });
  const app = createOAuthApp({
    registry: core.createRegistry({ modules: [mod], env, log: quietLog }),
    flows, env, log: quietLog,
    makeModuleContext: core.createContextFactory({ store, sealer: core.createLocalSealer(), env, log: quietLog }),
  });
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ base, flows, saved, get: path => fetch(base + path, { redirect: 'manual' }) });
  } finally {
    server.close();
  }
}

test('happy path: link from Chat → redirect to Asana → callback stores tokens once', () => withServer(async ({ flows, saved, get }) => {
  const link = await flows.createLink({ userId: '111', userEmail: 'robin@example.com', moduleName: 'asana' });
  const start = await get(new URL(link).pathname + new URL(link).search);
  assert.equal(start.status, 302);
  const location = new URL(start.headers.get('location'));
  assert.equal(location.origin, 'https://app.asana.com');
  assert.equal(start.headers.get('referrer-policy'), 'no-referrer');

  const cb = `/auth/asana/callback?code=C&state=${encodeURIComponent(location.searchParams.get('state'))}`;
  const done = await get(cb);
  assert.equal(done.status, 200);
  assert.deepEqual(saved, [{ userId: '111', token: 'AT' }]);

  const replay = await get(cb);
  assert.equal(replay.status, 400);
  assert.equal(saved.length, 1);
}));

test('the old ?u=<userId> trick does nothing; unknown routes 404; no framework fingerprint', () => withServer(async ({ get }) => {
  const res = await get('/auth/asana/start?u=111');
  assert.equal(res.status, 400);
  assert.equal((await get('/auth/clickup/start?s=x')).status, 404);
  assert.equal((await get('/')).status, 404);
  assert.equal(res.headers.get('x-powered-by'), null);
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
}));

test('repeated query parameters are rejected', () => withServer(async ({ flows, get }) => {
  const link = await flows.createLink({ userId: '111', userEmail: 'a@x.com', moduleName: 'asana' });
  const s = new URL(link).searchParams.get('s');
  const res = await get(`/auth/asana/start?s=${encodeURIComponent(s)}&s=${encodeURIComponent(s)}`);
  assert.equal(res.status, 400);
}));
