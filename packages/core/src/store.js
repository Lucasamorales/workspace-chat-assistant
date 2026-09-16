/**
 * Tiny storage interface so core and modules never touch Firestore directly.
 *
 *   collection(name) → {
 *     get(id)                 → data | null
 *     set(id, data, {merge})
 *     delete(id)
 *     create(id, data)        → true, or false if the id already exists (atomic)
 *     take(id)                → data | null, and deletes it in the same transaction (single use)
 *     update(id, fn)          → fn(current|null) returns next data, written in a transaction
 *   }
 *
 * Documents may carry `expireAt` (a Date). Firestore TTL policies delete them after that
 * time; TTL deletion is lazy, so readers must still check `expireAt` themselves.
 */

const ALREADY_EXISTS = 6; // gRPC status code

function fromFirestore(value) {
  if (value === null || typeof value !== 'object') return value;
  if (typeof value.toDate === 'function') return value.toDate();
  if (Array.isArray(value)) return value.map(fromFirestore);
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = fromFirestore(v);
  return out;
}

function createFirestoreStore(db) {
  return {
    collection(name) {
      const col = db.collection(name);
      return {
        async get(id) {
          const snap = await col.doc(id).get();
          return snap.exists ? fromFirestore(snap.data()) : null;
        },
        async set(id, data, opts = {}) {
          await col.doc(id).set(data, { merge: Boolean(opts.merge) });
        },
        async delete(id) {
          await col.doc(id).delete();
        },
        async create(id, data) {
          try {
            await col.doc(id).create(data);
            return true;
          } catch (e) {
            if (e.code === ALREADY_EXISTS) return false;
            throw e;
          }
        },
        take(id) {
          return db.runTransaction(async tx => {
            const ref = col.doc(id);
            const snap = await tx.get(ref);
            if (!snap.exists) return null;
            tx.delete(ref);
            return fromFirestore(snap.data());
          });
        },
        update(id, fn) {
          return db.runTransaction(async tx => {
            const ref = col.doc(id);
            const snap = await tx.get(ref);
            const next = fn(snap.exists ? fromFirestore(snap.data()) : null);
            if (next === undefined) return null;
            tx.set(ref, next);
            return next;
          });
        },
      };
    },
  };
}

function createMemoryStore() {
  const collections = new Map();
  const clone = v => (v === undefined ? v : structuredClone(v));
  return {
    dump: () => Object.fromEntries([...collections].map(([k, m]) => [k, Object.fromEntries(m)])),
    collection(name) {
      if (!collections.has(name)) collections.set(name, new Map());
      const docs = collections.get(name);
      return {
        async get(id) { return docs.has(id) ? clone(docs.get(id)) : null; },
        async set(id, data, opts = {}) {
          docs.set(id, clone(opts.merge && docs.has(id) ? { ...docs.get(id), ...data } : data));
        },
        async delete(id) { docs.delete(id); },
        async create(id, data) {
          if (docs.has(id)) return false;
          docs.set(id, clone(data));
          return true;
        },
        async take(id) {
          if (!docs.has(id)) return null;
          const data = docs.get(id);
          docs.delete(id);
          return clone(data);
        },
        async update(id, fn) {
          const next = fn(docs.has(id) ? clone(docs.get(id)) : null);
          if (next === undefined) return null;
          docs.set(id, clone(next));
          return clone(next);
        },
      };
    },
  };
}

/** A view of `store` where every collection name is prefixed, e.g. m_asana__tokens. */
function scopeStore(store, prefix) {
  if (!/^[a-z][a-z0-9_]*$/.test(prefix)) throw new Error(`invalid store prefix "${prefix}"`);
  return { collection: name => store.collection(`${prefix}__${name}`) };
}

module.exports = { createFirestoreStore, createMemoryStore, scopeStore };
