const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../src/plan');
const { loadConfig, problems } = require('../config');

const NOW = Date.parse('2026-09-29T13:00:00Z');
const TZ = 'America/Argentina/Buenos_Aires';
const row = (number, date, extra = '') => ({ rowText: `Invoice ${number} ${date} USD 123.45 ${extra}`.trim(), label: 'Download', href: '' });

test('dates in the formats the console uses, and none guessed', () => {
  assert.equal(p.invoiceDate('Invoice 2026-09-01 USD 3'), '2026-09-01');
  assert.equal(p.invoiceDate('Sep 1, 2026'), '2026-09-01');
  assert.equal(p.invoiceDate('1 Sept 2026'), '2026-09-01');
  assert.equal(p.invoiceDate('1 de sep. de 2026'), '2026-09-01');
  assert.equal(p.invoiceDate('3 ago 2026'), '2026-08-03');
  assert.equal(p.invoiceDate('03/04/2026'), null, 'day/month order differs by country');
  assert.equal(p.invoiceDate('Sep 41, 2026'), null);
});

test('an invoice is known by its number; without one, by its row minus the buttons', () => {
  assert.deepEqual(p.documentId('Invoice 5012345678 Sep 1, 2026 Download'), { id: 'doc:5012345678', number: '5012345678' });
  const a = p.documentId('Statement Sep 2026 USD 12 Download PDF');
  const b = p.documentId('Statement  Sep 2026 USD 12 descargar');
  assert.match(a.id, /^row:[0-9a-f]{16}$/);
  assert.equal(a.id, b.id, 'the same row reads the same whatever the button says');
  assert.equal(p.documentId('   ').id, null);
});

test('file names sort by date and are safe on Windows', () => {
  assert.equal(p.fileName({ date: '2026-09-01', number: '5012345678' }), 'Google Cloud invoice 2026-09-01 5012345678.pdf');
  assert.equal(p.fileName({ date: '2026-09-01', number: '50/12:34' }), 'Google Cloud invoice 2026-09-01 501234.pdf');
});

test('plan: only unseen invoices are fetched, and the PDF link of a row wins', () => {
  const state = { ...p.emptyState(), initialisedAt: '2026-08-01T00:00:00Z', documents: { 'doc:5000000001': { mailed: true } } };
  const candidates = [
    row('5000000001', 'Aug 1, 2026'),
    { ...row('5000000002', 'Sep 1, 2026'), label: 'Download CSV', href: 'https://x.google.com/a.csv' },
    { ...row('5000000002', 'Sep 1, 2026'), label: 'Download PDF', href: 'https://x.google.com/a.pdf' },
  ];
  const out = p.plan(candidates, state, { now: NOW, timeZone: TZ, maxPerRun: 24 });
  assert.equal(out.seen, 2);
  assert.equal(out.toFetch.length, 1);
  assert.equal(out.toFetch[0].href, 'https://x.google.com/a.pdf');
  assert.equal(out.toFetch[0].fileName, 'Google Cloud invoice 2026-09-01 5000000002.pdf');
  assert.equal(out.firstRun, false);
});

test('plan: an empty page, or a flood of "new" ones, is a changed page, not news', () => {
  const state = { ...p.emptyState(), initialisedAt: '2026-08-01T00:00:00Z' };
  assert.throws(() => p.plan([], state, { now: NOW, timeZone: TZ, maxPerRun: 24 }), e => e.kind === 'layout');
  assert.throws(() => p.plan([{ rowText: '', label: 'Download' }], state, { now: NOW, timeZone: TZ, maxPerRun: 24 }), /none in a row I could recognise/);
  const flood = Array.from({ length: 30 }, (_, i) => row(String(5000000100 + i), 'Sep 1, 2026'));
  assert.throws(() => p.plan(flood, state, { now: NOW, timeZone: TZ, maxPerRun: 24 }), /more than the 24/);
  assert.equal(p.plan(flood, p.emptyState(), { now: NOW, timeZone: TZ, maxPerRun: 24 }).toFetch.length, 1, 'the first run takes only the latest, however long the history');
});

test('plan: the first run picks the latest only; header and pager rows are not documents', () => {
  const rows = ['Issue date Document type Amount Edit', 'July 31, 2026 Statement £0.34', 'August 31, 2026 Statement £1.74', 'Rows per page: 20 1 to 7 of 7']
    .map(rowText => ({ rowText, label: 'Download selected', href: '', mode: 'select' }));
  const out = p.plan(rows, p.emptyState(), { now: NOW, timeZone: TZ, maxPerRun: 24 });
  assert.equal(out.seen, 2);
  assert.deepEqual(out.toFetch.map(d => d.fileName), ['Google Cloud statement 2026-08-31.pdf']);
  assert.deepEqual(out.skip.map(d => d.fileName), ['Google Cloud statement 2026-07-31.pdf']);
  assert.equal(p.documentKind('August 31, 2026 Statement £1.74'), 'statement');
  assert.equal(p.documentKind('Invoice 5000000001'), 'invoice');
});

test('state records saved-then-mailed, never mailed twice', () => {
  let s = p.emptyState();
  s = p.recordSaved(s, { id: 'doc:1', fileName: 'a.pdf', date: '2026-09-01' }, { now: NOW });
  s = p.recordSkipped(s, [{ id: 'doc:2', fileName: 'b.pdf', date: '2024-01-01' }], { now: NOW });
  assert.equal(s.documents['doc:1'].mailed, false);
  assert.equal(s.documents['doc:2'].mailed, 'before-start');
  assert.equal(s.documents['doc:2'].file, null);
  s = p.recordMailed(s, ['doc:1', 'doc:unknown']);
  assert.equal(s.documents['doc:1'].mailed, true);
  assert.equal(s.documents['doc:unknown'], undefined);
  s = p.recordRun(s, { now: NOW });
  assert.equal(s.initialisedAt, new Date(NOW).toISOString());
});

test('every alert says what happened and what to do', () => {
  const signin = p.alertMail(new p.FetchError('signin', 'Google asked to sign in.'), { billingAccountId: 'X', when: 'now' });
  assert.match(signin.subject, /sign in to Google again/);
  assert.match(signin.text, /npm run login/);
  const layout = p.alertMail(new p.FetchError('layout', 'No invoices.'), { billingAccountId: 'X', when: 'now' });
  assert.match(layout.text, /npm run inspect/);
  assert.equal(p.alertMail(new Error('boom'), { billingAccountId: 'X', when: 'now' }).kind, 'unexpected');
});

test('config: the defaults point at Google only, and a missing Drive folder is caught before anything runs', () => {
  const config = loadConfig(__dirname); // no config.local.json here
  assert.equal(config.documentsUrl, 'https://console.cloud.google.com/billing/XXXXXX-XXXXXX-XXXXXX/invoices?organizationId=000000000000');
  assert.match(problems(config).join(' '), /outputDir is empty/);
  assert.deepEqual(problems(config, { needOutput: false }), []);
  assert.match(problems({ ...config, outputDir: 'x', documentsUrl: 'https://evil.example/billing' }).join(' '), /console\.cloud\.google\.com/);
});
