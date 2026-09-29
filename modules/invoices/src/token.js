/**
 * A Drive-scoped token for buddy-bot, minted keylessly.
 *
 * On Cloud Run the automatic token is scoped to `cloud-platform`, which the Drive API refuses
 * with a 403 that looks exactly like "the folder isn't shared". buddy-bot can ask the IAM
 * Credentials API for a narrower token of itself, because it holds Service Account Token
 * Creator on itself. The same approach as the manual module — its own copy, since modules never
 * import each other.
 */

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const EARLY_MS = 5 * 60 * 1000;

const fail = (message, cause) => Object.assign(new Error(message), { expose: true, cause });

function createTokens({ auth, fetch: doFetch = fetch, log, now = () => Date.now() }) {
  let cached = null;
  let selfEmail = null;

  async function forDrive() {
    if (cached && cached.expiresAt > now()) return cached.token;
    if (!selfEmail) selfEmail = (await auth.getCredentials()).client_email;
    if (!selfEmail) throw fail('Buddy could not work out its own service account identity.');
    const { token: own } = await (await auth.getClient()).getAccessToken();

    const res = await doFetch(
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(selfEmail)}:generateAccessToken`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${own}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: [DRIVE_SCOPE], lifetime: '3600s' }),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log.warn('could not mint a Drive token', { status: res.status, body });
      throw fail('Buddy can\'t give itself permission to read Drive. It needs the Service Account Token Creator '
        + 'role on itself, and iamcredentials.googleapis.com enabled.', body);
    }
    const { accessToken, expireTime } = await res.json();
    cached = { token: accessToken, expiresAt: (Date.parse(expireTime) || (now() + 3600_000)) - EARLY_MS };
    return accessToken;
  }

  return { forDrive };
}

module.exports = { createTokens, DRIVE_SCOPE };
