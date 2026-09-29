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

async function findCandidates(page) {
  const out = [];
  for (const [frameIndex, frame] of page.frames().entries()) {
    const found = await frame.evaluate(collectInFrame, { download: SELECTORS.download, row: SELECTORS.row }).catch(() => []);
    for (const c of found) out.push({ ...c, frameIndex, frameUrl: frame.url() });
  }
  return out;
}

const looksLikePdf = buf => Buffer.isBuffer(buf) && buf.subarray(0, 5).toString('latin1') === '%PDF-';

// Returns the PDF's bytes. A plain link is fetched with the browser's own session; a button is
// clicked and the download it starts is caught. Either way it must really be a PDF.
async function download(page, candidate, config) {
  let bytes;
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

module.exports = { SELECTORS, isSignInPage, open, findCandidates, download, describe, looksLikePdf, collectInFrame };
