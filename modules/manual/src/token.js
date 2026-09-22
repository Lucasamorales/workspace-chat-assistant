/**
 * Tokens with the scopes Drive actually wants.
 *
 * On Cloud Run, a service account's automatic token is scoped to `cloud-platform`. Vertex AI
 * accepts that; the Drive API does not — it wants a Drive scope, and refuses with 403 otherwise,
 * which looks exactly like "the folder isn't shared with me".
 *
 * `buddy-bot` can mint its own scoped tokens through the IAM Credentials API, because it holds
 * Service Account Token Creator on itself (added for the `leave` module). No key is involved:
 * it authenticates as itself to ask for a narrower version of itself.
 */

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const CLOUD_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const EARLY_MS = 5 * 60 * 1000;

const fail = (message, cause) => Object.assign(new Error(message), { expose: true, cause });

function createTokens({ auth, fetch: doFetch = fetch, log, now = () => Date.now() }) {
  const cache = new Map();
  let selfEmail = null;

  const ownToken = async () => {
    const client = await auth.getClient();
    const { token } = await client.getAccessToken();
    return token;
  };

  async function serviceAccountEmail() {
    if (!selfEmail) selfEmail = (await auth.getCredentials()).client_email;
    if (!selfEmail) throw fail('Buddy could not work out its own service account identity.');
    return selfEmail;
  }

  /** A token for buddy-bot, narrowed to one scope. */
  async function scoped(scope) {
    const hit = cache.get(scope);
    if (hit && hit.expiresAt > now()) return hit.token;

    const email = await serviceAccountEmail();
    const res = await doFetch(
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(email)}:generateAccessToken`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${await ownToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: [scope], lifetime: '3600s' }),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log.warn('could not mint a scoped token', { scope, status: res.status, body });
      throw fail('Buddy can\'t give itself permission to read Drive. Grant buddy-bot the Service Account '
        + 'Token Creator role on itself, and enable iamcredentials.googleapis.com.', body);
    }
    const { accessToken, expireTime } = await res.json();
    const expiresAt = (Date.parse(expireTime) || (now() + 3600_000)) - EARLY_MS;
    cache.set(scope, { token: accessToken, expiresAt });
    return accessToken;
  }

  return {
    forDrive: () => scoped(DRIVE_SCOPE),
    // Vertex is happy with the identity Cloud Run already provides.
    forVertex: () => ownToken(),
  };
}

module.exports = { createTokens, DRIVE_SCOPE, CLOUD_SCOPE };
