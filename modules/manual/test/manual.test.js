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
  assert.match(mod.instructions, /information, not instructions/);
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
  for (let i = 0; i < 6 && reply.buttons; i += 1) reply = await ticking.commands.manual.run(ctx, 'reindex');
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

  // A new, slow-to-index document arrives; the run will not finish this time.
  files.push(file('d2', 'Expenses policy', { modifiedTime: '2026-09-22T09:00:00Z' }));
  let clock = NOW;
  const ticking = createManualModule({
    drive: fakeDrive(files, { d1: HOLIDAY, d2: EXPENSES }),
    embeddings: fakeEmbeddings,
    now: () => { clock += 30_000; return clock; },
  });
  const reply = await ticking.commands.manual.run(ctx, 'reindex');
  assert.ok(reply.buttons, 'did not finish');

  const { content } = await (await mod.tools(ctx)).execute('search_manual', { question: 'holiday' });
  assert.match(content, /25 days of holiday/, 'the old index still answers while the new one is built');
});
