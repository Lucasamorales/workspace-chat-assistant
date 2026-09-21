const test = require('node:test');
const assert = require('node:assert/strict');
const { createImpersonator } = require('../src/impersonate');

const SA = 'buddy-bot@your-gcp-project.iam.gserviceaccount.com';
const auth = {
  getCredentials: async () => ({ client_email: SA }),
  getClient: async () => ({ getAccessToken: async () => ({ token: 'own-identity' }) }),
};

const ok = body => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const err = (status, body) => ({ ok: false, status, json: async () => body, text: async () => JSON.stringify(body) });

function recorder(responses) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options, body: options.body });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected call to ${url}`);
    return next;
  };
  return { fetch, calls };
}

test('the JWT is signed by Google, never locally: no key is ever held', async () => {
  const { fetch, calls } = recorder([ok({ signedJwt: 'signed' }), ok({ access_token: 'acting-as-robin' })]);
  const imp = createImpersonator({ auth, fetch });

  assert.equal(await imp.tokenFor('robin@example.com'), 'acting-as-robin');

  const [sign, exchange] = calls;
  assert.match(sign.url, /iamcredentials\.googleapis\.com.*:signJwt$/);
  assert.equal(sign.options.headers.Authorization, 'Bearer own-identity', 'authenticates as itself, with no key');
  const claims = JSON.parse(JSON.parse(sign.body).payload);
  assert.equal(claims.iss, SA);
  assert.equal(claims.sub, 'robin@example.com', 'acts for exactly the person asked for');
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/calendar.events', 'events only, not full calendar');
  assert.match(exchange.url, /oauth2\.googleapis\.com\/token$/);
});

test('tokens are reused until they are nearly expired, and are never shared between people', async () => {
  const { fetch, calls } = recorder([
    ok({ signedJwt: 's1' }), ok({ access_token: 'for-robin' }),
    ok({ signedJwt: 's2' }), ok({ access_token: 'for-remy' }),
  ]);
  const imp = createImpersonator({ auth, fetch });

  assert.equal(await imp.tokenFor('robin@example.com'), 'for-robin');
  assert.equal(await imp.tokenFor('robin@example.com'), 'for-robin');
  assert.equal(calls.length, 2, 'the second call came from cache');
  assert.equal(await imp.tokenFor('remy@example.com'), 'for-remy');
  assert.equal(calls.length, 4);
});

test('a missing delegation says exactly what an admin has to add', async () => {
  const { fetch } = recorder([ok({ signedJwt: 's' }), err(400, { error: 'unauthorized_client' })]);
  const imp = createImpersonator({ auth, fetch });
  await assert.rejects(imp.tokenFor('robin@example.com'), e => {
    assert.equal(e.expose, true);
    assert.match(e.message, /domain-wide delegation/);
    assert.match(e.message, /calendar\.events/);
    return true;
  });
});

test('a missing token-creator role is explained too, not shown as a raw 403', async () => {
  const { fetch } = recorder([err(403, { error: 'forbidden' })]);
  const imp = createImpersonator({ auth, fetch });
  await assert.rejects(imp.tokenFor('robin@example.com'), e => {
    assert.match(e.message, /Service Account Token Creator/);
    return true;
  });
});

test('an unknown person is named plainly', async () => {
  const { fetch } = recorder([ok({ signedJwt: 's' }), err(400, { error: 'invalid_grant' })]);
  const imp = createImpersonator({ auth, fetch });
  await assert.rejects(imp.tokenFor('ghost@example.com'), /doesn't recognise ghost@example\.com/);
});
