const test = require('node:test');
const assert = require('node:assert/strict');
const { validateModule, createMemoryStore } = require('@buddy/core');
const { createInvoicesModule, FIRST_RUN_DAYS } = require('../src/module');
const { createDrive } = require('../src/drive');
const { day } = require('../src/present');

const NOW = Date.parse('2026-09-29T15:00:00Z');
const daysAgo = n => new Date(NOW - n * 24 * 3600 * 1000).toISOString();
const pdf = (id, name, created) => ({ id, name, createdTime: created, size: 120_000, link: `https://drive.google.com/file/d/${id}/view` });

function setup({ files = [], notify = 'robin@example.com', failing = null } = {}) {
  const state = { files };
  const drive = {
    folder: async () => { if (failing) throw failing; return { id: 'folder1', name: 'Buddy invoices' }; },
    invoices: async () => { if (failing) throw failing; return state.files; },
  };
  const store = createMemoryStore();
  const mod = createInvoicesModule({ drive, now: () => NOW });
  const ctx = {
    settings: { INVOICES_FOLDER_ID: 'folder1folder1', INVOICES_NOTIFY: notify, INVOICES_TIMEZONE: 'America/Argentina/Buenos_Aires' },
    store: { collection: name => store.collection(`m_invoices__${name}`) },
    log: { info() {}, warn() {}, error() {} },
  };
  return { mod, ctx, state };
}

test('module satisfies the contract', () => validateModule(createInvoicesModule({ drive: {} })));

test('/invoices lists the newest first, with links', async () => {
  const { mod, ctx } = setup({ files: [pdf('b', '2026-09 Google Cloud invoice.pdf', daysAgo(1)), pdf('a', '2026-08 Google Cloud invoice.pdf', daysAgo(30))] });
  const reply = await mod.commands.invoices.run(ctx, '');
  assert.equal(reply.title, 'Google Cloud invoices');
  assert.match(reply.text, /\[2026-09 Google Cloud invoice\.pdf\]\(https:\/\/drive\.google\.com\/file\/d\/b\/view\)/);
  assert.ok(reply.text.indexOf('2026-09') < reply.text.indexOf('2026-08'));
});

test('/invoices with an empty folder says where they come from', async () => {
  const { mod, ctx } = setup();
  assert.match((await mod.commands.invoices.run(ctx, '')).text, /fetcher on the PC/);
});

// Switching it on should not announce years of old invoices.
test('the first daily run announces only the last week, and remembers the rest', async () => {
  const { mod, ctx, state } = setup({ files: [pdf('new', 'new.pdf', daysAgo(2)), pdf('old', 'old.pdf', daysAgo(FIRST_RUN_DAYS + 20))] });
  const notes = await mod.onSchedule(ctx, 'daily');
  assert.equal(notes.length, 1);
  assert.deepEqual(notes[0].to, ['robin@example.com']);
  assert.match(notes[0].reply.text, /new\.pdf/);
  assert.doesNotMatch(notes[0].reply.text, /old\.pdf/);

  assert.deepEqual(await mod.onSchedule(ctx, 'daily'), [], 'nothing new the next day: nothing said');
  state.files = [pdf('newer', 'newer.pdf', daysAgo(0)), ...state.files];
  const later = await mod.onSchedule(ctx, 'daily');
  assert.match(later[0].reply.text, /newer\.pdf/);
  assert.doesNotMatch(later[0].reply.text, /\bnew\.pdf/, 'each invoice is announced once');
});

test('several new invoices arrive as one message, with a button to see them all', async () => {
  const { mod, ctx } = setup({ files: [pdf('x', 'x.pdf', daysAgo(1)), pdf('y', 'y.pdf', daysAgo(1))] });
  const [note] = await mod.onSchedule(ctx, 'daily');
  assert.equal(note.reply.title, '2 new Google Cloud invoices');
  assert.deepEqual(note.reply.buttons, [{ text: 'All invoices', command: 'invoices' }]);
});

test('with nobody to tell, nothing is sent and nothing is marked as told', async () => {
  const { mod, ctx } = setup({ files: [pdf('x', 'x.pdf', daysAgo(1))], notify: '' });
  assert.deepEqual(await mod.onSchedule(ctx, 'daily'), []);
  ctx.settings.INVOICES_NOTIFY = 'robin@example.com';
  assert.equal((await mod.onSchedule(ctx, 'daily')).length, 1, 'switching the list on later still announces it');
});

test('other scheduled tasks are ignored', async () => {
  const { mod, ctx } = setup({ files: [pdf('x', 'x.pdf', daysAgo(1))] });
  assert.deepEqual(await mod.onSchedule(ctx, 'weekly'), []);
});

test('/invoices check shows the folder, the newest file and who will be told', async () => {
  const { mod, ctx } = setup({ files: [pdf('x', '2026-09 invoice.pdf', daysAgo(1))] });
  const reply = await mod.commands.invoices.run(ctx, 'check');
  assert.match(reply.text, /✅ I can read the folder \*\*Buddy invoices\*\*: 1 invoice\./);
  assert.match(reply.text, /robin@example\.com/);
});

test('/invoices check quotes Google when the folder cannot be read', async () => {
  const failing = Object.assign(new Error('Buddy can\'t see the invoices folder. Share it as Viewer with buddy-bot@x.'), { expose: true, detail: 'File not found: folder1.' });
  const { mod, ctx } = setup({ failing });
  const reply = await mod.commands.invoices.run(ctx, 'check');
  assert.match(reply.text, /❌ Buddy can't see the invoices folder/);
  assert.match(reply.text, /Google said: File not found/);
});

/* ---------- the Drive layer ---------- */

test('a folder id that could break the query is refused before any call', () => {
  assert.throws(() => createDrive({ tokenFor: async () => 't', folderId: "x' or trashed = true or '" }), /doesn't look like a Drive folder id/);
});

test('only PDFs in the folder are asked for, newest first, and a 404 explains the share', async () => {
  const urls = [];
  const drive = createDrive({
    tokenFor: async () => 'token',
    folderId: 'folder1folder1',
    fetch: async url => {
      urls.push(String(url));
      return { ok: false, status: 404, json: async () => ({ error: { message: 'File not found.' } }) };
    },
  });
  await assert.rejects(drive.invoices(), err => {
    assert.match(err.message, /Share it as Viewer with buddy-bot@/);
    assert.equal(err.detail, 'File not found.');
    return true;
  });
  const q = new URL(urls[0]).searchParams.get('q');
  assert.equal(q, "'folder1folder1' in parents and trashed = false and mimeType = 'application/pdf'");
  assert.equal(new URL(urls[0]).searchParams.get('orderBy'), 'createdTime desc');
});

test('dates are shown in the reporting time zone, not the server\'s', () => {
  // 01:30 UTC on the 1st is still the 30th in Buenos Aires.
  assert.match(day('2026-10-01T01:30:00Z', 'America/Argentina/Buenos_Aires'), /^30 Sep/);
  assert.match(day('2026-10-01T01:30:00Z', 'UTC'), /^1 Oct/);
});
