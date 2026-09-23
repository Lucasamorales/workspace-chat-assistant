/**
 * Turning text into vectors, with Vertex AI, as `buddy-bot`.
 *
 * No API key: the service account's own identity is the credential. Documents and questions are
 * embedded with different task types — Google's models are trained to put a question near the
 * passage that answers it, which only works if you say which is which.
 */

const DEFAULT_MODEL = 'text-multilingual-embedding-002';
const DEFAULT_REGION = 'europe-west1';
const BATCH = 25;           // Vertex accepts up to 250 instances; small batches keep errors readable
const DIMENSIONS = 768;

const fail = (message, cause) => Object.assign(new Error(message), { expose: true, cause });

function createEmbeddings({ tokenFor, projectId, region = DEFAULT_REGION, model = DEFAULT_MODEL, fetch: doFetch = fetch }) {
  const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}`
    + `/locations/${region}/publishers/google/models/${model}:predict`;

  async function embed(texts, taskType) {
    if (!texts.length) return [];
    const token = await tokenFor();
    const res = await doFetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ instances: texts.map(content => ({ content, task_type: taskType })) }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (res.status === 403) {
        throw fail('Buddy isn\'t allowed to use Vertex AI yet. Enable aiplatform.googleapis.com and give '
          + 'buddy-bot the Vertex AI User role.', body);
      }
      if (res.status === 429) throw fail('Vertex AI is rate-limiting us. Try the reindex again in a minute.', body);
      throw fail('Buddy couldn\'t work out the meaning of that text (Vertex AI refused).', body);
    }
    const data = await res.json();
    return (data.predictions || []).map(p => p.embeddings.values);
  }

  // Characters embedded since this client was built, so a reindex can report what it cost.
  let characters = 0;

  return {
    model,
    dimensions: DIMENSIONS,
    get characters() { return characters; },

    /** Passages being stored. */
    async forDocuments(texts) {
      const out = [];
      for (let i = 0; i < texts.length; i += BATCH) {
        const batch = texts.slice(i, i + BATCH);
        out.push(...await embed(batch, 'RETRIEVAL_DOCUMENT'));
        characters += batch.reduce((n, t) => n + t.length, 0);
      }
      return out;
    },

    /** A question being asked. */
    async forQuery(text) {
      characters += String(text).length;
      const [vector] = await embed([text], 'RETRIEVAL_QUERY');
      if (!vector) throw fail('Buddy couldn\'t work out what that question is about.');
      return vector;
    },
  };
}

module.exports = { createEmbeddings, DEFAULT_MODEL, DEFAULT_REGION };
