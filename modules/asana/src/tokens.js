/**
 * Asana OAuth tokens for one user: encrypted at rest (ctx.seal → Cloud KMS), refreshed
 * automatically, revoked at Asana on disconnect.
 */

const TOKEN_URL = 'https://app.asana.com/-/oauth_token';
const REVOKE_URL = 'https://app.asana.com/-/oauth_revoke';
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const DEFAULT_TTL_S = 3600; // Asana access tokens last one hour

const expose = message => Object.assign(new Error(message), { expose: true });
const notConnected = message => Object.assign(expose(message), { notConnected: true });

function normalize(resp, previous = {}, now = Date.now()) {
  const user = resp.data || previous.asanaUser || null;
  return {
    access_token: resp.access_token,
    refresh_token: resp.refresh_token || previous.refresh_token || null,
    expires_at: now + (Number(resp.expires_in) || DEFAULT_TTL_S) * 1000,
    asanaUser: user ? { gid: String(user.gid || user.id || ''), name: user.name || null, email: user.email || null } : null,
  };
}

const col = ctx => ctx.store.collection('tokens');

async function load(ctx) {
  const doc = await col(ctx).get(ctx.userId);
  return doc ? ctx.open(doc.sealed) : null;
}

async function save(ctx, tokens) {
  await col(ctx).set(ctx.userId, { sealed: await ctx.seal(tokens), updatedAt: new Date() });
}

async function postForm(ctx, url, fields) {
  return ctx.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      client_id: ctx.settings.ASANA_CLIENT_ID,
      client_secret: ctx.settings.ASANA_CLIENT_SECRET,
      ...fields,
    }),
  });
}

/** oauth.saveTokens: called by oauth-gateway after a successful consent. */
async function saveFromOAuth(ctx, tokenResponse) {
  const tokens = normalize(tokenResponse);
  const asanaEmail = tokens.asanaUser && tokens.asanaUser.email;
  const requireMatch = ctx.settings.ASANA_REQUIRE_EMAIL_MATCH !== 'false';

  if (requireMatch && asanaEmail && asanaEmail.toLowerCase() !== String(ctx.userEmail).toLowerCase()) {
    await revoke(ctx, tokens.refresh_token || tokens.access_token);
    ctx.log.warn('asana account email does not match chat user', { userId: ctx.userId });
    throw expose(`That Asana account (${asanaEmail}) doesn't match your Google account. `
      + 'Sign in to Asana with your own work account and try again.');
  }
  if (requireMatch && !asanaEmail) ctx.log.warn('asana token response had no email; could not check account match', { userId: ctx.userId });

  await save(ctx, tokens);
  ctx.log.info('asana connected', { userId: ctx.userId });
}

/** A valid access token, refreshing if it's about to expire. Throws notConnected if not possible. */
async function accessToken(ctx, now = Date.now()) {
  const tokens = await load(ctx);
  if (!tokens) throw notConnected('Asana is not connected.');
  if (tokens.expires_at - now > REFRESH_MARGIN_MS) return tokens.access_token;

  if (!tokens.refresh_token) {
    await col(ctx).delete(ctx.userId);
    throw notConnected('Your Asana connection expired.');
  }

  const res = await postForm(ctx, TOKEN_URL, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
  if (res.status === 400 || res.status === 401) {
    await col(ctx).delete(ctx.userId); // refresh token revoked or invalid: force a clean reconnect
    throw notConnected('Your Asana connection was revoked or expired.');
  }
  if (!res.ok) throw new Error(`Asana token refresh failed with HTTP ${res.status}`);

  const next = normalize(await res.json(), tokens, now);
  await save(ctx, next);
  return next.access_token;
}

async function revoke(ctx, token) {
  if (!token) return;
  try {
    const res = await postForm(ctx, REVOKE_URL, { token });
    if (!res.ok) ctx.log.warn('asana revoke failed', { status: res.status });
  } catch (error) {
    ctx.log.warn('asana revoke failed', { error });
  }
}

async function disconnect(ctx) {
  const tokens = await load(ctx).catch(() => null);
  await col(ctx).delete(ctx.userId);
  if (tokens) await revoke(ctx, tokens.refresh_token || tokens.access_token);
  return Boolean(tokens);
}

module.exports = { saveFromOAuth, accessToken, disconnect, load, normalize, TOKEN_URL };
