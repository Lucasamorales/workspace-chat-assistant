/**
 * A read-only access token for the one mailbox that holds the leave calendar.
 *
 * Workspace will not let an outside address (our service account) see event details, only
 * free/busy — which cannot answer "who is out". So `ooo` reads the calendar by acting as one
 * fixed account instead. That is a workaround, and the fences live here:
 *
 *   - the account acted as comes from settings, never from a user, a message or Claude;
 *   - the narrowest scope Google will give us is asked for first, and the wider one is only
 *     used if the delegation has not been given the read-only scope;
 *   - nothing here can write: the only thing built on this token is a GET of events.list.
 *
 * `buddy-bot` already holds this delegation for the `leave` module, so this adds no power to
 * the service account. It widens which code may use it, which is why it is pinned and logged.
 */

const READONLY_SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly';
const FALLBACK_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ASSERTION_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const LIFETIME_S = 3600;
const EARLY_S = 300;
// Strict on purpose: only ordinary address characters, so nothing wildcard-ish or list-like
// can be configured by mistake and quietly widen what Buddy acts as.
const EMAIL = /^[a-z0-9][a-z0-9._%+-]*@[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/;

const fail = (message, cause) => Object.assign(new Error(message), { expose: true, cause });

/** One address, from configuration, or nothing. Anything else is refused outright. */
function readAs(value) {
  const subject = String(value || '').trim().toLowerCase();
  if (!subject) return null;
  if (!EMAIL.test(subject)) throw fail('OOO_READ_AS must be a single work email address.');
  return subject;
}

function createReadTokens({ auth, fetch: doFetch = fetch, log, now = () => Date.now() }) {
  const cache = new Map();
  let selfEmail = null;
  let widened = false;

  async function serviceAccountEmail() {
    if (!selfEmail) selfEmail = (await auth.getCredentials()).client_email;
    if (!selfEmail) throw fail('Buddy could not work out its own service account identity.');
    return selfEmail;
  }

  async function assertionFor(subject, scope) {
    const email = await serviceAccountEmail();
    const client = await auth.getClient();
    const { token } = await client.getAccessToken();
    const issued = Math.floor(now() / 1000);
    const payload = JSON.stringify({ iss: email, sub: subject, scope, aud: TOKEN_URL, iat: issued, exp: issued + LIFETIME_S });
    const res = await doFetch(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(email)}:signJwt`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload }),
    });
    if (!res.ok) {
      throw fail('Buddy isn\'t allowed to sign its own tokens. Grant buddy-bot the Service Account Token '
        + 'Creator role on itself.', await res.text().catch(() => ''));
    }
    return (await res.json()).signedJwt;
  }

  async function exchange(subject, scope) {
    const res = await doFetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: ASSERTION_TYPE, assertion: await assertionFor(subject, scope) }).toString(),
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, body };
  }

  /**
   * @param subject  the configured mailbox, or null to use buddy-bot's own access
   *                 (for when the calendar can be shared with it directly)
   */
  return async function tokenFor(subject) {
    if (!subject) {
      const client = await auth.getClient();
      const { token } = await client.getAccessToken();
      return token;
    }

    const hit = cache.get(subject);
    if (hit && hit.expiresAt > now()) return hit.token;

    let attempt = await exchange(subject, READONLY_SCOPE);
    if (!attempt.ok && attempt.body.error === 'unauthorized_client') {
      // The delegation only lists calendar.events. It still only ever does a GET here, but
      // say so loudly: adding calendar.events.readonly to the entry removes the write power.
      if (!widened) {
        log.warn('ooo is reading with a writable scope', {
          subject,
          fix: `add ${READONLY_SCOPE} to buddy-bot's domain-wide delegation entry`,
        });
        widened = true;
      }
      attempt = await exchange(subject, FALLBACK_SCOPE);
    }

    if (!attempt.ok) {
      if (attempt.body.error === 'unauthorized_client') {
        throw fail(`Buddy isn't allowed to read ${subject}'s calendar. A Workspace admin needs buddy-bot's `
          + `client id authorised for ${READONLY_SCOPE}.`, attempt.body);
      }
      if (attempt.body.error === 'invalid_grant') throw fail(`Google doesn't recognise ${subject} as an account here.`, attempt.body);
      throw fail('Buddy couldn\'t get access to the OOO calendar.', attempt.body);
    }

    log.info('ooo calendar read', { as: subject });
    cache.set(subject, { token: attempt.body.access_token, expiresAt: now() + (LIFETIME_S - EARLY_S) * 1000 });
    return attempt.body.access_token;
  };
}

module.exports = { createReadTokens, readAs, READONLY_SCOPE, FALLBACK_SCOPE };
