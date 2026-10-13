const test = require('node:test');
const assert = require('node:assert/strict');
const { createEmbeddings, DEFAULT_MODEL, DEFAULT_REGION } = require('../src/embeddings');

// A stand-in for Vertex AI's predict endpoint: answers one vector per instance and records
// what it was sent, so the request the real client builds can be read back.
function vertex({ status = 200, body = null } = {}) {
  const calls = [];
  const doFetch = async (url, init) => {
    const sent = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, instances: sent.instances });
    if (status !== 200) return { ok: false, status, text: async () => 'upstream said no' };
    return {
      ok: true,
      status,
      json: async () => body || { predictions: sent.instances.map((_, i) => ({ embeddings: { values: [i, calls.length] } })) },
    };
  };
  return { calls, doFetch };
}

function client(options = {}) {
  const fake = vertex(options);
  const embeddings = createEmbeddings({ tokenFor: async () => 'tok', projectId: 'p1', fetch: fake.doFetch });
  return { embeddings, calls: fake.calls };
}

test('a question is sent as a query, to the model in the configured project and region', async () => {
  const { embeddings, calls } = client();
  assert.deepEqual(await embeddings.forQuery('how much leave do I get?'), [0, 1]);
  assert.equal(calls[0].url,
    `https://${DEFAULT_REGION}-aiplatform.googleapis.com/v1/projects/p1/locations/${DEFAULT_REGION}`
    + `/publishers/google/models/${DEFAULT_MODEL}:predict`);
  assert.equal(calls[0].headers.Authorization, 'Bearer tok');
  assert.deepEqual(calls[0].instances, [{ content: 'how much leave do I get?', task_type: 'RETRIEVAL_QUERY' }]);
});

test('passages are sent as documents, which is what lets a question land near its answer', async () => {
  const { embeddings, calls } = client();
  await embeddings.forDocuments(['a', 'b']);
  assert.deepEqual(calls[0].instances.map(i => i.task_type), ['RETRIEVAL_DOCUMENT', 'RETRIEVAL_DOCUMENT']);
});

test('many passages go in batches of 25 and come back in order', async () => {
  const { embeddings, calls } = client();
  const texts = Array.from({ length: 60 }, (_, i) => `passage ${i}`);
  const vectors = await embeddings.forDocuments(texts);
  assert.deepEqual(calls.map(c => c.instances.length), [25, 25, 10]);
  assert.equal(vectors.length, 60);
  // [index within the batch, which batch]: order across batches is preserved.
  assert.deepEqual(vectors[0], [0, 1]);
  assert.deepEqual(vectors[25], [0, 2]);
  assert.deepEqual(vectors[59], [9, 3]);
});

test('nothing to embed makes no request', async () => {
  const { embeddings, calls } = client();
  assert.deepEqual(await embeddings.forDocuments([]), []);
  assert.equal(calls.length, 0);
});

test('it counts the characters it embedded, so a reindex can report what it cost', async () => {
  const { embeddings } = client();
  assert.equal(embeddings.characters, 0);
  await embeddings.forDocuments(['abc', 'de']);
  await embeddings.forQuery('wxyz');
  assert.equal(embeddings.characters, 9);
});

test('the model and its vector size are exposed for the index to record', () => {
  const { embeddings } = client();
  assert.equal(embeddings.model, DEFAULT_MODEL);
  assert.equal(embeddings.dimensions, 768);
});

test('a 403 says which API to enable and which role is missing', async () => {
  const { embeddings } = client({ status: 403 });
  await assert.rejects(embeddings.forQuery('q'), (error) => {
    assert.match(error.message, /aiplatform\.googleapis\.com/);
    assert.match(error.message, /Vertex AI User/);
    assert.equal(error.expose, true);
    assert.equal(error.cause, 'upstream said no');
    return true;
  });
});

test('a 429 asks for a retry rather than reporting a failure', async () => {
  const { embeddings } = client({ status: 429 });
  await assert.rejects(embeddings.forDocuments(['a']), /rate-limiting us/);
});

test('any other refusal is reported in plain words, with the upstream body kept as the cause', async () => {
  const { embeddings } = client({ status: 500 });
  await assert.rejects(embeddings.forQuery('q'), (error) => {
    assert.match(error.message, /Vertex AI refused/);
    assert.equal(error.cause, 'upstream said no');
    return true;
  });
});

test('a reply with no vector for the question is an error, not an undefined vector', async () => {
  const { embeddings } = client({ body: { predictions: [] } });
  await assert.rejects(embeddings.forQuery('q'), /couldn't work out what that question is about/);
});

test('a reply with no predictions field embeds nothing', async () => {
  const { embeddings } = client({ body: {} });
  assert.deepEqual(await embeddings.forDocuments(['a']), []);
});

test('the region and model can be overridden', async () => {
  const fake = vertex();
  const embeddings = createEmbeddings({
    tokenFor: async () => 't', projectId: 'p2', region: 'us-central1', model: 'm-1', fetch: fake.doFetch,
  });
  await embeddings.forQuery('q');
  assert.equal(fake.calls[0].url,
    'https://us-central1-aiplatform.googleapis.com/v1/projects/p2/locations/us-central1/publishers/google/models/m-1:predict');
});
