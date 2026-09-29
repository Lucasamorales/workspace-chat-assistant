/**
 * Verifies that a request really comes from the Google identity it claims to.
 *
 * Google signs each request with a JWT whose audience is our endpoint URL and whose email is the
 * caller's: chat@system.gserviceaccount.com for Google Chat, Buddy's own scheduler account for
 * scheduled tasks. verifyIdToken checks the signature against Google's keys, the expiry and the
 * audience; we then pin the caller's email, so a valid token from anyone else is still refused.
 */

const CHAT_ISSUER = 'chat@system.gserviceaccount.com';

function createCallerVerifier({ audience, oauthClient, email }) {
  if (!audience) throw new Error('caller verifier needs an audience');
  if (!email) throw new Error('caller verifier needs the email it expects');
  return async function verifyCaller(authorizationHeader) {
    const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(authorizationHeader || '');
    if (!match) throw new Error('missing bearer token');

    const ticket = await oauthClient.verifyIdToken({ idToken: match[1], audience });
    const payload = ticket.getPayload() || {};
    if (payload.email !== email || payload.email_verified !== true) {
      throw new Error(`unexpected token issuer ${payload.email || '(none)'}`);
    }
    return payload;
  };
}

const createChatVerifier = ({ audience, oauthClient }) => createCallerVerifier({ audience, oauthClient, email: CHAT_ISSUER });

module.exports = { createChatVerifier, createCallerVerifier, CHAT_ISSUER };
