// The browser layer: open the billing page, notice a lost session, find the download buttons,
// fetch a PDF. No decisions about what is new: that's plan.js.
//
// The selectors are the part Google can break. They live here, together, and `npm run inspect`
// prints what the page offers so they can be adjusted without guessing.
const { FetchError } = require('./plan');

const SELECTORS = {
  // Anything in any frame that looks like "download this document".
  download: [
    'a[href*=".pdf"]',
    'a[href*="download" i]',
    'a[aria-label*="download" i]',
    'button[aria-label*="download" i]',
    '[role="button"][aria-label*="download" i]',
    'a[aria-label*="descargar" i]',
    'button[aria-label*="descargar" i]',
  ].join(', '),
  // The row a button belongs to, whose text carries the invoice number and date.
  row: 'tr, [role="row"], li, mat-row, cfc-table-row',
  // The other layout, and the one the company's account has (payments.google.com document centre,
  // in a frame): no button per row, a checkbox per row and one "Download selected".
  selectableRow: 'tr:has(input[type="checkbox"]), [role="row"]:has(input[type="checkbox"]), [role="row"]:has([role="checkbox"])',
  checkbox: 'input[type="checkbox"], [role="checkbox"]',
  downloadSelected: 'download selected|descargar selecci',
  // What a Google sign-in or account chooser page has.
  signIn: 'input[type="email"], input[type="password"], #identifierId, [data-identifier]',
};

// Pages Google may send us through; anything else is not followed.
const GOOGLE_HOSTS = /(^|\.)(google\.com|googleusercontent\.com|gstatic\.com)$/;

function isSignInPage(url) {
  try { return new URL(url).hostname === 'accounts.google.com'; } catch { return false; }
}

async function open(page, config) {
  await page.goto(config.documentsUrl, { waitUntil: 'domcontentloaded', timeout: config.pageTimeoutMs });
  // The console keeps streaming after "load"; give its tables time to arrive.
  await page.waitForLoadState('networkidle', { timeout: config.pageTimeoutMs }).catch(() => {});
  await page.waitForTimeout(config.settleMs);
  if (isSignInPage(page.url()) || await page.locator(SELECTORS.signIn).count().catch(() => 0)) {
    throw new FetchError('signin', 'Google asked to sign in instead of showing the billing page.');
  }
  const host = new URL(page.url()).hostname;
  if (!GOOGLE_HOSTS.test(host)) throw new FetchError('layout', `The billing link ended up on ${host}, which isn't Google.`);
}

// Runs inside the page, one frame at a time. Kept small and self-contained on purpose: it can't
// see anything outside this function.
function collectInFrame({ download, row }) {
  return [...document.querySelectorAll(download)].map((el, index) => {
    const r = el.closest(row);
    return {
      index,
      label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 120),
      href: el.getAttribute('href') || '',
      rowText: (r ? r.innerText : '').replace(/\s+/g, ' ').trim().slice(0, 400),
    };
  });
}

// Same, for the checkbox layout: only in a frame that has a "Download selected" button.
function collectSelectableInFrame({ selectableRow, downloadSelected }) {
  const button = new RegExp(downloadSelected, 'i');
  const has = [...document.querySelectorAll('button, [role="button"]')].some(b => button.test((b.getAttribute('aria-label') || b.textContent || '').trim()));
  if (!has) return [];
  return [...document.querySelectorAll(selectableRow)].map((r, index) => ({
    index, mode: 'select', label: 'Download selected', href: '',
    rowText: r.innerText.replace(/\s+/g, ' ').trim().slice(0, 400),
  }));
}

async function findCandidates(page) {
  const out = [];
  for (const [frameIndex, frame] of page.frames().entries()) {
    const buttons = await frame.evaluate(collectInFrame, { download: SELECTORS.download, row: SELECTORS.row }).catch(() => []);
    const rows = await frame.evaluate(collectSelectableInFrame, { selectableRow: SELECTORS.selectableRow, downloadSelected: SELECTORS.downloadSelected }).catch(() => []);
    for (const c of [...buttons, ...rows]) out.push({ ...c, frameIndex, frameUrl: frame.url() });
  }
  return out;
}

const norm = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 400);

// Google's payments checkboxes are drawn with a decorative layer on top of them, so an ordinary
// click is refused as "intercepted" and waits forever. Click the checkbox itself regardless, then
// believe only its own aria-checked; if the click didn't take, Space does the same thing.
async function setTicked(box, want) {
  const is = () => box.isChecked().catch(() => null);
  if (await is() === want) return;
  await box.click({ force: true, timeout: 10_000 }).catch(() => {});
  if (await is() === want) return;
  await box.focus().catch(() => {});
  await box.press('Space').catch(() => {});
  if (await is() !== want) throw new FetchError('layout', `Couldn't ${want ? 'tick' : 'untick'} a row's checkbox on the statements page.`);
}

// Tick exactly one row, press "Download selected", untick it. The row is found again by its text,
// not its position: if the table redrew in between, a position could point at another month's
// document and it would be saved under the wrong name.
async function downloadByTicking(page, candidate, config) {
  const timeout = config.pageTimeoutMs;
  const frame = page.frames()[candidate.frameIndex];
  if (!frame) throw new FetchError('layout', 'The page redrew while downloading; the documents frame is gone.');
  const rows = frame.locator(SELECTORS.selectableRow);
  let target = null;
  for (let i = 0, n = await rows.count(); i < n && !target; i++) {
    if (norm(await rows.nth(i).innerText()) === candidate.rowText) target = rows.nth(i);
  }
  if (!target) throw new FetchError('layout', `${candidate.fileName}: its row is no longer on the page.`);

  // Any row already ticked (a previous attempt, "select all" in the header row) would come along
  // in the download. Only the table's own rows: the frame also has hidden, ticked checkboxes in
  // its column and filter panels, which can't be clicked and don't belong to the download.
  for (let i = 0, n = await rows.count(); i < n; i++) {
    const other = rows.nth(i).locator(SELECTORS.checkbox).first();
    if (await other.isVisible().catch(() => false) && await other.isChecked().catch(() => false)) await setTicked(other, false);
  }
  const box = target.locator(SELECTORS.checkbox).first();
  await setTicked(box, true);
  const arrival = nextDocument(page, timeout);
  try {
    // Google's payments buttons can ignore an automated click and answer only the keyboard, as the
    // checkboxes do. Each way of pressing it gets a few seconds before the next is tried, and all of
    // them feed the same wait, so whichever works first wins.
    const button = frame.getByRole('button', { name: new RegExp(SELECTORS.downloadSelected, 'i') }).first();
    const presses = [
      () => button.click({ timeout: 10_000 }),
      () => button.focus().then(() => button.press('Enter')),
      () => button.focus().then(() => button.press('Space')),
    ];
    for (const press of presses) {
      await press().catch(() => {});
      if (await Promise.race([arrival.then(() => true, () => true), sleep(config.pressWaitMs ?? 8_000).then(() => false)])) break;
    }
    return await arrival;
  } finally {
    arrival.cancel();
    await setTicked(box, false).catch(() => {});
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// The PDF may arrive as a download on this page, a download in a tab it opens, or a PDF the tab
// simply shows. Watch every tab for any of the three, from Google hosts only.
function nextDocument(page, timeout) {
  const context = page.context();
  const watched = new Set();
  let finish;
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(reject, new FetchError('download', 'Pressed "Download selected" but no download or PDF arrived.')), timeout);
    const onDownload = d => d.path().then(path => done(resolve, require('node:fs').readFileSync(path)), err => done(reject, err));
    const onResponse = r => {
      let host = '';
      try { host = new URL(r.url()).hostname; } catch { return; }
      if (GOOGLE_HOSTS.test(host) && /application\/pdf/i.test(r.headers()['content-type'] || '')) {
        r.body().then(bytes => done(resolve, bytes), () => {});
      }
    };
    const watch = p => {
      if (watched.has(p)) return;
      watched.add(p);
      p.on('download', onDownload);
      p.on('response', onResponse);
    };
    const onPage = p => watch(p);
    context.pages().forEach(watch);
    context.on('page', onPage);
    function done(settle, value) {
      clearTimeout(timer);
      context.off('page', onPage);
      for (const p of watched) { p.off('download', onDownload); p.off('response', onResponse); }
      // Close only the tabs this download opened, never the billing page itself.
      for (const p of watched) if (p !== page) p.close().catch(() => {});
      settle(value);
    }
    finish = () => done(() => {}, null);
  });
  promise.cancel = () => finish();
  return promise;
}

const looksLikePdf = buf => Buffer.isBuffer(buf) && buf.subarray(0, 5).toString('latin1') === '%PDF-';

// Returns the PDF's bytes. A plain link is fetched with the browser's own session; a button is
// clicked and the download it starts is caught. Either way it must really be a PDF.
async function download(page, candidate, config) {
  let bytes;
  if (candidate.mode === 'select') {
    bytes = await downloadByTicking(page, candidate, config);
    if (!looksLikePdf(bytes)) throw new FetchError('download', `${candidate.fileName}: what came back isn't a PDF (a zip, if Google bundles even a single document).`);
    return bytes;
  }
  const href = candidate.href && !/^javascript:/i.test(candidate.href) ? new URL(candidate.href, candidate.frameUrl).toString() : '';
  if (href && GOOGLE_HOSTS.test(new URL(href).hostname)) {
    const res = await page.context().request.get(href, { timeout: config.pageTimeoutMs });
    if (!res.ok()) throw new FetchError('download', `${candidate.fileName}: Google answered ${res.status()} to the download link.`);
    bytes = await res.body();
  } else {
    const frame = page.frames()[candidate.frameIndex];
    if (!frame) throw new FetchError('layout', 'The page redrew while downloading; the button moved.');
    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: config.pageTimeoutMs }),
      frame.locator(SELECTORS.download).nth(candidate.index).click({ timeout: config.pageTimeoutMs }),
    ]);
    const path = await dl.path();
    bytes = require('node:fs').readFileSync(path);
  }
  if (!looksLikePdf(bytes)) throw new FetchError('download', `${candidate.fileName}: what came back isn't a PDF.`);
  return bytes;
}

// For `npm run inspect`: what each frame holds, so SELECTORS can be matched to the real page.
async function describe(page) {
  const frames = [];
  for (const frame of page.frames()) {
    const summary = await frame.evaluate(() => ({
      title: document.title,
      links: [...document.querySelectorAll('a[href]')].slice(0, 60).map(a => `${(a.textContent || '').trim().slice(0, 60)} → ${a.getAttribute('href').slice(0, 120)}`),
      buttons: [...document.querySelectorAll('button, [role="button"]')].slice(0, 60).map(b => (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 80)).filter(Boolean),
      rows: [...document.querySelectorAll('tr, [role="row"]')].slice(0, 30).map(r => r.innerText.replace(/\s+/g, ' ').trim().slice(0, 200)),
    })).catch(err => ({ error: err.message }));
    frames.push({ url: frame.url(), ...summary });
  }
  return frames;
}

module.exports = { SELECTORS, isSignInPage, open, findCandidates, download, describe, looksLikePdf, collectInFrame, collectSelectableInFrame };
