/**
 * OAuth for modules (Asana today). Fixes the account-hijack bug in the original bot:
 *
 * - The link is created INSIDE Chat, where Google has verified who is asking. The browser
 *   routes never accept a user id from the URL.
 * - The link carries a signed token pointing at a server-side session that is single-use
 *   and expires after 1 hour.
 * - PKCE: the code verifier stays on our server, so a stolen authorisation code is useless.
 */

const crypto = require('crypto');
const { signToken, verifyToken } = require('./signed-token');

// Long enough to click the link later in the day, short enough that old links stop working.
const SESSION_TTL_MS = 60 * 60 * 1000;

const b64url = buf => buf.toString('base64url');

/**
 * The two halves of a module's OAuth connection: starting a flow from inside Chat,
 * and finishing it in the browser callback.
 *
 * @param secret   signs the link tokens
 * @param baseUrl  public URL of the OAuth gateway, used to build redirect URIs
 */
function createOAuthFlows({ store, secret, baseUrl, fetchImpl = fetch, now = () => Date.now() }) {
  const sessions = store.collection('core__oauth_sessions');
  const redirectUri = moduleName => `${baseUrl}/auth/${moduleName}/callback`;

  function openToken(token, moduleName) {
    const data = verifyToken(token, secret, now());
    if (data.m !== moduleName || typeof data.n !== 'string') throw new Error('token does not match this connector');
    return data;
  }

  return {
    /** Called from Chat. Returns the link to send to the (already verified) user. */
    async createLink({ userId, userEmail, moduleName }) {
      const nonce = b64url(crypto.randomBytes(24));
      await sessions.set(nonce, {
        userId,
        userEmail,
        module: moduleName,
        verifier: b64url(crypto.randomBytes(32)),
        expireAt: new Date(now() + SESSION_TTL_MS),
      });
      const token = signToken({ n: nonce, m: moduleName }, secret, SESSION_TTL_MS, now());
      return `${baseUrl}/auth/${moduleName}/start?s=${encodeURIComponent(token)}`;
    },

    /** GET /auth/:module/start → vendor consent URL. */
    async authorizeUrl({ moduleName, token, oauth, clientId }) {
      const { n } = openToken(token, moduleName);
      const session = await sessions.get(n);
      if (!session || session.module !== moduleName || new Date(session.expireAt).getTime() < now()) {
        throw new Error('session missing or expired');
      }
      const challenge = b64url(crypto.createHash('sha256').update(session.verifier).digest());
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri(moduleName),
        response_type: 'code',
        state: token,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        ...(oauth.extraAuthorizeParams || {}),
      });
      return `${oauth.authorizeUrl}?${params}`;
    },

    /** GET /auth/:module/callback → consumes the session and exchanges the code. */
    async complete({ moduleName, state, code, oauth, clientId, clientSecret }) {
      const { n } = openToken(state, moduleName);
      const session = await sessions.take(n); // single use: a replayed callback finds nothing
      if (!session || session.module !== moduleName || new Date(session.expireAt).getTime() < now()) {
        throw new Error('session missing, already used, or expired');
      }
      if (typeof code !== 'string' || !code || code.length > 2048) throw new Error('missing authorisation code');

      const res = await fetchImpl(oauth.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri(moduleName),
          code,
          code_verifier: session.verifier,
        }),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`token exchange failed with HTTP ${res.status}`);
      let tokenResponse;
      try { tokenResponse = JSON.parse(text); } catch { throw new Error('token endpoint returned non-JSON'); }
      if (!tokenResponse.access_token) throw new Error('token response had no access_token');

      return { userId: session.userId, userEmail: session.userEmail, tokenResponse };
    },
  };
}

module.exports = { createOAuthFlows, SESSION_TTL_MS };
