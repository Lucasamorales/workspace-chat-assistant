// A whole run against a fake page, a fake mailer and a temporary folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../src/run');
const { loadConfig } = require('../config');
const { isSignInPage, looksLikePdf } = require('../src/billing');

const PDF = Buffer.from('%PDF-1.7 fake');
const NOW = Date.parse('2026-09-29T13:00:00Z');
const quiet = { info() {}, warn() {}, error() {} };

function fakePage({ rows = [], url = 'https://console.cloud.google.com/billing/x/invoices?organizationId=1', body = PDF, signInFields = 0 } = {}) {
  const frame = {
    url: () => url,
    evaluate: async () => rows.map((r, index) => ({ index, label: 'Download PDF', href: `https://payments.google.com/doc/${index}.pdf`, rowText: r })),
  };
  const fetched = [];
  return {
    fetched,
    goto: async () => {},
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    url: () => url,
    locator: () => ({ count: async () => signInFields }),
    frames: () => [frame],
    context: () => ({ request: { get: async href => { fetched.push(href); return { ok: () => true, status: () => 200, body: async () => (typeof body === 'function' ? body(href) : body) }; } } }),
  };
}

function setup(rows, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetcher-'));
  const outputDir = path.join(dir, 'drive');
  fs.mkdirSync(outputDir);
  const config = { ...loadConfig(__dirname), outputDir, stateFile: path.join(dir, 'state.json'), settleMs: 0 };
  const sent = [];
  const mailer = { send: async m => { if (opts.mailFails) throw new Error('smtp down'); sent.push(m); } };
  return { config, outputDir, sent, mailer, page: fakePage({ rows, ...opts }) };
}

test('new invoices are saved to Drive, emailed once, and remembered', async () => {
  const { config, outputDir, sent, mailer, page } = setup(['Invoice 5000000001 Sep 1, 2026', 'Invoice 5000000000 Sep 15, 2026']);
  const result = await run({ config, page, mailer, log: quiet, now: () => NOW });
  assert.deepEqual(fs.readdirSync(outputDir).sort(), ['Google Cloud invoice 2026-09-01 5000000001.pdf', 'Google Cloud invoice 2026-09-15 5000000000.pdf']);
  assert.equal(result.mailed, 2);
  assert.equal(sent[0].attachments.length, 2);
  assert.match(sent[0].subject, /2 Google Cloud invoices/);

  const again = await run({ config, page, mailer, log: quiet, now: () => NOW });
  assert.deepEqual(again.saved, []);
  assert.equal(sent.length, 1, 'nothing new: no second email');
});

test('the first run fills Drive with the history but emails only the recent ones', async () => {
  const { config, outputDir, sent, mailer, page } = setup(['Invoice 5000000001 Sep 1, 2026', 'Invoice 4000000000 Jan 1, 2025']);
  await run({ config, page, mailer, log: quiet, now: () => NOW });
  assert.equal(fs.readdirSync(outputDir).length, 2);
  assert.equal(sent[0].attachments.length, 1);
  assert.match(sent[0].attachments[0].filename, /2026-09-01/);
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
  const { config, outputDir, sent, mailer, page } = setup(['Invoice 5000000001 Sep 1, 2026', 'Invoice 5000000002 Sep 2, 2026'], { body });
  await assert.rejects(run({ config, page, mailer, log: quiet, now: () => NOW }), err => err.kind === 'download' && /Fetched 1 of 2/.test(err.message));
  assert.equal(fs.readdirSync(outputDir).length, 1);
  assert.equal(sent.length, 1, 'the good one is still emailed');
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

test('a dry run changes nothing', async () => {
  const { config, outputDir, sent, mailer, page } = setup(['Invoice 5000000001 Sep 1, 2026']);
  const result = await run({ config, page, mailer, log: quiet, now: () => NOW, dryRun: true });
  assert.deepEqual(result.wouldFetch, ['Google Cloud invoice 2026-09-01 5000000001.pdf']);
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
