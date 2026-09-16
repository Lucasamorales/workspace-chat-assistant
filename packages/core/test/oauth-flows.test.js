const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createOAuthFlows, createMemoryStore } = require('../src');

const SECRET = 's'.repeat(40);
const OAUTH = { authorizeUrl: 'https://vendor/authorize', tokenUrl: 'https://vendor/token' };

function setup(now = () => Date.now()) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, body: Object.fromEntries(new URLSearchParams(init.body.toString())) });
    return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'AT', refresh_token: 'RT' }) };
  };
  const flows = createOAuthFlows({ store: createMemoryStore(), secret: SECRET, baseUrl: 'https://oauth.example', fetchImpl, now });
  return { flows, requests };
}

const tokenFrom = link => new URL(link).searchParams.get('s');

test('full flow with PKCE; identity comes only from the server-side session', async () => {
  const { flows, requests } = setup();
  const link = await flows.createLink({ userId: '111', userEmail: 'robin@x.com', moduleName: 'asana' });
  assert.match(link, /^https:\/\/oauth\.example\/auth\/asana\/start\?s=/);
  assert.doesNotMatch(link, /111/, 'the user id is not in the link');

  const auth = new URL(await flows.authorizeUrl({ moduleName: 'asana', token: tokenFrom(link), oauth: OAUTH, clientId: 'cid' }));
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(auth.searchParams.get('redirect_uri'), 'https://oauth.example/auth/asana/callback');
  assert.equal(auth.searchParams.get('scope'), null);

  const result = await flows.complete({ moduleName: 'asana', state: auth.searchParams.get('state'), code: 'C', oauth: OAUTH, clientId: 'cid', clientSecret: 'sec' });
  assert.equal(result.userId, '111');
  const verifier = requests[0].body.code_verifier;
  assert.equal(crypto.createHash('sha256').update(verifier).digest('base64url'), auth.searchParams.get('code_challenge'));
});

test('callback cannot be replayed', async () => {
  const { flows } = setup();
  const token = tokenFrom(await flows.createLink({ userId: '1', userEmail: 'a@x.com', moduleName: 'asana' }));
  const args = { moduleName: 'asana', state: token, code: 'C', oauth: OAUTH, clientId: 'c', clientSecret: 's' };
  await flows.complete(args);
  await assert.rejects(flows.complete(args), /already used/);
});

test('a link for one connector cannot be used for another, forged or expired links fail', async () => {
  let now = 1_000_000;
  const { flows } = setup(() => now);
  const token = tokenFrom(await flows.createLink({ userId: '1', userEmail: 'a@x.com', moduleName: 'asana' }));
  await assert.rejects(flows.authorizeUrl({ moduleName: 'other', token, oauth: OAUTH, clientId: 'c' }), /does not match/);
  await assert.rejects(flows.authorizeUrl({ moduleName: 'asana', token: `${token}x`, oauth: OAUTH, clientId: 'c' }), /signature|malformed/);
  await assert.rejects(flows.authorizeUrl({ moduleName: 'asana', token: null, oauth: OAUTH, clientId: 'c' }), /malformed/);
  now += 61 * 60 * 1000;
  await assert.rejects(flows.authorizeUrl({ moduleName: 'asana', token, oauth: OAUTH, clientId: 'c' }), /expired/);
});
