/**
 * A cache of answers the manual has already given.
 *
 * Eighty people will ask "how many holidays do I get?" and deserve the same answer; only the
 * first should cost anything. The key is the question's embedding — the vector retrieval needs
 * anyway — so the same question in other words still hits.
 *
 * What is stored is deliberately not a record of who asked what: a hash of the question, its
 * vector, and the answer. No text of the question, no user, no time of day beyond a date used
 * for eviction (see docs/decisions/0006-costs.md).
 *
 * Every entry carries the index version it was written from, so publishing a new index retires
 * every answer that came out of the old one — a stale policy is worse than a slow one.
 */

const crypto = require('node:crypto');

const HIT = 0.95;        // near-identical question; below this the difference in wording may matter
const MAX = 100;         // entries kept, oldest evicted: the long tail is not worth the storage
const PER_PART = 25;     // entries per Firestore document, which has a 1MB limit
const PLACES = 4;        // rounding the vector: plenty for a 0.95 threshold, a third of the size

const partId = n => `answers-${n}`;

const normalise = text => String(text).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
const hashOf = text => crypto.createHash('sha256').update(normalise(text)).digest('hex').slice(0, 16);
const round = vector => vector.map(n => Number(n.toFixed(PLACES)));

const dot = (a, b) => {
  let sum = 0;
  for (let i = 0; i < a.length && i < b.length; i += 1) sum += a[i] * b[i];
  return sum;
};
const norm = v => Math.sqrt(dot(v, v)) || 1;
const similarity = (a, b) => dot(a, b) / (norm(a) * norm(b));

function createAnswerCache({ store, now = () => Date.now(), max = MAX, threshold = HIT } = {}) {
  const col = store.collection('index');
  let memo = { version: null, entries: null };

  async function entriesFor(version) {
    if (memo.version === version && memo.entries) return memo.entries;
    const entries = [];
    for (let n = 0; n * PER_PART < max; n += 1) {
      const part = await col.get(partId(n));
      if (!part) break;
      entries.push(...(part.entries || []));
    }
    // An entry from an older index is dead weight, not an answer: drop it on the way in.
    memo = { version, entries: entries.filter(e => e.version === version) };
    return memo.entries;
  }

  async function write(entries) {
    for (let n = 0; n * PER_PART < max; n += 1) {
      const slice = entries.slice(n * PER_PART, (n + 1) * PER_PART);
      if (slice.length) await col.set(partId(n), { entries: slice });
      else await col.delete(partId(n));
    }
  }

  return {
    threshold,

    /** How many answers are remembered for this index. Cheap: a miss stops before any embedding. */
    async count(version) { return version ? (await entriesFor(version)).length : 0; },

    /** The answer already given to this question, or null. Never throws: a miss is free, an error is not. */
    async find({ vector, version }) {
      if (!version || !vector) return null;
      const entries = await entriesFor(version);
      let best = null;
      for (const entry of entries) {
        const score = similarity(vector, entry.vector);
        if (score >= threshold && (!best || score > best.score)) best = { ...entry, score };
      }
      return best;
    },

    /**
     * Remember an answer. The same question twice replaces the older entry rather than growing
     * the cache, and the oldest entries fall off the end once it is full.
     */
    async remember({ question, vector, answer, version }) {
      if (!version || !vector || !answer) return null;
      const entry = { id: hashOf(question), vector: round(vector), answer, version, at: new Date(now()).toISOString() };
      const kept = (await entriesFor(version)).filter(e => e.id !== entry.id);
      const entries = [...kept, entry].slice(-max);
      await write(entries);
      memo = { version, entries };
      return entry;
    },

    /** Everything, whatever version it came from. For /manual reindex and tests. */
    async clear() {
      for (let n = 0; n * PER_PART < max; n += 1) await col.delete(partId(n));
      memo = { version: null, entries: null };
    },
  };
}

module.exports = { createAnswerCache, hashOf, similarity, HIT, PER_PART };
