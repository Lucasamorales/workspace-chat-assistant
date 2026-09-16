/**
 * Encrypts small secrets (e.g. OAuth tokens) before they are stored.
 *
 * Every seal/open takes a `context` string such as "asana:12345". It is bound into the
 * ciphertext as authenticated data, so a token copied onto another user's record, or
 * into another module, fails to decrypt.
 */

const crypto = require('crypto');

/** Production: Cloud KMS. The key material never leaves KMS. */
function createKmsSealer({ kmsClient, keyName }) {
  return {
    async seal(value, context) {
      const [res] = await kmsClient.encrypt({
        name: keyName,
        plaintext: Buffer.from(JSON.stringify(value)),
        additionalAuthenticatedData: Buffer.from(context),
      });
      return Buffer.from(res.ciphertext).toString('base64');
    },
    async open(sealed, context) {
      const [res] = await kmsClient.decrypt({
        name: keyName,
        ciphertext: Buffer.from(sealed, 'base64'),
        additionalAuthenticatedData: Buffer.from(context),
      });
      return JSON.parse(Buffer.from(res.plaintext).toString());
    },
  };
}

/** Tests and local runs only: AES-256-GCM with an in-memory key. */
function createLocalSealer(key = crypto.randomBytes(32)) {
  return {
    async seal(value, context) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(context));
      const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
    },
    async open(sealed, context) {
      const buf = Buffer.from(sealed, 'base64');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
      decipher.setAAD(Buffer.from(context));
      decipher.setAuthTag(buf.subarray(12, 28));
      return JSON.parse(Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString());
    },
  };
}

module.exports = { createKmsSealer, createLocalSealer };
