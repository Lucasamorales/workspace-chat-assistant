const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createKmsSealer, createLocalSealer } = require('../src/sealer');

const KEY = 'projects/p/locations/l/keyRings/r/cryptoKeys/tokens';

// A stand-in for the Cloud KMS client with KMS's own request and reply shapes. Like KMS, it
// refuses to decrypt unless the additional authenticated data matches what was sealed with.
function fakeKms() {
  const key = crypto.randomBytes(32);
  const calls = [];
  return {
    calls,
    async encrypt({ name, plaintext, additionalAuthenticatedData }) {
      calls.push({ op: 'encrypt', name, aad: additionalAuthenticatedData.toString() });
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(additionalAuthenticatedData);
      const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return [{ ciphertext: Buffer.concat([iv, cipher.getAuthTag(), body]) }];
    },
    async decrypt({ name, ciphertext, additionalAuthenticatedData }) {
      calls.push({ op: 'decrypt', name, aad: additionalAuthenticatedData.toString() });
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, ciphertext.subarray(0, 12));
      decipher.setAAD(additionalAuthenticatedData);
      decipher.setAuthTag(ciphertext.subarray(12, 28));
      return [{ plaintext: Buffer.concat([decipher.update(ciphertext.subarray(28)), decipher.final()]) }];
    },
  };
}

const sealers = {
  kms: () => createKmsSealer({ kmsClient: fakeKms(), keyName: KEY }),
  local: () => createLocalSealer(),
};

for (const [name, make] of Object.entries(sealers)) {
  test(`${name}: what is sealed opens to the same value`, async () => {
    const sealer = make();
    const token = { access_token: 'a', refresh_token: 'r', expires_at: 1790000000, scopes: ['x', 'y'] };
    assert.deepEqual(await sealer.open(await sealer.seal(token, 'asana:111'), 'asana:111'), token);
  });

  test(`${name}: the sealed form is text that does not contain the secret`, async () => {
    const sealed = await make().seal({ access_token: 'super-secret-value' }, 'asana:111');
    assert.equal(typeof sealed, 'string');
    assert.ok(!sealed.includes('super-secret-value'));
    assert.ok(!Buffer.from(sealed, 'base64').toString().includes('super-secret-value'));
  });

  test(`${name}: a token copied onto another user's record does not open`, async () => {
    const sealer = make();
    const sealed = await sealer.seal({ access_token: 'a' }, 'asana:111');
    await assert.rejects(sealer.open(sealed, 'asana:222'));
  });

  test(`${name}: a token copied into another module does not open`, async () => {
    const sealer = make();
    const sealed = await sealer.seal({ access_token: 'a' }, 'asana:111');
    await assert.rejects(sealer.open(sealed, 'kudos:111'));
  });

  test(`${name}: a sealed value that has been altered does not open`, async () => {
    const sealer = make();
    const bytes = Buffer.from(await sealer.seal({ access_token: 'a' }, 'asana:111'), 'base64');
    bytes[bytes.length - 1] ^= 1;
    await assert.rejects(sealer.open(bytes.toString('base64'), 'asana:111'));
  });

  test(`${name}: sealing the same value twice gives different ciphertext`, async () => {
    const sealer = make();
    assert.notEqual(await sealer.seal({ t: 1 }, 'c'), await sealer.seal({ t: 1 }, 'c'));
  });
}

test('kms: every call names the configured key and passes the context as authenticated data', async () => {
  const kmsClient = fakeKms();
  const sealer = createKmsSealer({ kmsClient, keyName: KEY });
  await sealer.open(await sealer.seal({ t: 1 }, 'asana:111'), 'asana:111');
  assert.deepEqual(kmsClient.calls, [
    { op: 'encrypt', name: KEY, aad: 'asana:111' },
    { op: 'decrypt', name: KEY, aad: 'asana:111' },
  ]);
});

test('kms: a failure from KMS is passed on, not swallowed', async () => {
  const kmsClient = { encrypt: async () => { throw new Error('PERMISSION_DENIED'); } };
  await assert.rejects(createKmsSealer({ kmsClient, keyName: KEY }).seal({ t: 1 }, 'c'), /PERMISSION_DENIED/);
});

test('local: a value sealed with one key does not open with another', async () => {
  const sealed = await createLocalSealer().seal({ t: 1 }, 'c');
  await assert.rejects(createLocalSealer().open(sealed, 'c'));
});

test('local: the same key opens what an earlier sealer made', async () => {
  const key = crypto.randomBytes(32);
  const sealed = await createLocalSealer(key).seal({ t: 1 }, 'c');
  assert.deepEqual(await createLocalSealer(key).open(sealed, 'c'), { t: 1 });
});
