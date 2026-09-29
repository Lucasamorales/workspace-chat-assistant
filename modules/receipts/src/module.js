/**
 * Receipts: reminds people when a receipt is ready to download, and links them to it.
 * (Called "invoices" until 2026-09-29; the name is retired.)
 *
 * Google Cloud has no API for its billing PDFs and blocks automated browsers from using a
 * person's sign-in (decision 0011), so Buddy doesn't fetch anything. It knows when each receipt is
 * usually ready, says so on the day with a button to the page, and stops once someone presses
 * "Downloaded". It never logs into anything and never touches the files.
 *
 * Who can see receipts and press the buttons: BUDDY_ACCESS_RECEIPTS. Who can add or remove receipts:
 * the receipts admin role. Who is reminded: each receipt's own list, and Buddy only delivers to
 * people on it who can also use the module.
 */

const { createReceipts, parseReceipt, slug, InputError } = require('./receipts');
const { createReceiptTools, INSTRUCTIONS } = require('./tools');
const { today, standing, afterReminder, afterLater } = require('./schedule');
const present = require('./present');

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const FOLDER_ID = /^[A-Za-z0-9_-]{10,}$/;
// Typing just this in a DM shows the receipts, free: no Claude, no cost.
const SHORTCUT = /^(receipts?|recibos?)[.!?]*$/i;

function createReceiptsModule({ now = () => Date.now() } = {}) {
  const zone = ctx => ctx.settings.RECEIPTS_TIMEZONE || present.DEFAULT_TZ;
  const dateFor = ctx => today(now(), zone(ctx));
  // Optional: the Drive folder people save them into, offered as a link. Buddy never reads it.
  const folderUrl = ctx => (FOLDER_ID.test(ctx.settings.RECEIPTS_FOLDER_ID || '') ? `https://drive.google.com/drive/folders/${ctx.settings.RECEIPTS_FOLDER_ID}` : null);

  // "google-cloud 2026-10", "Google Cloud 2026-10" or just "Google Cloud" (this month).
  function target(ctx, rest) {
    const words = String(rest || '').trim().split(/\s+/).filter(Boolean);
    const month = words.length > 1 && MONTH.test(words[words.length - 1]) ? words.pop() : dateFor(ctx).slice(0, 7);
    return { id: slug(words.join(' ')), month };
  }

  async function findReceipt(receipts, id) {
    const receipt = id && await receipts.get(id);
    if (!receipt) throw new InputError('I don\'t know that receipt. `/receipts` lists them.');
    return receipt;
  }

  async function list(ctx) {
    const receipts = createReceipts(ctx.store);
    const date = dateFor(ctx);
    const rows = await Promise.all((await receipts.list()).map(async receipt => ({
      receipt, standing: standing(receipt, await receipts.month(receipt.id, date.slice(0, 7)), date),
    })));
    return present.listReply(rows, { month: date.slice(0, 7), folderUrl: folderUrl(ctx), isAdmin: ctx.hasRole('admin') });
  }

  async function done(ctx, rest) {
    const receipts = createReceipts(ctx.store);
    const { id, month } = target(ctx, rest);
    const receipt = await findReceipt(receipts, id);
    let already = null;
    const saved = await receipts.updateMonth(id, month, current => {
      if (current && current.done) { already = current.done; return undefined; }
      return { ...(current || {}), done: { by: ctx.userEmail, at: new Date(now()).toISOString() } };
    });
    const record = already || saved.done;
    ctx.log.info('receipt marked downloaded', { receipt: id, month, by: record.by, already: Boolean(already) });
    return present.doneReply(receipt, month, record, { already: Boolean(already) });
  }

  async function later(ctx, rest) {
    const receipts = createReceipts(ctx.store);
    const { id, month } = target(ctx, rest);
    const receipt = await findReceipt(receipts, id);
    let already = null;
    const saved = await receipts.updateMonth(id, month, current => {
      if (current && current.done) { already = current.done; return undefined; }
      return afterLater(current, dateFor(ctx));
    });
    if (already) return present.doneReply(receipt, month, already, { already: true });
    return present.laterReply(receipt, saved.nextOn);
  }

  async function add(ctx, rest) {
    const receipt = parseReceipt(rest, { addedBy: ctx.userEmail });
    const result = await createReceipts(ctx.store).save(receipt, { by: ctx.userEmail, at: new Date(now()).toISOString() });
    ctx.log.info('receipt receipt saved', { receipt: receipt.id, replaced: result.replaced, by: ctx.userEmail });
    return present.savedReply(receipt, result);
  }

  async function remove(ctx, rest) {
    const receipts = createReceipts(ctx.store);
    const receipt = await findReceipt(receipts, slug(rest));
    await receipts.remove(receipt.id);
    ctx.log.info('receipt receipt removed', { receipt: receipt.id, by: ctx.userEmail });
    return `Removed **${receipt.name}**. Nobody will be reminded about it any more.`;
  }

  // What the reminder looks like, to the admin only, without counting as a reminder.
  async function preview(ctx, rest) {
    const receipts = createReceipts(ctx.store);
    const { id, month } = target(ctx, rest);
    const receipt = await findReceipt(receipts, id);
    const s = standing(receipt, await receipts.month(id, month), dateFor(ctx));
    return present.reminder(receipt, { ...s, reminded: s.reminded || [] }, { folderUrl: folderUrl(ctx) });
  }

  /**
   * Every morning: who to remind about what. A reminder is recorded as sent once it's handed to
   * Buddy, even if a delivery then fails (someone who never opened a chat with Buddy, say):
   * resending it all day would be worse, and it is always in /receipts.
   */
  async function daily(ctx) {
    const receipts = createReceipts(ctx.store);
    const date = dateFor(ctx);
    const month = date.slice(0, 7);
    const notes = [];
    for (const receipt of await receipts.list()) {
      try {
        let due = null;
        await receipts.updateMonth(receipt.id, month, current => {
          const s = standing(receipt, current, date);
          if (!s.remindNow) return undefined;
          due = s;
          return afterReminder(current, date);
        });
        if (due) notes.push({ to: receipt.remind, reply: present.reminder(receipt, due, { folderUrl: folderUrl(ctx) }) });
      } catch (error) {
        // One receipt's trouble never stops the others' reminders.
        ctx.log.error('receipt reminder failed', { receipt: receipt.id, error });
      }
    }
    ctx.log.info('receipts checked', { date, reminders: notes.length });
    return notes;
  }

  // The "+ Add a receipt" button: what to say next, in words. The answer goes to Claude.
  const start = () => ({
    title: 'Add a receipt',
    text: [
      'Tell me, in your own words:',
      '• the **name** (e.g. Adobe)',
      '• the **link** to the page where the receipt is downloaded',
      '• **when** it\'s usually ready: a working day of the month ("the 5th working day") or a day ("the 1st")',
      '• and who to remind, if not just you.',
      '',
      'For example: "Add Adobe, it\'s ready on the 1st, here\'s the page: https://account.adobe.com/billing"',
      'I\'ll show you what I understood before saving anything.',
    ].join('\n'),
  });

  const ADMIN = { add, remove, preview, new: start };
  const ANYONE = { done, later };

  return {
    name: 'receipts',
    description: 'Reminders when receipts are ready to download',
    allowedIn: ['DM'],
    roles: ['admin'],
    // Someone in accounts can add and check receipts by asking, without being given free-form Claude
    // (docs/decisions/0007-scoped-conversation.md). Every change still waits for an approval click.
    scopedConversation: true,
    // Required alongside scopedConversation. It hides nothing here: anyone with this module can
    // talk to it, so the commands and reminders stay visible to everyone with access.
    needsConversation: true,
    instructions: INSTRUCTIONS,
    examples: ['What receipts are due?', 'Add Adobe: ready on the 1st, https://account.adobe.com/billing'],

    commands: {
      receipts: {
        description: 'Your receipts: what\'s due, what\'s done, and where to download them',
        usage: '/receipts [done|later <receipt>] · admins: add, remove, preview',
        async run(ctx, args) {
          const [word = ''] = String(args || '').trim().split(/\s+/);
          const sub = word.toLowerCase();
          const rest = String(args || '').trim().slice(word.length).trim();
          try {
            if (!sub) return await list(ctx);
            if (ANYONE[sub]) return await ANYONE[sub](ctx, rest);
            if (ADMIN[sub]) {
              if (!ctx.hasRole('admin')) return 'Only receipts admins can add, remove or preview receipts.';
              return await ADMIN[sub](ctx, rest);
            }
            return 'Use `/receipts`, or `/receipts done <receipt>` once you have downloaded it.';
          } catch (error) {
            if (error instanceof InputError) return error.message;
            throw error;
          }
        },
      },
    },

    quickActions: async () => [{ text: 'Receipts', command: 'receipts' }],

    async handleMessage(ctx, message) {
      if (message.space.kind !== 'DM' || !SHORTCUT.test(String(message.argumentText || message.text || '').trim())) return null;
      return list(ctx);
    },

    async tools(ctx) {
      return createReceiptTools(ctx, { date: () => dateFor(ctx), now });
    },

    async onSchedule(ctx, task) {
      if (task !== 'daily') return [];
      return daily(ctx);
    },
  };
}

module.exports = { createReceiptsModule };
