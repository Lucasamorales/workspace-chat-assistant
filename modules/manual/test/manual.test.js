const test = require('node:test');
const assert = require('node:assert/strict');
const { validateModule, createMemoryStore } = require('@buddy/core');
const { createManualModule } = require('../src/module');
const { chunk, chunksOf, asContext } = require('../src/text');
const { search, similarity } = require('../src/search');
const { createDrive } = require('../src/drive');
const { createTokens } = require('../src/token');

const DOC = 'application/vnd.google-apps.document';
const NOW = Date.parse('2026-09-22T10:00:00Z');

const file = (id, name, extra = {}) => ({
  id, name, mimeType: DOC, modifiedTime: '2026-09-01T00:00:00Z',
  webViewLink: `https://docs.google.com/document/d/${id}`, section: 'Policies 2026', ...extra,
});

/** Embeddings that encode which words a text contains, so similarity is predictable in tests. */
const WORDS = ['holiday', 'expenses', 'laptop', 'parental', 'remote'];
const fakeVector = text => WORDS.map(w => (String(text).toLowerCase().includes(w) ? 1 : 0));
const fakeEmbeddings = {
  model: 'fake-embeddings',
  forDocuments: async texts => texts.map(fakeVector),
  forQuery: async text => fakeVector(text),
};

function fakeDrive(files, texts) {
  return {
    folderId: 'folder1',
    list: async () => files,
    // Like the real one: without knowing the file's type there is no way to export it.
    textOf: async f => (f.mimeType === DOC || /^text\//.test(f.mimeType || '') ? texts[f.id] || null : null),
    supported: f => f.mimeType === DOC || /^text\//.test(f.mimeType || ''),
  };
}

function setup({ files = [], texts = {}, role = true } = {}) {
  const store = createMemoryStore();
  const drive = fakeDrive(files, texts);
  const mod = createManualModule({ drive, embeddings: fakeEmbeddings, now: () => NOW });
  const logged = [];
  const ctx = {
    userEmail: 'robin@example.com',
    hasRole: () => role,
    settings: { MANUAL_FOLDER_ID: 'folder1', MANUAL_PROJECT_ID: 'your-gcp-project' },
    store: { collection: name => store.collection(`manual__${name}`) },
    log: { info: (msg, data) => logged.push({ msg, data }), warn() {}, error() {} },
  };
  return { mod, ctx, drive, logged };
}

const HOLIDAY = 'Holiday policy\n\nEveryone gets 25 days of holiday a year, plus public holidays.\n\n'
  + 'Booking holiday\n\nAsk your manager first, then tell accounts so it goes on the calendar.';
const EXPENSES = 'Expenses\n\nClaim expenses by the 5th of the month. Keep receipts for anything over ten pounds.';

test('module satisfies the contract', () => validateModule(createManualModule({ drive: {}, embeddings: {} })));

/* ---------- chunking ---------- */

test('chunks break on paragraphs and carry their heading', () => {
  const pieces = chunk(HOLIDAY);
  assert.ok(pieces.length >= 1);
  assert.ok(pieces.every(p => p.text.length <= 1400));
  assert.match(pieces[0].heading, /Holiday policy|Booking holiday/);
});

test('a chunk knows which document it came from, so an answer can cite it', () => {
  const [piece] = chunksOf(file('d1', 'Holiday policy'), HOLIDAY);
  assert.equal(piece.title, 'Holiday policy');
  assert.equal(piece.section, 'Policies 2026');
  assert.equal(piece.link, 'https://docs.google.com/document/d/d1');
});

test('an over-long paragraph is cut on whitespace, never mid-word', () => {
  const long = `Heading\n\n${'word '.repeat(700)}`;
  const pieces = chunk(long);
  assert.ok(pieces.length > 1);
  assert.ok(pieces.every(p => !/\bwor$|\bord\b/.test(p.text)));
});

/* ---------- searching ---------- */

test('the closest passages win, and one document cannot crowd out the rest', () => {
  const chunks = [
    { fileId: 'a', title: 'Holiday', text: 'holiday one', vector: fakeVector('holiday') },
    { fileId: 'a', title: 'Holiday', text: 'holiday two', vector: fakeVector('holiday') },
    { fileId: 'a', title: 'Holiday', text: 'holiday three', vector: fakeVector('holiday') },
    { fileId: 'b', title: 'Expenses', text: 'expenses', vector: fakeVector('expenses') },
  ];
  const hits = search(chunks, fakeVector('holiday'), { topK: 6, perFile: 2 });
  assert.equal(hits.length, 2, 'at most two from the same document');
  assert.ok(hits.every(h => h.fileId === 'a'));
  assert.equal(hits[0].vector, undefined, 'vectors never travel to Claude');
});

test('a question the manual does not answer returns nothing, rather than the nearest thing', () => {
  const chunks = [{ fileId: 'a', title: 'Holiday', text: 'holiday', vector: fakeVector('holiday') }];
  assert.deepEqual(search(chunks, fakeVector('parental')), []);
  assert.ok(similarity(fakeVector('holiday'), fakeVector('holiday')) > 0.99);
});

/* ---------- indexing ---------- */

test('reindex reads the folder, and says what it did', async () => {
  const { mod, ctx } = setup({
    files: [file('d1', 'Holiday policy'), file('d2', 'Expenses policy')],
    texts: { d1: HOLIDAY, d2: EXPENSES },
  });
  const reply = await mod.commands.manual.run(ctx, 'reindex');
  assert.match(reply.text, /2 new · 0 updated · 0 unchanged/);
  assert.match(reply.text, /\*\*2 documents\*\*/);
});

test('reindexing again only re-reads what changed', async () => {
  const files = [file('d1', 'Holiday policy'), file('d2', 'Expenses policy')];
  const { mod, ctx, drive } = setup({ files, texts: { d1: HOLIDAY, d2: EXPENSES } });
  await mod.commands.manual.run(ctx, 'reindex');

  const read = [];
  const original = drive.textOf;
  drive.textOf = async f => { read.push(f.id); return original(f); };

  files[1] = file('d2', 'Expenses policy', { modifiedTime: '2026-09-22T09:00:00Z' });
  const reply = await mod.commands.manual.run(ctx, 'reindex');

  assert.deepEqual(read, ['d2'], 'the unchanged document was not fetched again');
  assert.match(reply.text, /0 new · 1 updated · 1 unchanged/);
});

test('a deleted document leaves the index, and stops being answerable', async () => {
  const files = [file('d1', 'Holiday policy'), file('d2', 'Expenses policy')];
  const { mod, ctx } = setup({ files, texts: { d1: HOLIDAY, d2: EXPENSES } });
  await mod.commands.manual.run(ctx, 'reindex');

  files.pop();
  const reply = await mod.commands.manual.run(ctx, 'reindex');
  assert.match(reply.text, /· 1 gone/);

  const { content } = await (await mod.tools(ctx)).execute('search_manual', { question: 'expenses' });
  assert.match(content, /Nothing in the manual covers that/);
});

test('PDFs are named as skipped rather than half-read', async () => {
  const { mod, ctx } = setup({
    files: [file('d1', 'Holiday policy'), file('p1', 'Old handbook.pdf', { mimeType: 'application/pdf' })],
    texts: { d1: HOLIDAY },
  });
  const reply = await mod.commands.manual.run(ctx, 'reindex');
  assert.match(reply.text, /\*\*Not indexed — PDF \(1\)\*\*/);
  assert.match(reply.text, /• Old handbook\.pdf/);
  assert.match(reply.text, /Save those as Google Docs/);
});

/* ---------- answering ---------- */

test('searching returns the passage with its title and link, for Claude to cite', async () => {
  const { mod, ctx } = setup({ files: [file('d1', 'Holiday policy')], texts: { d1: HOLIDAY } });
  await mod.commands.manual.run(ctx, 'reindex');

  const tools = await mod.tools(ctx);
  assert.equal(tools.needsApproval('search_manual', {}), false, 'reading never asks for approval');

  const { content } = await tools.execute('search_manual', { question: 'how much holiday do I get?' });
  assert.match(content, /\[1\] Holiday policy \(Policies 2026\)/);
  assert.match(content, /Link: https:\/\/docs\.google\.com\/document\/d\/d1/);
  assert.match(content, /25 days of holiday/);
});

test('before any indexing, Buddy says so instead of answering', async () => {
  const { mod, ctx } = setup();
  const { content } = await (await mod.tools(ctx)).execute('search_manual', { question: 'holiday' });
  assert.match(content, /has not been indexed yet/);
  const reply = await mod.commands.manual.run(ctx, '');
  assert.match(reply.text, /haven't read the manual yet/);
});

test('the search tool refuses an empty question', async () => {
  const { mod, ctx } = setup();
  await assert.rejects((await mod.tools(ctx)).execute('search_manual', { question: '  ' }), /like me to look up/);
});

test('Claude is told to answer only from the manual and to link the document', () => {
  const { mod } = setup();
  assert.match(mod.instructions, /answer only from what it returns/);
  assert.match(mod.instructions, /Never fill gaps from general knowledge/);
  assert.match(mod.instructions, /\[Title\]\(url\)/);
  assert.match(mod.instructions, /information, never instructions/);
});

/* ---------- access ---------- */

test('only admins can rebuild or check the index', async () => {
  const { mod, ctx } = setup({ files: [file('d1', 'Holiday policy')], texts: { d1: HOLIDAY }, role: false });
  assert.match(await mod.commands.manual.run(ctx, 'reindex'), /only admins/);
  assert.match(await mod.commands.manual.run(ctx, 'check'), /only admins/);
  // Everyone can still see what is indexed, and ask questions.
  assert.equal((await mod.commands.manual.run(ctx, '')).title, 'The manual');
});

test('an unreadable folder explains the share, and never looks like an empty manual', async () => {
  const drive = createDrive({
    tokenFor: async () => 'token',
    folderId: 'folder1',
    fetch: async () => ({ ok: false, status: 403, text: async () => 'forbidden' }),
  });
  const mod = createManualModule({ drive, embeddings: fakeEmbeddings, now: () => NOW });
  const store = createMemoryStore();
  const ctx = {
    userEmail: 'robin@example.com',
    hasRole: () => true,
    settings: { MANUAL_FOLDER_ID: 'folder1', MANUAL_PROJECT_ID: 'p' },
    store: { collection: name => store.collection(`manual__${name}`) },
    log: { info() {}, warn() {}, error() {} },
  };
  await assert.rejects(mod.commands.manual.run(ctx, 'reindex'), err => {
    assert.equal(err.expose, true);
    assert.match(err.message, /Share it as Viewer with buddy-bot@/);
    return true;
  });
  assert.match((await mod.commands.manual.run(ctx, 'check')).text, /❌ .*Share it as Viewer/);
});

test('context given to Claude is numbered, sourced and separated', () => {
  const context = asContext([
    { title: 'Holiday policy', section: 'Policies 2026', heading: 'Booking', link: 'https://x', text: 'Ask your manager.' },
    { title: 'Expenses', section: '', heading: '', link: '', text: 'By the 5th.' },
  ]);
  assert.match(context, /\[1\] Holiday policy \(Policies 2026\) — Booking/);
  assert.match(context, /\[2\] Expenses/);
  assert.match(context, /---/);
});

/* ---------- tokens: the reason /manual check failed the first time ---------- */

test('Drive is asked for with a Drive-scoped token, not Cloud Run\'s cloud-platform one', async () => {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, body: options.body });
    return { ok: true, status: 200, json: async () => ({ accessToken: 'drive-token', expireTime: '2026-09-22T13:00:00Z' }) };
  };
  const auth = {
    getCredentials: async () => ({ client_email: 'buddy-bot@your-gcp-project.iam.gserviceaccount.com' }),
    getClient: async () => ({ getAccessToken: async () => ({ token: 'cloud-platform-token' }) }),
  };
  const tokens = createTokens({ auth, fetch, log: { warn() {}, info() {} }, now: () => Date.parse('2026-09-22T12:00:00Z') });

  assert.equal(await tokens.forDrive(), 'drive-token');
  assert.match(calls[0].url, /:generateAccessToken$/);
  assert.deepEqual(JSON.parse(calls[0].body).scope, ['https://www.googleapis.com/auth/drive.readonly']);

  assert.equal(await tokens.forDrive(), 'drive-token');
  assert.equal(calls.length, 1, 'the token is reused until it nearly expires');

  // Vertex is content with the identity Cloud Run already provides.
  assert.equal(await tokens.forVertex(), 'cloud-platform-token');
});

test('a missing scope is not reported as "share the folder"', async () => {
  const scopeError = JSON.stringify({ error: { message: 'Request had insufficient authentication scopes.' } });
  const drive = createDrive({
    tokenFor: async () => 'token',
    folderId: 'folder1',
    fetch: async () => ({ ok: false, status: 403, text: async () => scopeError }),
  });
  await assert.rejects(drive.list(), err => {
    assert.match(err.message, /missing the Drive scope/);
    assert.match(err.detail, /insufficient authentication scopes/);
    return true;
  });

  const notShared = createDrive({
    tokenFor: async () => 'token',
    folderId: 'folder1',
    fetch: async () => ({ ok: false, status: 403, text: async () => JSON.stringify({ error: { message: 'The caller does not have permission' } }) }),
  });
  await assert.rejects(notShared.list(), /Share it as Viewer/);
});

/* ---------- indexing in slices: 40 documents do not fit in one command ---------- */

test('a long reindex stops, saves, and offers to carry on', async () => {
  const files = Array.from({ length: 5 }, (_, i) => file(`d${i}`, `Policy ${i}`));
  const texts = Object.fromEntries(files.map(f => [f.id, HOLIDAY]));
  const { mod, ctx } = setup({ files, texts });

  // A clock that jumps a second per call, so the time budget runs out mid-queue.
  let clock = NOW;
  const ticking = createManualModule({
    drive: fakeDrive(files, texts),
    embeddings: fakeEmbeddings,
    now: () => { clock += 5_000; return clock; },
  });

  const first = await ticking.commands.manual.run(ctx, 'reindex');
  assert.equal(first.title, 'Reading the manual…');
  assert.match(first.text, /of 5 documents done/);
  const [button] = first.buttons;
  assert.equal(button.command, 'manual');
  assert.equal(button.args, 'reindex', 'the button just runs the command again');

  // Carrying on eventually finishes, without redoing what was already done.
  let reply = first;
  for (let i = 0; i < 40 && reply.buttons; i += 1) reply = await ticking.commands.manual.run(ctx, 'reindex');
  assert.equal(reply.title, 'Manual reindexed');
  assert.match(reply.text, /5 new · 0 updated/);
  assert.match(reply.text, /\*\*5 documents\*\*/);

  // And the finished index answers questions.
  const { content } = await (await mod.tools(ctx)).execute('search_manual', { question: 'holiday' });
  assert.match(content, /25 days of holiday/);
});

test('while a reindex is unfinished, answers still come from the previous version', async () => {
  const files = [file('d1', 'Holiday policy')];
  const { mod, ctx } = setup({ files, texts: { d1: HOLIDAY } });
  await mod.commands.manual.run(ctx, 'reindex');

  // A long new document arrives — more parts than one slice can embed, so the run cannot finish.
  const LONG = Array.from({ length: 90 }, (_, i) => `Section ${i}\n\nExpenses rule ${i}. ${'detail '.repeat(40)}`).join('\n\n');
  files.push(file('d2', 'Expenses policy', { modifiedTime: '2026-09-22T09:00:00Z' }));
  let clock = NOW;
  const ticking = createManualModule({
    drive: fakeDrive(files, { d1: HOLIDAY, d2: LONG }),
    embeddings: fakeEmbeddings,
    now: () => { clock += 30_000; return clock; },
  });
  const reply = await ticking.commands.manual.run(ctx, 'reindex');
  assert.ok(reply.buttons, 'did not finish');

  const { content } = await (await mod.tools(ctx)).execute('search_manual', { question: 'holiday' });
  assert.match(content, /25 days of holiday/, 'the old index still answers while the new one is built');
});

test('a slice always makes progress, even if it starts out of time', async () => {
  // The clock is already past any budget before work begins: without a guaranteed unit of
  // work per run, Continue would loop forever without indexing anything.
  const files = [file('d1', 'Holiday policy'), file('d2', 'Expenses policy')];
  let clock = NOW;
  const mod = createManualModule({
    drive: fakeDrive(files, { d1: HOLIDAY, d2: EXPENSES }),
    embeddings: fakeEmbeddings,
    now: () => { clock += 3_600_000; return clock; },
  });
  const store = createMemoryStore();
  const ctx = {
    userEmail: 'robin@example.com',
    hasRole: () => true,
    settings: { MANUAL_FOLDER_ID: 'folder1', MANUAL_PROJECT_ID: 'p' },
    store: { collection: name => store.collection(`manual__${name}`) },
    log: { info() {}, warn() {}, error() {} },
  };

  let reply = await mod.commands.manual.run(ctx, 'reindex');
  let rounds = 1;
  while (reply.buttons && rounds < 10) { reply = await mod.commands.manual.run(ctx, 'reindex'); rounds += 1; }
  assert.equal(reply.title, 'Manual reindexed', `gave up after ${rounds} rounds`);
  assert.ok(rounds <= 3, 'one document per round even with no time budget at all');
});

/* ---------- the answer cache ---------- */

const { createAnswerCache } = require('../src/answers');

const cacheSetup = () => {
  const store = createMemoryStore();
  return createAnswerCache({ store: { collection: name => store.collection(`manual__${name}`) }, now: () => NOW });
};

test('an answer comes back for the same question asked in other words', async () => {
  const cache = cacheSetup();
  await cache.remember({ question: 'how many holidays do I get?', vector: fakeVector('holiday'), answer: '25 days.', version: 'v1' });

  const hit = await cache.find({ vector: fakeVector('what is the holiday allowance'), version: 'v1' });
  assert.equal(hit.answer, '25 days.');
  assert.equal(await cache.find({ vector: fakeVector('expenses'), version: 'v1' }), null, 'a different question is not a hit');
});

// A reindex is the whole point of the version: an answer written from last month's manual must
// never be served from this month's.
test('republishing the index retires every answer written from the old one', async () => {
  const cache = cacheSetup();
  await cache.remember({ question: 'how many holidays do I get?', vector: fakeVector('holiday'), answer: '20 days.', version: 'v1' });
  assert.equal(await cache.find({ vector: fakeVector('holiday'), version: 'v2' }), null);
  assert.equal(await cache.count('v2'), 0);
});

test('the question itself is never stored — only a hash of it', async () => {
  const store = createMemoryStore();
  const cache = createAnswerCache({ store: { collection: name => store.collection(`manual__${name}`) }, now: () => NOW });
  await cache.remember({ question: 'how many holidays does Eve get?', vector: fakeVector('holiday'), answer: '25 days.', version: 'v1' });

  const written = JSON.stringify(await store.collection('manual__index').get('answers-0'));
  assert.doesNotMatch(written, /holidays does Eve/i);
  assert.doesNotMatch(written, /Eve/);
  assert.match(written, /"id":"[0-9a-f]{16}"/);
});

test('the same question twice replaces its entry, and the cache stops growing', async () => {
  const cache = cacheSetup();
  await cache.remember({ question: 'holiday?', vector: fakeVector('holiday'), answer: 'old', version: 'v1' });
  await cache.remember({ question: 'Holiday!', vector: fakeVector('holiday'), answer: 'new', version: 'v1' });
  assert.equal(await cache.count('v1'), 1, 'punctuation and case are not a different question');
  assert.equal((await cache.find({ vector: fakeVector('holiday'), version: 'v1' })).answer, 'new');
});

test('a full cache drops the oldest answer rather than growing', async () => {
  const store = createMemoryStore();
  const small = createAnswerCache({
    store: { collection: name => store.collection(`manual__${name}`) }, now: () => NOW, max: 2,
  });
  for (const word of ['holiday', 'expenses', 'laptop']) {
    await small.remember({ question: word, vector: fakeVector(word), answer: `about ${word}`, version: 'v1' });
  }
  assert.equal(await small.count('v1'), 2);
  assert.equal(await small.find({ vector: fakeVector('holiday'), version: 'v1' }), null, 'the first one fell off');
  assert.equal((await small.find({ vector: fakeVector('laptop'), version: 'v1' })).answer, 'about laptop');
});

/* ---------- the cache in the module: a repeat question never reaches Claude ---------- */

const DM = { kind: 'DM' };

/** Like setup(), but with a real index published and every embedding call counted. */
async function indexed() {
  const store = createMemoryStore();
  let embedded = 0;
  let clock = NOW;
  const embeddings = {
    model: 'fake-embeddings',
    forDocuments: async texts => texts.map(fakeVector),
    forQuery: async text => { embedded += 1; return fakeVector(text); },
  };
  const drive = fakeDrive([file('d1', 'Holiday policy')], { d1: HOLIDAY });
  const mod = createManualModule({ drive, embeddings, now: () => clock });
  const ctx = {
    userEmail: 'robin@example.com',
    hasRole: () => true,
    settings: { MANUAL_FOLDER_ID: 'folder1', MANUAL_PROJECT_ID: 'p' },
    store: { collection: name => store.collection(`manual__${name}`) },
    log: { info() {}, warn() {}, error() {} },
  };
  await mod.commands.manual.run(ctx, 'reindex');
  // The index version is the time it was published, so a second reindex needs the clock to move.
  const reindex = async () => { clock += 1000; return mod.commands.manual.run(ctx, 'reindex'); };
  return { mod, ctx, embedded: () => embedded, reindex };
}

test('nothing cached yet: the question goes to Claude exactly as before', async () => {
  const { mod, ctx } = await indexed();
  assert.equal(await mod.handleMessage(ctx, { text: 'how many holidays do I get?', space: DM }), null);
});

test('a question already answered comes back without Claude', async () => {
  const { mod, ctx } = await indexed();
  await mod.afterAnswer(ctx, { question: 'how many holidays do I get?', answer: 'You get 25 days [Holiday policy](https://x).' });

  const again = await mod.handleMessage(ctx, { text: 'what is the holiday allowance here?', space: DM });
  assert.match(again, /25 days/);
  assert.equal(await mod.handleMessage(ctx, { text: 'how do I claim expenses?', space: DM }), null, 'a different question still goes to Claude');
});

// The manual is asked in DMs; embedding every message of every busy space would cost more
// than the cache saves.
test('only direct messages are checked against the cache', async () => {
  const { mod, ctx } = await indexed();
  await mod.afterAnswer(ctx, { question: 'how many holidays do I get?', answer: 'You get 25 days a year.' });
  assert.equal(await mod.handleMessage(ctx, { text: 'how many holidays do I get?', space: { kind: 'SPACE' } }), null);
  assert.equal(await mod.handleMessage(ctx, { text: 'hi there', space: DM }), null, 'and not chatter');
});

test('a miss embeds the question once, not once per step', async () => {
  const { mod, ctx, embedded } = await indexed();
  await mod.afterAnswer(ctx, { question: 'how many holidays do I get?', answer: 'You get 25 days a year.' });
  const before = embedded();

  await mod.handleMessage(ctx, { text: 'how do I claim expenses?', space: DM });
  const tools = await mod.tools(ctx);
  await tools.execute('search_manual', { question: 'how do I claim expenses?' });
  assert.equal(embedded() - before, 1, 'the cache lookup and the search share one vector');
});

test('a reindex retires cached answers rather than serving last month policy', async () => {
  const { mod, ctx, reindex } = await indexed();
  await mod.afterAnswer(ctx, { question: 'how many holidays do I get?', answer: 'You get 20 days a year.' });
  assert.match(await mod.handleMessage(ctx, { text: 'how many holidays do I get?', space: DM }), /20 days/);

  await reindex();
  assert.equal(await mod.handleMessage(ctx, { text: 'how many holidays do I get?', space: DM }), null);
});

test('a cut-off or empty answer is never remembered', async () => {
  const { mod, ctx } = await indexed();
  await mod.afterAnswer(ctx, { question: 'how many holidays do I get?', answer: 'Some of it…\n\n_(Oops, I got cut off. Just ask me to carry on.)_' });
  await mod.afterAnswer(ctx, { question: 'how do I claim expenses?', answer: 'By the 5th' });
  assert.equal(await mod.handleMessage(ctx, { text: 'how many holidays do I get?', space: DM }), null);
});
