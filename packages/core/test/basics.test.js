const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadConfig, redact, createLogger, signToken, verifyToken, createMemoryStore, scopeStore,
  createLocalSealer, createChatVerifier, createUsage, costUsd, createThreads, splitText,
} = require('../src');

const SECRET = 'x'.repeat(40);

test('config rejects the "20~" class of typo instead of running with NaN', () => {
  assert.throws(() => loadConfig({ MAX: { type: 'number' } }, { MAX: '20~' }), /MAX must be a number/);
  assert.throws(() => loadConfig({ U: { type: 'url' } }, { U: 'https://x.run.app/' }), /must not end with a slash/);
  assert.throws(() => loadConfig({ K: { required: true } }, {}), /K is required/);
  const c = loadConfig({ N: { type: 'number', default: 5 }, L: { type: 'list' } }, { L: 'a@x.com, b@x.com' });
  assert.equal(c.N, 5);
  assert.deepEqual(c.L, ['a@x.com', 'b@x.com']);
});

test('logs never contain credentials', () => {
  const lines = [];
  createLogger('t', l => lines.push(l)).info('hi', { access_token: 'abc', nested: { authorization: 'Bearer z' }, ok: 1 });
  assert.doesNotMatch(lines[0], /abc|Bearer z/);
  assert.equal(redact({ refresh_token: 'r' }).refresh_token, '[redacted]');
});

test('signed tokens: valid, tampered, expired', () => {
  const t = signToken({ n: 'abc' }, SECRET, 1000, 0);
  assert.equal(verifyToken(t, SECRET, 500).n, 'abc');
  assert.throws(() => verifyToken(t, SECRET, 2000), /expired/);
  assert.throws(() => verifyToken(t.replace(/.$/, c => (c === 'A' ? 'B' : 'A')), SECRET, 500), /signature/);
  const [body, sig] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ n: 'evil', exp: 9e15 })).toString('base64url');
  assert.throws(() => verifyToken(`${forged}.${sig}`, SECRET, 500), /signature/);
  assert.ok(body);
  assert.throws(() => signToken({}, 'short', 1), /at least 32/);
});

test('memory store: create is exclusive, take is single-use', async () => {
  const col = createMemoryStore().collection('c');
  assert.equal(await col.create('a', { v: 1 }), true);
  assert.equal(await col.create('a', { v: 2 }), false);
  assert.deepEqual(await col.take('a'), { v: 1 });
  assert.equal(await col.take('a'), null);
});

test('scoped stores cannot see each other', async () => {
  const root = createMemoryStore();
  await scopeStore(root, 'm_asana').collection('tokens').set('u1', { secret: 1 });
  assert.equal(await scopeStore(root, 'm_files').collection('tokens').get('u1'), null);
});

test('sealer binds ciphertext to its context (user + module)', async () => {
  const sealer = createLocalSealer();
  const sealed = await sealer.seal({ access_token: 't' }, 'asana:111');
  assert.deepEqual(await sealer.open(sealed, 'asana:111'), { access_token: 't' });
  await assert.rejects(sealer.open(sealed, 'asana:222'));
});

test('chat verifier pins the Google Chat issuer', async () => {
  const fake = payload => ({ verifyIdToken: async () => ({ getPayload: () => payload }) });
  const ok = createChatVerifier({ audience: 'https://a', oauthClient: fake({ email: 'chat@system.gserviceaccount.com', email_verified: true }) });
  await ok('Bearer abc.def.ghi');
  await assert.rejects(ok(undefined), /missing bearer/);
  const addon = createChatVerifier({ audience: 'https://a', oauthClient: fake({ email: 'someone@evil.com', email_verified: true }) });
  await assert.rejects(addon('Bearer abc.def.ghi'), /unexpected token issuer/);
});

test('usage: cost includes cache pricing and the cap blocks further calls', async () => {
  assert.equal(costUsd({ input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 1e6 }, { inPerMTok: 2, outPerMTok: 10 }), 12.2);
  const u = createUsage({ store: createMemoryStore(), prices: { inPerMTok: 2, outPerMTok: 10 }, capUsd: 1 }).forUser('u');
  await u.check();
  await u.record({ input_tokens: 0, output_tokens: 100_000 });
  await assert.rejects(u.check(), /used this month's allowance \(\$1\)\. I'm back on 1 [A-Z][a-z]{2}\./);
});

test('threads: capped, start with user, expire after TTL', async () => {
  let now = 0;
  const threads = createThreads({ store: createMemoryStore(), maxMessages: 3, ttlDays: 30, now: () => now });
  await threads.append('t', 'q1', 'a1');
  await threads.append('t', 'q2', 'a2');
  const loaded = await threads.load('t');
  assert.equal(loaded[0].role, 'user');
  assert.ok(loaded.length <= 3);
  now = 31 * 24 * 3600 * 1000;
  assert.deepEqual(await threads.load('t'), []);
});

test('long replies are split under the Chat limit', () => {
  const parts = splitText('a'.repeat(9000));
  assert.ok(parts.every(p => p.length <= 4000));
  assert.equal(parts.join('').length, 9000);
});
