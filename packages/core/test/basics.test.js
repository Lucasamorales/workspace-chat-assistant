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

test('history is capped by size as well as by count, since it is re-sent every request', async () => {
  const { createMemoryStore, createThreads } = require('../src');
  const store = createMemoryStore();
  const threads = createThreads({ store, maxMessages: 20, maxChars: 400, ttlDays: 30 });

  for (let i = 0; i < 6; i += 1) {
    await threads.append('thread', `question ${i} ${'x'.repeat(100)}`, `answer ${i} ${'y'.repeat(100)}`);
  }
  const loaded = await threads.load('thread');
  const size = loaded.reduce((n, m) => n + m.content.length, 0);

  assert.ok(size <= 600, `history should be trimmed to roughly the budget, got ${size}`);
  assert.ok(loaded.length >= 2, 'but never trimmed away entirely');
  assert.equal(loaded[0].role, 'user', 'and always starts with a user message');
  assert.match(loaded.at(-1).content, /answer 5/, 'keeping the most recent exchange');
});

// Anthropic charges more to write a cache that lives an hour than one that lives five minutes
// (2x the input price rather than 1.25x). We ask for an hour, so charging the five-minute rate
// under-reports every first request — the expensive one — by 60%.
test('usage: a one-hour cache write is priced as one, not as a five-minute one', () => {
  const prices = { inPerMTok: 2, outPerMTok: 10 };
  const write = { cache_creation_input_tokens: 1e6 };
  assert.equal(costUsd(write, prices, null, '1h'), 4);
  assert.equal(costUsd(write, prices, null, '5m'), 2.5);
  assert.equal(costUsd(write, prices), 4, 'an hour is what the service asks for, so it is the default');

  // Haiku's writes follow its own input price, not Sonnet's.
  const perModel = { default: prices, 'claude-haiku-4-5': { inPerMTok: 1, outPerMTok: 5 } };
  assert.equal(costUsd(write, perModel, 'claude-haiku-4-5', '1h'), 2);
});

// Experiment 0010: the cap is API money, and a subscription reply spends none of it.
test('usage: a subscription reply costs no dollars and never hits the cap, but its window is kept', async () => {
  const store = createMemoryStore();
  const usage = createUsage({ store, prices: { inPerMTok: 2, outPerMTok: 10 }, capUsd: 1 });
  // Already over the cap on the API.
  await usage.forUser('u').record({ output_tokens: 200_000 });

  const meter = usage.meter({ userId: 'u', userEmail: 'robin@example.com', backend: 'subscription' });
  await meter.check();
  await meter.record({
    input_tokens: 1e6, output_tokens: 0,
    buddy_subscription: { five_hour_utilization: 0.31, seven_day_utilization: 0.04, five_hour_resets_at: 1790610000, using_overage: false },
  }, 'claude-sonnet-5');
  const event = await meter.finish();

  assert.equal(event.backend, 'subscription');
  assert.equal(event.usd, 0, 'nothing billed');
  assert.equal(event.apiEquivalentUsd, 2, 'what the API would have charged, for the comparison');
  assert.deepEqual(event.subscription, { fiveHour: 0.31, sevenDay: 0.04, resetsAt: 1790610000, usingOverage: false });
  assert.equal((await usage.forUser('u').get()).usd, 2, 'the API spend is untouched by subscription use');

  const api = usage.meter({ userId: 'u', userEmail: 'x', backend: 'api' });
  await assert.rejects(api.check(), /allowance/, 'the API cap still applies to API requests');
});

// Replies can name a dated model; with Opus as the default price, a dated Sonnet reply looked up
// by exact name would have been billed as Opus in /costs.
test('usage: a dated model id is priced as the model it names, not the default', () => {
  const prices = {
    default: { inPerMTok: 4, outPerMTok: 20 },
    'claude-sonnet-5': { inPerMTok: 2, outPerMTok: 10 },
    'claude-opus-5': { inPerMTok: 5, outPerMTok: 25 },
    'claude-opus-5-5': { inPerMTok: 4, outPerMTok: 20 },
  };
  const million = { input_tokens: 1e6 };
  assert.equal(costUsd(million, prices, 'claude-sonnet-5-20260801'), 2);
  assert.equal(costUsd(million, prices, 'claude-opus-5-5-20260901'), 4, 'the longer name wins over claude-opus-5');
  assert.equal(costUsd(million, prices, 'claude-opus-5-20260101'), 5);
  assert.equal(costUsd(million, prices, 'claude-sonnet-50'), 4, 'a prefix must end at a dash, or sonnet-5 would claim sonnet-50');
  assert.equal(costUsd(million, prices, 'something-new'), 4, 'unknown still costs the default');
});
