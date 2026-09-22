/**
 * Finding the chunks that answer a question.
 *
 * The corpus is a company manual, not the web: a few thousand chunks at most, so comparing
 * against all of them in memory is both simpler and faster than any index we could add, and
 * costs nothing. Vectors are already normalised by Vertex, so a dot product is the cosine.
 */

const TOP_K = 6;
const PER_FILE = 2;      // spread hits across documents: three policies beat three bits of one
const FLOOR = 0.35;      // below this the match is noise, and a wrong quote is worse than none

const dot = (a, b) => {
  let sum = 0;
  for (let i = 0; i < a.length && i < b.length; i += 1) sum += a[i] * b[i];
  return sum;
};

const norm = v => Math.sqrt(dot(v, v)) || 1;

/** Cosine similarity, tolerant of vectors that arrive un-normalised. */
const similarity = (a, b) => dot(a, b) / (norm(a) * norm(b));

/**
 * @param chunks  [{ vector, text, title, section, link, heading, fileId }]
 * @returns the best matches, at most `perFile` from any one document
 */
function search(chunks, queryVector, { topK = TOP_K, perFile = PER_FILE, floor = FLOOR } = {}) {
  const scored = chunks
    .map(chunk => ({ ...chunk, score: similarity(queryVector, chunk.vector) }))
    .filter(chunk => chunk.score >= floor)
    .sort((a, b) => b.score - a.score);

  const taken = new Map();
  const hits = [];
  for (const chunk of scored) {
    const used = taken.get(chunk.fileId) || 0;
    if (used >= perFile) continue;
    taken.set(chunk.fileId, used + 1);
    hits.push(chunk);
    if (hits.length >= topK) break;
  }
  return hits.map(({ vector, ...hit }) => hit);
}

module.exports = { search, similarity, TOP_K, FLOOR };
