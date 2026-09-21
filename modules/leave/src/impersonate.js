/**
 * Acting as a person on their own calendar, without holding a key.
 *
 * Domain-wide delegation normally means shipping a service account private key and signing
 * JWTs with it — that key is what leaked in the Apps Script this module replaces. Instead,
 * buddy-bot asks Google's IAM Credentials API to sign the JWT *for* it, authenticating with
 * the identity Cloud Run already gives it. There is nothing to store and nothing to rotate.
 *
 * The signed assertion names a `sub`: the person being acted as. Choosing that value is the
 * whole security boundary of this module, so it is decided in module.js from the Chat-verified
 * sender and passed in here already settled.
 */

const SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ASSERTION_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const LIFETIME_S = 3600;
const EARLY_S = 300; // renew before expiry rather than racing it

function fail(message, cause) {
  return Object.assign(new Error(message), { expose: true, cause });
}

/**
 * @param auth   google-auth-library GoogleAuth, used only for buddy-bot's own credentials
 * @param fetch  injected so tests never touch the network
 */
function createImpersonator({ auth, fetch: doFetch = fetch, now = () => Date.now() }) {
  const cache = new Map(); // subject → { token, expiresAt }
  let selfEmail = null;

  async function serviceAccountEmail() {
    if (!selfEmail) {
      const credentials = await auth.getCredentials();
      selfEmail = credentials.client_email;
      if (!selfEmail) throw fail('Buddy could not work out its own service account identity.');
    }
    return selfEmail;
  }

  /** Ask IAM Credentials to sign a JWT as buddy-bot, claiming to act for `subject`. */
  async function signedAssertion(subject) {
    const email = await serviceAccountEmail();
    const client = await auth.getClient();
    const { token } = await client.getAccessToken();
    const issued = Math.floor(now() / 1000);
    const payload = JSON.stringify({
      iss: email, sub: subject, scope: SCOPE, aud: TOKEN_URL, iat: issued, exp: issued + LIFETIME_S,
    });

    const res = await doFetch(
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(email)}:signJwt`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload }),
      },
    );
    if (!res.ok) {
      const body = await res.text();
      if (res.status === 403) {
        throw fail('Buddy isn\'t allowed to sign its own tokens yet. Grant buddy-bot the Service Account '
          + 'Token Creator role on itself, and enable iamcredentials.googleapis.com.', body);
      }
      throw fail('Buddy couldn\'t prepare its access to Google Calendar.', body);
    }
    return (await res.json()).signedJwt;
  }

  /** An access token that acts as `subject`, cached until shortly before it expires. */
  async function tokenFor(subject) {
    const hit = cache.get(subject);
    if (hit && hit.expiresAt > now()) return hit.token;

    const assertion = await signedAssertion(subject);
    const res = await doFetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: ASSERTION_TYPE, assertion }).toString(),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      // unauthorized_client means the delegation is missing or the scope does not match exactly.
      if (body.error === 'unauthorized_client') {
        throw fail(`Buddy isn't allowed to act for ${subject} yet. A Workspace admin needs to add buddy-bot's `
          + 'client id with the calendar.events scope under domain-wide delegation.', body);
      }
      if (body.error === 'invalid_grant') {
        throw fail(`Google doesn't recognise ${subject} as an account in this Workspace.`, body);
      }
      throw fail('Buddy couldn\'t get access to that calendar.', body);
    }
    cache.set(subject, { token: body.access_token, expiresAt: now() + (LIFETIME_S - EARLY_S) * 1000 });
    return body.access_token;
  }

  return { tokenFor, serviceAccountEmail };
}

module.exports = { createImpersonator, SCOPE };
