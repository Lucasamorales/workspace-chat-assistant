/**
 * The index, in Firestore.
 *
 * Chunks are stored per document, in parts, for two reasons. Re-indexing one policy touches
 * only that document's parts. And indexing cannot finish inside one Chat command — 40 documents
 * take minutes, a command has twenty seconds — so the work is done in slices across several
 * runs, and per-document storage is what makes that resumable.
 *
 * The live index only changes when a run finishes: while a reindex is in progress, questions
 * keep being answered from the previous version rather than from half a manual.
 */

const META = 'meta';
const JOB = 'job';
const PER_PART = 25;

const partId = (fileId, n) => `part-${fileId}-${n}`;

function createIndexStore({ store, now = () => Date.now() }) {
  const col = store.collection('index');
  let cached = { version: null, chunks: [] };

  const emptyMeta = () => ({ version: null, files: {}, skipped: [], model: null, chunks: 0, updatedAt: null });

  async function writeParts(fileId, chunks, previousParts = 0) {
    const parts = [];
    for (let i = 0; i < chunks.length; i += PER_PART) parts.push(chunks.slice(i, i + PER_PART));
    for (const [i, group] of parts.entries()) await col.set(partId(fileId, i), { fileId, chunks: group });
    for (let i = parts.length; i < previousParts; i += 1) await col.delete(partId(fileId, i));
    return parts.length;
  }

  async function dropParts(fileId, parts) {
    for (let i = 0; i < (parts || 0); i += 1) await col.delete(partId(fileId, i));
  }

  return {
    async meta() { return (await col.get(META)) || emptyMeta(); },
    async job() { return col.get(JOB); },
    async saveJob(job) { await col.set(JOB, job); },
    async clearJob() { await col.delete(JOB); },

    /** One document's chunks, replacing whatever was there before. */
    saveFile: (fileId, chunks, previousParts) => writeParts(fileId, chunks, previousParts),
    removeFile: (fileId, parts) => dropParts(fileId, parts),

    /** Makes everything written so far the version questions are answered from. */
    async publish({ files, skipped, model }) {
      const meta = {
        version: String(now()),
        files,
        skipped,
        model,
        chunks: Object.values(files).reduce((n, f) => n + (f.chunks || 0), 0),
        updatedAt: new Date(now()).toISOString(),
      };
      await col.set(META, meta);
      cached = { version: null, chunks: [] }; // force a reload; the parts changed underneath us
      return meta;
    },

    /** Every chunk with its vector, from memory unless the index changed underneath us. */
    async load() {
      const meta = await this.meta();
      if (!meta.version) return [];
      if (cached.version === meta.version) return cached.chunks;

      const chunks = [];
      for (const [fileId, file] of Object.entries(meta.files || {})) {
        for (let i = 0; i < (file.parts || 0); i += 1) {
          const part = await col.get(partId(fileId, i));
          if (part && part.chunks) chunks.push(...part.chunks);
        }
      }
      cached = { version: meta.version, chunks };
      return chunks;
    },
  };
}

module.exports = { createIndexStore, PER_PART };
