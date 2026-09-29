// A whole run against a fake page, a fake mailer and a temporary folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../src/run');
const { loadConfig } = require('../config');
const { isSignInPage, looksLikePdf, SELECTORS } = require('../src/billing');

const PDF = Buffer.from('%PDF-1.7 fake');
const NOW = Date.parse('2026-09-29T13:00:00Z');
const quiet = { info() {}, warn() {}, error() {} };

// The layout with a download link per row.
function fakePage({ rows = [], url = 'https://console.cloud.google.com/billing/x/invoices?organizationId=1', body = PDF, signInFields = 0 } = {}) {
  const page = { rows, fetched: [] };
  const frame = {
    url: () => url,
    evaluate: async fn => (fn.name === 'collectInFrame'
      ? page.rows.map((r, index) => ({ index, label: 'Download PDF', href: `https://payments.google.com/doc/${index}.pdf`, rowText: r }))
      : []),
  };
  return Object.assign(page, {
    goto: async () => {},
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    url: () => url,
    locator: () => ({ count: async () => signInFields }),
    frames: () => [frame],
    context: () => ({ request: { get: async href => { page.fetched.push(href); return { ok: () => true, status: () => 200, body: async () => (typeof body === 'function' ? body(href) : body) }; } } }),
  });
}

// the company's real layout: payments.google.com in a frame, a checkbox per row, "Download selected".
// The download holds whichever rows are ticked, so ticking the wrong one shows up as a wrong file.
const REAL_ROWS = ['Issue date Document type Amount Edit', 'August 31, 2026 Statement £1.74', 'July 31, 2026 Statement £0.34', 'June 30, 2026 Statement £0.07'];
function fakeTickPage(rows = REAL_ROWS, dir) {
  const ticked = new Set();
  const listeners = { download: new Set() };
  // Like Google's: a forced click does nothing (the overlay swallows it); Space toggles it.
  const toggle = i => { if (ticked.has(i)) ticked.delete(i); else ticked.add(i); };
  const box = i => ({
    isVisible: async () => true,
    isChecked: async () => ticked.has(i),
    click: async () => {},
    focus: async () => {},
    press: async key => { if (key === 'Space') toggle(i); },
  });
  const page = { rows, downloads: [] };
  const frame = {
    url: () => 'https://payments.google.com/payments/u/0/documentcenter',
    evaluate: async fn => (fn.name === 'collectSelectableInFrame'
      ? page.rows.map((rowText, index) => ({ index, mode: 'select', label: 'Download selected', href: '', rowText }))
      : []),
    locator: sel => {
      if (sel === SELECTORS.selectableRow) {
        return { count: async () => page.rows.length, nth: i => ({ innerText: async () => page.rows[i], locator: () => ({ first: () => box(i) }) }) };
      }
      // The column/filter panels' checkboxes: hidden, ticked, and never to be touched.
      return { count: async () => 1, nth: () => ({ isVisible: async () => false, isChecked: async () => true, uncheck: async () => { throw new Error('touched a hidden panel checkbox'); } }) };
    },
    // Like Google's button, as far as we know: a click does nothing, Enter starts the download.
    getByRole: () => ({ first: () => ({
      click: async () => {},
      focus: async () => {},
      press: async key => {
        if (key !== 'Enter') return;
        const picked = [...ticked].map(i => page.rows[i]);
        page.downloads.push(picked);
        const file = path.join(dir, `dl-${page.downloads.length}`);
        fs.writeFileSync(file, picked.length === 1 ? Buffer.from(`%PDF-1.7 ${picked[0]}`) : Buffer.from('PK zip'));
        for (const cb of listeners.download) cb({ path: async () => file });
      },
    }) }),
  };
  return Object.assign(page, {
    goto: async () => {},
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    url: () => 'https://console.cloud.google.com/billing/x/invoices?organizationId=1',
    locator: () => ({ count: async () => 0 }),
    frames: () => [frame],
    on: (event, cb) => { if (listeners[event]) listeners[event].add(cb); },
    off: (event, cb) => { if (listeners[event]) listeners[event].delete(cb); },
    context: () => ({ pages: () => [page], on() {}, off() {} }),
  });
}

function setup(rows, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetcher-'));
  const outputDir = path.join(dir, 'drive');
  fs.mkdirSync(outputDir);
  const config = { ...loadConfig(__dirname), outputDir, stateFile: path.join(dir, 'state.json'), settleMs: 0, pressWaitMs: 20 };
  const sent = [];
  const mailer = { send: async m => { if (opts.mailFails) throw new Error('smtp down'); sent.push(m); } };
  const page = opts.tick ? fakeTickPage(rows, dir) : fakePage({ rows, ...opts });
  return { config, outputDir, sent, mailer, page };
}

test('the first run takes only the latest; after that, each new one as it appears', async () => {
  const { config, outputDir, sent, mailer, page } = setup(['Invoice 5000000001 Aug 31, 2026', 'Invoice 5000000000 Jul 31, 2026', 'Invoice 4999999999 Jun 30, 2026']);
  const first = await run({ config, page, mailer, log: quiet, now: () => NOW });
  assert.deepEqual(first.saved, ['Google Cloud invoice 2026-08-31 5000000001.pdf']);
  assert.deepEqual(fs.readdirSync(outputDir), ['Google Cloud invoice 2026-08-31 5000000001.pdf']);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].attachments.length, 1);

  const again = await run({ config, page, mailer, log: quiet, now: () => NOW });
  assert.deepEqual(again.saved, [], 'July and June are never fetched later either');
  assert.equal(sent.length, 1, 'nothing new: no second email');

  page.rows = ['Invoice 5000000002 Sep 30, 2026', ...page.rows];
  const next = await run({ config, page, mailer, log: quiet, now: () => NOW });
  assert.deepEqual(next.saved, ['Google Cloud invoice 2026-09-30 5000000002.pdf']);
  assert.equal(sent.length, 2);
});

test('if the first download fails, the next run still starts from the latest, not the whole history', async () => {
  const body = href => (href.endsWith('/0.pdf') ? Buffer.from('<html>') : PDF);
  const s = setup(['Invoice 5000000001 Aug 31, 2026', 'Invoice 5000000000 Jul 31, 2026'], { body });
  await assert.rejects(run({ config: s.config, page: s.page, mailer: s.mailer, log: quiet, now: () => NOW }), err => err.kind === 'download');
  const s2 = { ...s, page: fakePage({ rows: s.page.rows }) };
  const result = await run({ config: s.config, page: s2.page, mailer: s.mailer, log: quiet, now: () => NOW });
  assert.deepEqual(result.saved, ['Google Cloud invoice 2026-08-31 5000000001.pdf']);
});

test('Your Company\'s page: ticks one row at a time, header ignored, saved as a statement', async () => {
  const { config, outputDir, sent, mailer, page } = setup(REAL_ROWS, { tick: true });
  const result = await run({ config, page, mailer, log: quiet, now: () => NOW });
  assert.deepEqual(result.saved, ['Google Cloud statement 2026-08-31.pdf'], 'hidden ticked checkboxes elsewhere in the frame are left alone');
  assert.deepEqual(page.downloads, [['August 31, 2026 Statement £1.74']], 'exactly one row ticked, the right one');
  const saved = fs.readFileSync(path.join(outputDir, 'Google Cloud statement 2026-08-31.pdf'), 'latin1');
  assert.match(saved, /August 31, 2026/);
  assert.equal(sent.length, 1);

  page.rows = [REAL_ROWS[0], 'September 30, 2026 Statement £2.10', ...REAL_ROWS.slice(1)];
  const next = await run({ config, page, mailer, log: quiet, now: () => NOW });
  assert.deepEqual(next.saved, ['Google Cloud statement 2026-09-30.pdf']);
  assert.deepEqual(page.downloads[1], ['September 30, 2026 Statement £2.10'], 'the table moved down a row; the right one is still ticked');
});

test('if the email fails, the invoice stays saved and is emailed next time, not fetched again', async () => {
  const s = setup(['Invoice 5000000001 Sep 1, 2026'], { mailFails: true });
  await assert.rejects(run({ config: s.config, page: s.page, mailer: s.mailer, log: quiet, now: () => NOW }), /smtp down/);
  assert.equal(fs.readdirSync(s.outputDir).length, 1);
  const sent = [];
  await run({ config: s.config, page: s.page, mailer: { send: async m => sent.push(m) }, log: quiet, now: () => NOW });
  assert.equal(sent.length, 1);
  assert.equal(s.page.fetched.length, 1, 'downloaded once only');
});

test('something that isn\'t a PDF is refused, the rest still arrive, and the run says "1 of 2"', async () => {
  const body = href => (href.endsWith('/1.pdf') ? Buffer.from('<html>sign in</html>') : PDF);
  const s = setup(['Invoice 5000000001 Aug 31, 2026'], {});
  await run({ config: s.config, page: s.page, mailer: s.mailer, log: quiet, now: () => NOW });
  const page = fakePage({ rows: ['Invoice 5000000003 Oct 31, 2026', 'Invoice 5000000002 Sep 30, 2026', 'Invoice 5000000001 Aug 31, 2026'], body });
  await assert.rejects(run({ config: s.config, page, mailer: s.mailer, log: quiet, now: () => NOW }), err => err.kind === 'download' && /Fetched 1 of 2/.test(err.message));
  assert.equal(fs.readdirSync(s.outputDir).length, 2);
  assert.equal(s.sent.length, 2, 'the good one is still emailed');
});

test('a sign-in page stops the run before anything is saved', async () => {
  const { config, outputDir, mailer, page } = setup(['Invoice 5000000001 Sep 1, 2026'], { url: 'https://accounts.google.com/v3/signin/identifier' });
  await assert.rejects(run({ config, page, mailer, log: quiet, now: () => NOW }), err => err.kind === 'signin');
  assert.equal(fs.readdirSync(outputDir).length, 0);
});

test('no Drive folder: stops before opening the page', async () => {
  const { config, mailer, page } = setup([]);
  await assert.rejects(run({ config: { ...config, outputDir: path.join(config.outputDir, 'gone') }, page, mailer, log: quiet, now: () => NOW }), err => err.kind === 'save' && /Drive for desktop/.test(err.message));
});

test('a dry run changes nothing, and says what it would leave alone', async () => {
  const { config, outputDir, sent, mailer, page } = setup(REAL_ROWS, { tick: true });
  const result = await run({ config, page, mailer, log: quiet, now: () => NOW, dryRun: true });
  assert.deepEqual(result.wouldFetch, ['Google Cloud statement 2026-08-31.pdf']);
  assert.deepEqual(result.wouldSkip, ['Google Cloud statement 2026-07-31.pdf', 'Google Cloud statement 2026-06-30.pdf']);
  assert.equal(fs.readdirSync(outputDir).length, 0);
  assert.equal(sent.length, 0);
  assert.equal(fs.existsSync(config.stateFile), false);
});

test('helpers', () => {
  assert.equal(isSignInPage('https://accounts.google.com/ServiceLogin'), true);
  assert.equal(isSignInPage('https://console.cloud.google.com/'), false);
  assert.equal(looksLikePdf(PDF), true);
  assert.equal(looksLikePdf(Buffer.from('<html>')), false);
});
