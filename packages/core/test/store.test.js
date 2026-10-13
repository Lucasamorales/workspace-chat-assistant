const test = require('node:test');
const assert = require('node:assert/strict');
const { createFirestoreStore, createMemoryStore } = require('../src/store');

const ALREADY_EXISTS = 6; // the gRPC code Firestore raises from create()

// A small in-memory stand-in for the parts of the Firestore client the store calls. It keeps
// Firestore's own shapes (snapshots with `exists` and `data()`, Timestamps with `toDate()`), so
// what is under test is the real adapter and its conversions, not a simplified copy of it.
function fakeFirestore() {
  const collections = new Map();
  const log = [];
  const stamp = date => ({ toDate: () => date });
  const encode = (value) => {
    if (value instanceof Date) return stamp(value);
    if (Array.isArray(value)) return value.map(encode);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v)]));
    return value;
  };
  // A snapshot is a capture: deleting the document afterwards does not empty it.
  const snapshot = (id, docs) => {
    const exists = docs.has(id);
    const data = docs.get(id);
    return { id, exists, data: () => data };
  };

  const db = {
    log,
    collection(name) {
      if (!collections.has(name)) collections.set(name, new Map());
      const docs = collections.get(name);
      const query = (filter = () => true, field = null, max = Infinity) => ({
        where: (f, op, from) => { assert.equal(op, '>='); return query(d => d[f] >= from, field, max); },
        orderBy: f => query(filter, f, max),
        limit: n => query(filter, field, n),
        async get() {
          const rows = [...docs].filter(([, d]) => filter(d)).sort((a, b) => a[1][field] - b[1][field]).slice(0, max);
          return { docs: rows.map(([id, d]) => ({ id, data: () => d })) };
        },
      });
      return {
        ...query(),
        doc(id) {
          return {
            id,
            docs,
            get: async () => snapshot(id, docs),
            async set(data, opts) {
              log.push({ op: 'set', id, opts });
              docs.set(id, opts && opts.merge && docs.has(id) ? { ...docs.get(id), ...encode(data) } : encode(data));
            },
            delete: async () => { docs.delete(id); },
            async create(data) {
              if (docs.has(id)) throw Object.assign(new Error('exists'), { code: ALREADY_EXISTS });
              docs.set(id, encode(data));
            },
          };
        },
      };
    },
    // Reads and writes inside the callback apply together, as a transaction's would.
    async runTransaction(fn) {
      log.push({ op: 'transaction' });
      return fn({
        get: async ref => snapshot(ref.id, ref.docs),
        set: (ref, data) => { ref.docs.set(ref.id, encode(data)); },
        delete: (ref) => { ref.docs.delete(ref.id); },
      });
    },
  };
  return db;
}

// The same behaviour is expected of both stores: the in-memory one is what every other test
// in the repo runs on, so if the two disagree those tests prove nothing about production.
const stores = {
  firestore: () => createFirestoreStore(fakeFirestore()),
  memory: () => createMemoryStore(),
};

for (const [name, make] of Object.entries(stores)) {
  test(`${name}: get returns what was set, and null for a missing id`, async () => {
    const col = make().collection('c');
    assert.equal(await col.get('a'), null);
    await col.set('a', { n: 1, nested: { list: [1, 2] } });
    assert.deepEqual(await col.get('a'), { n: 1, nested: { list: [1, 2] } });
  });

  test(`${name}: set replaces by default and merges when asked`, async () => {
    const col = make().collection('c');
    await col.set('a', { keep: 1, change: 1 });
    await col.set('a', { change: 2 }, { merge: true });
    assert.deepEqual(await col.get('a'), { keep: 1, change: 2 });
    await col.set('a', { only: true });
    assert.deepEqual(await col.get('a'), { only: true });
  });

  test(`${name}: delete removes the document`, async () => {
    const col = make().collection('c');
    await col.set('a', { n: 1 });
    await col.delete('a');
    assert.equal(await col.get('a'), null);
  });

  test(`${name}: create writes once and reports false the second time, leaving the first intact`, async () => {
    const col = make().collection('c');
    assert.equal(await col.create('a', { first: true }), true);
    assert.equal(await col.create('a', { second: true }), false);
    assert.deepEqual(await col.get('a'), { first: true });
  });

  test(`${name}: take hands a document over exactly once`, async () => {
    const col = make().collection('c');
    await col.set('state', { nonce: 'x' });
    assert.deepEqual(await col.take('state'), { nonce: 'x' });
    assert.equal(await col.take('state'), null);
    assert.equal(await col.get('state'), null);
  });

  test(`${name}: update passes the current value, or null, and stores what the function returns`, async () => {
    const col = make().collection('c');
    assert.deepEqual(await col.update('n', current => ({ count: (current ? current.count : 0) + 1 })), { count: 1 });
    assert.deepEqual(await col.update('n', current => ({ count: current.count + 1 })), { count: 2 });
    assert.deepEqual(await col.get('n'), { count: 2 });
  });

  test(`${name}: an update that returns undefined writes nothing`, async () => {
    const col = make().collection('c');
    await col.set('n', { count: 5 });
    assert.equal(await col.update('n', () => undefined), null);
    assert.deepEqual(await col.get('n'), { count: 5 });
  });

  test(`${name}: list returns documents oldest first, with their ids`, async () => {
    const col = make().collection('c');
    await col.set('late', { at: 30 });
    await col.set('early', { at: 10 });
    await col.set('mid', { at: 20 });
    assert.deepEqual((await col.list()).map(d => d.id), ['early', 'mid', 'late']);
    assert.deepEqual((await col.list())[0], { id: 'early', at: 10 });
  });

  test(`${name}: list can start from a value and stop at a limit`, async () => {
    const col = make().collection('c');
    for (const [id, at] of [['a', 10], ['b', 20], ['c', 30], ['d', 40]]) await col.set(id, { at });
    assert.deepEqual((await col.list({ from: 20 })).map(d => d.id), ['b', 'c', 'd']);
    assert.deepEqual((await col.list({ from: 20, limit: 2 })).map(d => d.id), ['b', 'c']);
    assert.deepEqual((await col.list({ limit: 1 })).map(d => d.id), ['a']);
  });

  test(`${name}: list orders by the field it is given`, async () => {
    const col = make().collection('c');
    await col.set('a', { at: 1, seenAt: 9 });
    await col.set('b', { at: 2, seenAt: 3 });
    assert.deepEqual((await col.list({ field: 'seenAt' })).map(d => d.id), ['b', 'a']);
  });

  test(`${name}: collections do not see each other's documents`, async () => {
    const store = make();
    await store.collection('one').set('a', { n: 1 });
    assert.equal(await store.collection('two').get('a'), null);
  });
}

test('firestore: timestamps come back as Dates, at any depth', async () => {
  const col = createFirestoreStore(fakeFirestore()).collection('c');
  const when = new Date('2026-09-23T13:00:00Z');
  await col.set('a', { expireAt: when, history: [{ at: when }], plain: 'text', none: null });
  const out = await col.get('a');
  assert.ok(out.expireAt instanceof Date);
  assert.equal(out.expireAt.getTime(), when.getTime());
  assert.ok(out.history[0].at instanceof Date);
  assert.equal(out.plain, 'text');
  assert.equal(out.none, null);
  assert.ok((await col.list({ field: 'plain' }))[0].expireAt instanceof Date);
});

test('firestore: take and update run inside a transaction', async () => {
  const db = fakeFirestore();
  const col = createFirestoreStore(db).collection('c');
  await col.set('a', { n: 1 });
  await col.take('a');
  await col.update('b', () => ({ n: 2 }));
  assert.equal(db.log.filter(entry => entry.op === 'transaction').length, 2);
});

test('firestore: set always states whether it merges', async () => {
  const db = fakeFirestore();
  const col = createFirestoreStore(db).collection('c');
  await col.set('a', { n: 1 });
  await col.set('a', { m: 2 }, { merge: true });
  assert.deepEqual(db.log.map(entry => entry.opts), [{ merge: false }, { merge: true }]);
});

test('firestore: a create that fails for any other reason is not mistaken for "already exists"', async () => {
  const db = fakeFirestore();
  const broken = { collection: () => ({ doc: () => ({ create: async () => { throw Object.assign(new Error('unavailable'), { code: 14 }); } }) }) };
  await assert.rejects(createFirestoreStore(broken).collection('c').create('a', {}), /unavailable/);
  assert.equal(db.log.length, 0);
});

test('memory: what is read back is a copy, so a caller cannot change the store by mutating it', async () => {
  const col = createMemoryStore().collection('c');
  const original = { list: [1] };
  await col.set('a', original);
  original.list.push(2);
  const read = await col.get('a');
  read.list.push(3);
  assert.deepEqual(await col.get('a'), { list: [1] });
});

test('memory: dump shows every collection, for assertions in other tests', async () => {
  const store = createMemoryStore();
  await store.collection('one').set('a', { n: 1 });
  await store.collection('two').set('b', { n: 2 });
  assert.deepEqual(store.dump(), { one: { a: { n: 1 } }, two: { b: { n: 2 } } });
});
