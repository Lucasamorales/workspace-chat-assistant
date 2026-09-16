/**
 * Generic OAuth for every connector in the registry.
 *
 * These routes are hit by the user's browser, not by Google Chat, so they cannot be
 * protected by Cloud Run IAM. The security control is the signed `state` parameter:
 * an HMAC over {chat user id, connector, nonce, issued-at}, valid for 10 minutes.
 * Without it, anyone could complete a callback and bind their vendor account to
 * someone else's Chat identity.
 */

const crypto = require('crypto');
const connectors = require('./connectors');

const STATE_TTL_MS = 10 * 60 * 1000;

function stateSecret() {
  const s = process.env.STATE_SECRET;
  if (!s) throw new Error('STATE_SECRET is not set');
  return s;
}

function signState(userId, connector) {
  const body = JSON.stringify({
    u: userId,
    c: connector,
    n: crypto.randomBytes(8).toString('hex'),
    t: Date.now(),
  });
  const payload = Buffer.from(body).toString('base64url');
  const sig = crypto.createHmac('sha256', stateSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyState(state) {
  const [payload, sig] = String(state || '').split('.');
  if (!payload || !sig) throw new Error('malformed state');

  const expected = crypto.createHmac('sha256', stateSecret()).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('bad state signature');

  const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
  if (Date.now() - data.t > STATE_TTL_MS) throw new Error('state expired');
  return { userId: data.u, connector: data.c };
}

/** Build the vendor consent URL a user should be sent to. */
function authorizeUrl(name, userId, baseUrl) {
  const c = connectors.get(name);
  const params = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: `${baseUrl}/auth/${name}/callback`,
    state: signState(userId, name),
  });
  if (c.responseType !== false) params.set('response_type', 'code');
  if (c.scope) params.set('scope', c.scope);
  return `${c.authorizeUrl}?${params}`;
}

async function exchange(name, params) {
  const c = connectors.get(name);
  const r = await fetch(c.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: c.clientId,
      client_secret: c.clientSecret,
      ...params,
    }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${c.label} token exchange ${r.status}: ${text.slice(0, 200)}`);

  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`${c.label} returned non-JSON: ${text.slice(0, 120)}`); }

  const token = data.access_token || data.accessToken;
  if (!token) throw new Error(`${c.label} response had no access_token`);

  const ttl = data.expires_in ? data.expires_in * 1000 : c.defaultTtlMs;
  return {
    access_token: token,
    refresh_token: data.refresh_token || null,
    expires_at: ttl ? Date.now() + ttl : null,   // null = never expires
    obtained_at: Date.now(),
  };
}

function exchangeCode(name, code, baseUrl) {
  return exchange(name, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: `${baseUrl}/auth/${name}/callback`,
  });
}

/**
 * Return a usable access token, refreshing if it's within 2 minutes of expiry.
 * Persists the refreshed token via the supplied save() callback.
 */
async function validToken(name, stored, save) {
  if (!stored?.access_token) throw new Error(`${connectors.get(name).label} is not connected. Send \`/connect ${name}\`.`);

  const c = connectors.get(name);
  const fresh = !stored.expires_at || Date.now() < stored.expires_at - 120_000;
  if (fresh) return stored.access_token;

  if (!c.refreshable || !stored.refresh_token) {
    throw new Error(`${c.label} authorisation expired. Send \`/connect ${name}\` to reconnect.`);
  }

  const next = await exchange(name, {
    grant_type: 'refresh_token',
    refresh_token: stored.refresh_token,
  });
  // Some vendors omit refresh_token on refresh; keep the original.
  next.refresh_token = next.refresh_token || stored.refresh_token;
  await save(next);
  return next.access_token;
}

/** Mount /auth/:connector/start and /auth/:connector/callback. */
function mount(app, { baseUrl, db }) {
  app.get('/auth/:connector/start', (req, res) => {
    const name = req.params.connector;
    const userId = String(req.query.u || '');
    if (!userId) return res.status(400).send('Missing user reference.');
    try {
      res.redirect(authorizeUrl(name, userId, baseUrl));
    } catch (e) {
      res.status(400).send(page('Could not start authorisation', e.message));
    }
  });

  app.get('/auth/:connector/callback', async (req, res) => {
    const name = req.params.connector;
    try {
      if (req.query.error) throw new Error(`Vendor returned: ${req.query.error}`);

      const { userId, connector } = verifyState(req.query.state);
      if (connector !== name) throw new Error('state/connector mismatch');
      if (!req.query.code) throw new Error('no authorisation code returned');

      const tokens = await exchangeCode(name, req.query.code, baseUrl);
      await db.collection('users').doc(userId)
        .set({ connectors: { [name]: tokens } }, { merge: true });

      const label = connectors.get(name).label;
      res.send(page(`${label} connected`, 'You can close this tab and go back to Google Chat.'));
    } catch (e) {
      console.error('oauth callback failed', name, e.message);
      res.status(400).send(page('Authorisation failed', e.message));
    }
  });
}

function page(title, body) {
  const esc = s => String(s).replace(/[<>&]/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ch]));
  return `<!doctype html><meta charset="utf-8">
<title>${esc(title)}</title>
<div style="font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:15vh auto;padding:0 1rem">
<h1 style="font-size:1.3rem">${esc(title)}</h1><p>${esc(body)}</p></div>`;
}

module.exports = { mount, validToken, authorizeUrl };
