const test = require('node:test');
const assert = require('node:assert/strict');
const { createPeople, createMemoryStore } = require('../src');

test('people: remembered by lower-cased email, with the Chat id and the DM', async () => {
  const people = createPeople({ store: createMemoryStore(), now: () => Date.parse('2026-10-07T12:00:00Z') });
  await people.remember({ email: ' Accounts@Example.com ', userId: 987, space: 'spaces/dm-acc' });
  assert.deepEqual(await people.find('accounts@example.com'), {
    email: 'accounts@example.com', userId: '987', space: 'spaces/dm-acc', seenAt: '2026-10-07T12:00:00.000Z',
  });
  assert.equal(await people.find('nobody@example.com'), null);
});

test('people: one write per person until something changes; nothing saved without an id and a space', async () => {
  const store = createMemoryStore();
  let writes = 0;
  const counting = { collection: name => { const c = store.collection(name); return { ...c, set: async (...a) => { writes += 1; return c.set(...a); } }; } };
  const people = createPeople({ store: counting });
  const me = { email: 'robin@example.com', userId: '111', space: 'spaces/dm1' };
  await people.remember(me);
  await people.remember(me);
  await people.remember(me);
  assert.equal(writes, 1, 'a busy chat is not a write per message');
  await people.remember({ ...me, space: 'spaces/dm2' });
  assert.equal(writes, 2, 'a new DM is saved');
  assert.equal((await people.find(me.email)).space, 'spaces/dm2');

  await people.remember({ email: 'x@example.com', userId: '', space: 'spaces/a' });
  await people.remember({ email: 'x@example.com', userId: '5', space: '' });
  await people.remember({ email: 'not-an-email', userId: '5', space: 'spaces/a' });
  assert.equal(writes, 2);
});
