/**
 * Invoices: reminds people when a bill is ready to download, and links them to it.
 *
 * Google Cloud has no API for its invoice PDFs and blocks automated browsers from using a
 * person's sign-in (decision 0011), so Buddy doesn't fetch anything. It knows when each bill is
 * usually ready, says so on the day with a button to the page, and stops once someone presses
 * "Downloaded". It never logs into anything and never touches the files.
 *
 * Who can see bills and press the buttons: BUDDY_ACCESS_INVOICES. Who can add or remove bills:
 * the invoices admin role. Who is reminded: each bill's own list, and Buddy only delivers to
 * people on it who can also use the module.
 */

const { createBills, parseBill, slug, InputError } = require('./bills');
const { today, standing, afterReminder, afterLater } = require('./schedule');
const present = require('./present');

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const FOLDER_ID = /^[A-Za-z0-9_-]{10,}$/;

function createInvoicesModule({ now = () => Date.now() } = {}) {
  const zone = ctx => ctx.settings.INVOICES_TIMEZONE || present.DEFAULT_TZ;
  const dateFor = ctx => today(now(), zone(ctx));
  // Optional: the Drive folder people save them into, offered as a link. Buddy never reads it.
  const folderUrl = ctx => (FOLDER_ID.test(ctx.settings.INVOICES_FOLDER_ID || '') ? `https://drive.google.com/drive/folders/${ctx.settings.INVOICES_FOLDER_ID}` : null);

  // "google-cloud 2026-10", "Google Cloud 2026-10" or just "Google Cloud" (this month).
  function target(ctx, rest) {
    const words = String(rest || '').trim().split(/\s+/).filter(Boolean);
    const month = words.length > 1 && MONTH.test(words[words.length - 1]) ? words.pop() : dateFor(ctx).slice(0, 7);
    return { id: slug(words.join(' ')), month };
  }

  async function findBill(bills, id) {
    const bill = id && await bills.get(id);
    if (!bill) throw new InputError('I don\'t know that bill. `/invoices` lists them.');
    return bill;
  }

  async function list(ctx) {
    const bills = createBills(ctx.store);
    const date = dateFor(ctx);
    const rows = await Promise.all((await bills.list()).map(async bill => ({
      bill, standing: standing(bill, await bills.month(bill.id, date.slice(0, 7)), date),
    })));
    return present.listReply(rows, { folderUrl: folderUrl(ctx), isAdmin: ctx.hasRole('admin') });
  }

  async function done(ctx, rest) {
    const bills = createBills(ctx.store);
    const { id, month } = target(ctx, rest);
    const bill = await findBill(bills, id);
    let already = null;
    const saved = await bills.updateMonth(id, month, current => {
      if (current && current.done) { already = current.done; return undefined; }
      return { ...(current || {}), done: { by: ctx.userEmail, at: new Date(now()).toISOString() } };
    });
    const record = already || saved.done;
    ctx.log.info('invoice marked downloaded', { bill: id, month, by: record.by, already: Boolean(already) });
    return present.doneReply(bill, month, record, { already: Boolean(already) });
  }

  async function later(ctx, rest) {
    const bills = createBills(ctx.store);
    const { id, month } = target(ctx, rest);
    const bill = await findBill(bills, id);
    let already = null;
    const saved = await bills.updateMonth(id, month, current => {
      if (current && current.done) { already = current.done; return undefined; }
      return afterLater(current, dateFor(ctx));
    });
    if (already) return present.doneReply(bill, month, already, { already: true });
    return present.laterReply(bill, saved.nextOn);
  }

  async function add(ctx, rest) {
    const bill = parseBill(rest, { addedBy: ctx.userEmail });
    const result = await createBills(ctx.store).save(bill, { by: ctx.userEmail, at: new Date(now()).toISOString() });
    ctx.log.info('invoice bill saved', { bill: bill.id, replaced: result.replaced, by: ctx.userEmail });
    return present.savedReply(bill, result);
  }

  async function remove(ctx, rest) {
    const bills = createBills(ctx.store);
    const bill = await findBill(bills, slug(rest));
    await bills.remove(bill.id);
    ctx.log.info('invoice bill removed', { bill: bill.id, by: ctx.userEmail });
    return `Removed **${bill.name}**. Nobody will be reminded about it any more.`;
  }

  // What the reminder looks like, to the admin only, without counting as a reminder.
  async function preview(ctx, rest) {
    const bills = createBills(ctx.store);
    const { id, month } = target(ctx, rest);
    const bill = await findBill(bills, id);
    const s = standing(bill, await bills.month(id, month), dateFor(ctx));
    return present.reminder(bill, { ...s, reminded: s.reminded || [] }, { folderUrl: folderUrl(ctx) });
  }

  /**
   * Every morning: who to remind about what. A reminder is recorded as sent once it's handed to
   * Buddy, even if a delivery then fails (someone who never opened a chat with Buddy, say):
   * resending it all day would be worse, and it is always in /invoices.
   */
  async function daily(ctx) {
    const bills = createBills(ctx.store);
    const date = dateFor(ctx);
    const month = date.slice(0, 7);
    const notes = [];
    for (const bill of await bills.list()) {
      try {
        let due = null;
        await bills.updateMonth(bill.id, month, current => {
          const s = standing(bill, current, date);
          if (!s.remindNow) return undefined;
          due = s;
          return afterReminder(current, date);
        });
        if (due) notes.push({ to: bill.remind, reply: present.reminder(bill, due, { folderUrl: folderUrl(ctx) }) });
      } catch (error) {
        // One bill's trouble never stops the others' reminders.
        ctx.log.error('invoice reminder failed', { bill: bill.id, error });
      }
    }
    ctx.log.info('invoices checked', { date, reminders: notes.length });
    return notes;
  }

  const ADMIN = { add, remove, preview };
  const ANYONE = { done, later };

  return {
    name: 'invoices',
    description: 'Reminders when bills are ready to download',
    allowedIn: ['DM'],
    roles: ['admin'],
    examples: ['/invoices'],

    commands: {
      invoices: {
        description: 'Your bills: what\'s due, what\'s done, and where to download them',
        usage: '/invoices [done|later <bill>] · admins: add, remove, preview',
        async run(ctx, args) {
          const [word = ''] = String(args || '').trim().split(/\s+/);
          const sub = word.toLowerCase();
          const rest = String(args || '').trim().slice(word.length).trim();
          try {
            if (!sub) return await list(ctx);
            if (ANYONE[sub]) return await ANYONE[sub](ctx, rest);
            if (ADMIN[sub]) {
              if (!ctx.hasRole('admin')) return 'Only invoices admins can add, remove or preview bills.';
              return await ADMIN[sub](ctx, rest);
            }
            return 'Use `/invoices`, or `/invoices done <bill>` once you have downloaded it.';
          } catch (error) {
            if (error instanceof InputError) return error.message;
            throw error;
          }
        },
      },
    },

    quickActions: async () => [{ text: 'Invoices', command: 'invoices' }],

    async onSchedule(ctx, task) {
      if (task !== 'daily') return [];
      return daily(ctx);
    },
  };
}

module.exports = { createInvoicesModule };
