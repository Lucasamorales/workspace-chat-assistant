/** Short-lived HMAC-signed tokens: base64url(JSON payload + exp) "." base64url(HMAC-SHA256). */

const crypto = require('crypto');

const MIN_SECRET_LENGTH = 32;

function hmac(body, secret) {
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`signing secret must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  return crypto.createHmac('sha256', secret).update(body).digest('base64url');
}

/** Sign `payload` so it can be handed to a browser and trusted on return, for `ttlMs`. */
function signToken(payload, secret, ttlMs, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: now + ttlMs })).toString('base64url');
  return `${body}.${hmac(body, secret)}`;
}

/**
 * Return the payload of a token made by `signToken`, or throw if it is malformed,
 * tampered with or expired. The signature is compared in constant time.
 */
function verifyToken(token, secret, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 2048) throw new Error('malformed token');
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('malformed token');

  const given = Buffer.from(parts[1]);
  const expected = Buffer.from(hmac(parts[0], secret));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    throw new Error('bad token signature');
  }

  const data = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
  if (typeof data.exp !== 'number' || now > data.exp) throw new Error('token expired');
  return data;
}

module.exports = { signToken, verifyToken };
