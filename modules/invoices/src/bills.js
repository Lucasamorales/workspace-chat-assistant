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
 * "/invoices add Name | https://link | 5th working day | a@x, b@y" → a bill, or an InputError
 * saying what to fix. Who is reminded defaults to whoever adds it.
 */
function parseBill(args, { addedBy }) {
  const fields = String(args || '').split('|').map(s => s.trim());
  if (fields.length < 3 || fields.length > 4) {
    throw new InputError('Use: `/invoices add Name | https://link | 5th working day | who@example.com`\nThe last part is optional (it defaults to you); "day 1" works too.');
  }
  const [name, link, when, who = addedBy] = fields;
  if (!name || name.length > 40 || !slug(name)) throw new InputError('The name should be 1–40 characters, e.g. `Google Cloud`.');
  let url;
  try { url = new URL(link); } catch { url = null; }
  if (!url || url.protocol !== 'https:') throw new InputError(`\`${link}\` isn't an https link. Paste the page where the bill is downloaded.`);
  const ready = parseReady(when);
  if (!ready) throw new InputError(`I don't understand "${when}". Try \`5th working day\` or \`day 1\`.`);
  const remind = [...new Set(String(who).split(',').map(e => e.trim().toLowerCase()).filter(Boolean))];
  const bad = remind.filter(e => !EMAIL.test(e));
  if (!remind.length || bad.length) throw new InputError(`Who to remind should be work emails${bad.length ? `; this isn't one: ${bad.join(', ')}` : ''}.`);
  return { id: slug(name), name, url: url.toString(), ready, remind };
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

module.exports = { createBills, parseBill, slug, InputError, MAX_BILLS };
