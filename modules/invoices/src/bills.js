/**
 * The bills Buddy reminds people about, and each month's record of them. Storage only, plus the
 * checks on what an admin types: nothing here decides when to remind.
 *
 *   m_invoices__bills     one per bill: name, link, when it's ready, who is reminded
 *   m_invoices__months    one per bill per month: who marked it downloaded, reminders sent
 */

const { parseReady } = require('./schedule');

const MAX_BILLS = 30;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// "Google Cloud" → "google-cloud": the id buttons and commands use.
const slug = name => String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

class InputError extends Error {}

/**
 * A bill from its parts, checked, with a sentence saying what to fix if something's wrong. Used
 * by both the typed command and Claude's save_bill tool, so the same rules apply however it
 * arrives. With `existing`, missing parts keep their current value (a change, not a new bill).
 */
function makeBill({ name, url, ready, remind }, { addedBy, existing = null }) {
  // A change keeps the bill's name as it was first written: "adobe" in a sentence finds Adobe,
  // it doesn't rename it.
  const cleanName = String((existing && existing.name) || name || '').trim();
  if (!cleanName || cleanName.length > 40 || !slug(cleanName)) throw new InputError('The name should be 1–40 characters, e.g. `Google Cloud`.');
  const link = url === undefined || url === null || url === '' ? existing && existing.url : url;
  let parsed;
  try { parsed = new URL(String(link || '')); } catch { parsed = null; }
  if (!parsed || parsed.protocol !== 'https:') throw new InputError(`\`${link || '(no link)'}\` isn't an https link. Paste the page where the bill is downloaded.`);
  const when = ready || (existing && existing.ready);
  if (!when || !['workday', 'day'].includes(when.kind) || !Number.isInteger(when.n) || when.n < 1 || when.n > (when.kind === 'workday' ? 23 : 31)) {
    throw new InputError('When is it ready? Either a working day of the month (e.g. the 5th working day) or a day of the month (e.g. day 1).');
  }
  const list = remind === undefined || remind === null ? (existing ? existing.remind : [addedBy]) : remind;
  const emails = [...new Set((Array.isArray(list) ? list : String(list).split(',')).map(e => String(e).trim().toLowerCase()).filter(Boolean))];
  const bad = emails.filter(e => !EMAIL.test(e));
  if (!emails.length || bad.length) throw new InputError(`Who to remind should be work emails${bad.length ? `; this isn't one: ${bad.join(', ')}` : ''}.`);
  return { id: slug(cleanName), name: cleanName, url: parsed.toString(), ready: { kind: when.kind, n: when.n }, remind: emails };
}

/**
 * "/invoices add Name | https://link | 5th working day | a@x, b@y" → a bill, or an InputError.
 * Who is reminded defaults to whoever adds it.
 */
function parseBill(args, { addedBy }) {
  const fields = String(args || '').split('|').map(s => s.trim());
  if (fields.length < 3 || fields.length > 4) {
    throw new InputError('Use: `/invoices add Name | https://link | 5th working day | who@example.com`\n'
      + 'The last part is optional (it defaults to you); "day 1" works too. Or just tell me in words.');
  }
  const [name, url, when, who] = fields;
  const ready = parseReady(when);
  if (!ready) throw new InputError(`I don't understand "${when}". Try \`5th working day\` or \`day 1\`.`);
  return makeBill({ name, url, ready, remind: who }, { addedBy });
}

function createBills(store) {
  const bills = store.collection('bills');
  const months = store.collection('months');
  const monthId = (billId, month) => `${billId}__${month}`;

  return {
    list: async () => (await bills.list({ field: 'name' })).sort((a, b) => a.name.localeCompare(b.name)),
    get: id => bills.get(id),

    // Adding a bill that exists replaces it (safe to run twice), and says so.
    async save(bill, { by, at }) {
      const existing = await bills.get(bill.id);
      if (!existing && (await bills.list({ field: 'name' })).length >= MAX_BILLS) {
        throw new InputError(`There are already ${MAX_BILLS} bills; remove one first.`);
      }
      await bills.set(bill.id, { ...bill, addedBy: existing ? existing.addedBy : by, addedAt: existing ? existing.addedAt : at, changedAt: at });
      return { replaced: Boolean(existing) };
    },
    // The months stay: they are the record of who downloaded what, and cost nothing.
    remove: id => bills.delete(id),

    month: (billId, month) => months.get(monthId(billId, month)),
    // In a transaction, so "Downloaded" and a reminder landing together can't undo each other.
    // `fn` returns the new record, or undefined to leave it as it is.
    updateMonth: (billId, month, fn) => months.update(monthId(billId, month), current => {
      const next = fn(current);
      return next === undefined ? undefined : { ...next, bill: billId, month };
    }),
  };
}

module.exports = { createBills, makeBill, parseBill, slug, InputError, MAX_BILLS };
