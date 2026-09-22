/**
 * The index, in Firestore.
 *
 * Chunks are packed into shards rather than stored one per document: a question would otherwise
 * mean a thousand reads. The meta document carries a version that changes on every reindex, so
 * a running instance knows when its in-memory copy is stale without polling the whole index.
 */

const META = 'meta';
const PER_SHARD = 40;

const shardId = n => `shard-${String(n).padStart(4, '0')}`;

function createIndexStore({ store, now = () => Date.now() }) {
  const col = store.collection('index');
  let cached = { version: null, chunks: [] };

  return {
    async meta() {
      return (await col.get(META)) || { version: null, files: {}, chunks: 0, shards: 0, updatedAt: null };
    },

    /** Replaces the whole index in one go: partial indexes answer questions wrongly. */
    async replace({ chunks, files, skipped, model }) {
      const previous = await this.meta();
      const shards = [];
      for (let i = 0; i < chunks.length; i += PER_SHARD) shards.push(chunks.slice(i, i + PER_SHARD));

      for (const [i, group] of shards.entries()) await col.set(shardId(i), { chunks: group });
      // Drop shards left over from a bigger previous index.
      for (let i = shards.length; i < (previous.shards || 0); i += 1) await col.delete(shardId(i));

      const meta = {
        version: String(now()),
        files,
        skipped,
        model,
        chunks: chunks.length,
        shards: shards.length,
        updatedAt: new Date(now()).toISOString(),
      };
      await col.set(META, meta);
      cached = { version: meta.version, chunks };
      return meta;
    },

    /** Every chunk with its vector, from memory unless the index changed underneath us. */
    async load() {
      const meta = await this.meta();
      if (!meta.version) return [];
      if (cached.version === meta.version) return cached.chunks;

      const chunks = [];
      for (let i = 0; i < (meta.shards || 0); i += 1) {
        const shard = await col.get(shardId(i));
        if (shard && shard.chunks) chunks.push(...shard.chunks);
      }
      cached = { version: meta.version, chunks };
      return chunks;
    },
  };
}

module.exports = { createIndexStore, PER_SHARD };
