/**
 * Verifies that a request really comes from Google Chat.
 *
 * Google Chat signs every request with a JWT whose audience is our endpoint URL and whose
 * email is chat@system.gserviceaccount.com. verifyIdToken checks the signature against
 * Google's keys, the expiry and the audience; we then pin the issuer email.
 */

const CHAT_ISSUER = 'chat@system.gserviceaccount.com';

function createChatVerifier({ audience, oauthClient }) {
  if (!audience) throw new Error('chat verifier needs an audience');
  return async function verifyChatRequest(authorizationHeader) {
    const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(authorizationHeader || '');
    if (!match) throw new Error('missing bearer token');

    const ticket = await oauthClient.verifyIdToken({ idToken: match[1], audience });
    const payload = ticket.getPayload() || {};
    if (payload.email !== CHAT_ISSUER || payload.email_verified !== true) {
      throw new Error(`unexpected token issuer ${payload.email || '(none)'}`);
    }
    return payload;
  };
}

module.exports = { createChatVerifier, CHAT_ISSUER };
