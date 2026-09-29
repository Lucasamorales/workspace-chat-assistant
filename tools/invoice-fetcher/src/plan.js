// Deciding, never doing: what's on the page, what's new, what each file is called, what to say.
// No browser, no disk, no mail here, so all of it is tested with plain values.
const crypto = require('node:crypto');

const DAY = 24 * 3600 * 1000;
// On the first run the whole history is saved to Drive, but only the recent ones are emailed:
// nobody wants three years of PDFs in their inbox on day one.
const FIRST_RUN_MAIL_DAYS = 35;

class FetchError extends Error {
  constructor(kind, message, extra = {}) { super(message); this.kind = kind; Object.assign(this, extra); }
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const SPANISH = { ene: 0, abr: 3, ago: 7, dic: 11, set: 8 };
function monthIndex(word) {
  const w = word.toLowerCase().slice(0, 3);
  return MONTHS.includes(w) ? MONTHS.indexOf(w) : (w in SPANISH ? SPANISH[w] : -1);
}
const pad = n => String(n).padStart(2, '0');
const iso = (y, m, d) => (m >= 0 && m < 12 && d >= 1 && d <= 31 && y > 2000 && y < 2100 ? `${y}-${pad(m + 1)}-${pad(d)}` : null);

// The console prints dates however the account's language likes: 2026-09-01, Sep 1, 2026,
// 1 Sept 2026, 1 de sep. de 2026. Returns YYYY-MM-DD or null; never guesses day/month order
// from all-number dates other than ISO, because 03/04 means different things in each country.
function invoiceDate(text) {
  const s = String(text || '');
  let m = s.match(/\b(20\d\d)-(\d\d)-(\d\d)\b/);
  if (m) return iso(+m[1], +m[2] - 1, +m[3]);
  m = s.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(20\d\d)\b/);
  if (m && monthIndex(m[1]) >= 0) return iso(+m[3], monthIndex(m[1]), +m[2]);
  m = s.match(/\b(\d{1,2})\s+(?:de\s+)?([A-Za-z]{3,9})\.?\s+(?:de\s+)?(20\d\d)\b/);
  if (m && monthIndex(m[2]) >= 0) return iso(+m[3], monthIndex(m[2]), +m[1]);
  return null;
}

// Google's invoice numbers are long runs of digits; that is what makes an invoice "the same
// one" between runs. Without one, the row's own text stands in, minus the button words.
function documentId(rowText) {
  const text = String(rowText || '').replace(/\s+/g, ' ').trim();
  const number = text.match(/\b\d{10,13}\b/);
  if (number) return { id: `doc:${number[0]}`, number: number[0] };
  const stable = text.toLowerCase().replace(/\b(download|descargar|pdf|csv|view|ver)\b/g, '').replace(/\s+/g, ' ').trim();
  if (!stable) return { id: null, number: null };
  return { id: `row:${crypto.createHash('sha256').update(stable).digest('hex').slice(0, 16)}`, number: null };
}

// Names that sort by date in Drive and survive Windows: no slashes, colons or other oddities.
function fileName({ date, number }) {
  const safe = s => String(s).replace(/[^A-Za-z0-9 ._-]/g, '').trim();
  return `Google Cloud invoice ${safe(date)}${number ? ` ${safe(number)}` : ''}.pdf`;
}

function today(now, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
}

const emptyState = () => ({ version: 1, initialisedAt: null, documents: {} });

/**
 * candidates: what billing.js found, [{ rowText, href, label, locator }].
 * Returns what to fetch (new ones), what is saved but not yet emailed, and the counts.
 * Throws a 'layout' FetchError when the page doesn't look like the one we know.
 */
function plan(candidates, state, { now, timeZone, maxPerRun }) {
  const byId = new Map();
  for (const c of candidates) {
    const { id, number } = documentId(c.rowText);
    if (!id) continue;
    const pdfish = /pdf/i.test(`${c.href || ''} ${c.label || ''}`);
    const existing = byId.get(id);
    // One row can offer several links (PDF and CSV); the PDF one wins.
    if (!existing || (pdfish && !existing.pdfish)) {
      const date = invoiceDate(c.rowText);
      byId.set(id, { ...c, id, number, date, pdfish, fileName: fileName({ date: date || today(now, timeZone), number }) });
    }
  }
  if (!byId.size) {
    throw new FetchError('layout', candidates.length
      ? `Found ${candidates.length} download buttons but none in a row I could recognise as an invoice.`
      : 'Found no invoices at all on the billing documents page.');
  }
  const firstRun = !state.initialisedAt;
  const toFetch = [...byId.values()].filter(d => !state.documents[d.id]);
  if (!firstRun && toFetch.length > maxPerRun) {
    throw new FetchError('layout', `The page offers ${toFetch.length} invoices I haven't seen, more than the ${maxPerRun} a run allows. That usually means the page changed and old invoices look new.`);
  }
  const unmailed = Object.entries(state.documents).filter(([, d]) => d.mailed === false).map(([id, d]) => ({ id, ...d }));
  return { toFetch, unmailed, firstRun, seen: byId.size };
}

// Whether a newly saved invoice is emailed. Only the first run holds back, and only old ones.
function shouldMail(doc, { firstRun, now }) {
  if (!firstRun) return true;
  if (!doc.date) return true;
  return Date.parse(`${doc.date}T12:00:00Z`) >= now - FIRST_RUN_MAIL_DAYS * DAY;
}

// State updates return a new state; the caller writes it after each step, so a crash
// half-way never forgets a file already saved nor emails one twice.
function recordSaved(state, doc, { now, mail }) {
  return {
    ...state,
    documents: { ...state.documents, [doc.id]: { file: doc.fileName, date: doc.date, savedAt: new Date(now).toISOString(), mailed: mail ? false : 'first-run' } },
  };
}
function recordMailed(state, ids) {
  const documents = { ...state.documents };
  for (const id of ids) if (documents[id]) documents[id] = { ...documents[id], mailed: true };
  return { ...state, documents };
}
function recordRun(state, { now }) {
  return { ...state, initialisedAt: state.initialisedAt || new Date(now).toISOString(), lastRunAt: new Date(now).toISOString() };
}

/* ---------- what the emails say ---------- */

function invoicesMail(docs, { billingAccountId }) {
  const n = docs.length;
  return {
    subject: n === 1 ? `Google Cloud invoice ${docs[0].date || ''}`.trim() : `${n} Google Cloud invoices`,
    text: [
      `${n === 1 ? 'A new Google Cloud invoice is' : `${n} new Google Cloud invoices are`} attached, for billing account ${billingAccountId}.`,
      '',
      ...docs.map(d => `- ${d.file || d.fileName}`),
      '',
      'They are in the Buddy invoices folder in Drive too, and Buddy lists them with /invoices.',
    ].join('\n'),
  };
}

const ALERTS = {
  signin: {
    subject: 'Invoice fetcher: sign in to Google again',
    action: 'The saved Google session has expired or was signed out. On the PC, run:\n\n  npm run login\n\n(in tools/invoice-fetcher), sign in in the Chrome window that opens, and close it. The next run picks up from there.',
  },
  layout: {
    subject: 'Invoice fetcher: the billing page looks different',
    action: 'Google may have changed the page. The screenshot shows what the fetcher saw. On the PC, run:\n\n  npm run inspect\n\nand adjust SELECTORS in src/billing.js to match.',
  },
  save: {
    subject: 'Invoice fetcher: could not save to Drive',
    action: 'Check Drive for desktop is running and signed in, and that outputDir in config.local.json still points at the invoices folder.',
  },
  download: {
    subject: 'Invoice fetcher: a download failed',
    action: 'The invoice below didn\'t download as a PDF. It will be tried again next run; if it keeps failing, run npm run inspect.',
  },
  unexpected: {
    subject: 'Invoice fetcher: the run failed',
    action: 'Something unexpected went wrong. The log on the PC has the details (logDir in config.js).',
  },
};

function alertMail(err, { billingAccountId, when }) {
  const kind = ALERTS[err.kind] ? err.kind : 'unexpected';
  return {
    kind,
    subject: ALERTS[kind].subject,
    text: [
      `The invoice fetcher for billing account ${billingAccountId} stopped at ${when}.`,
      '',
      `What happened: ${err.message}`,
      '',
      ALERTS[kind].action,
    ].join('\n'),
  };
}

module.exports = {
  FetchError, FIRST_RUN_MAIL_DAYS,
  invoiceDate, documentId, fileName, today, emptyState, plan, shouldMail,
  recordSaved, recordMailed, recordRun, invoicesMail, alertMail,
};
