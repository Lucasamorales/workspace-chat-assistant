/**
 * What Claude can do with receipts when someone asks in words: list the receipts, and — behind
 * Buddy's approval card — add or change one, stop one, or mark a month downloaded.
 *
 * Adding, changing and stopping receipts are for receipts admins only: those tools aren't offered to
 * anyone else, and are refused again when they run. The checks are the same as the typed command's
 * (receipts.js), so a receipt can't be saved in words that couldn't be saved by typing.
 */

const { createReceipts, makeReceipt, slug, InputError } = require('./receipts');
const { standing, nextDue, describeReady } = require('./schedule');
const { statusLine, short } = require('./present');

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const KINDS = { working_day: 'workday', day_of_month: 'day' };

const DEFINITIONS = {
  list_receipts: {
    description: 'List every receipt Buddy reminds people about: its link, when it is usually ready, this month\'s status (due, downloaded and by whom, reminders sent) and who is reminded. Read-only.',
    input_schema: { type: 'object', properties: {} },
  },
  save_receipt: {
    description: 'Add a receipt, or change one (same name). For a new receipt give the name, the https page where it is downloaded, and when it is usually ready. For a change give the name and only what changes. Asks the person to approve first.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'e.g. "Google Cloud", "Adobe"' },
        url: { type: 'string', description: 'The https page where the receipt is downloaded. Never guess one.' },
        when_kind: { type: 'string', enum: ['working_day', 'day_of_month'], description: 'working_day: the Nth working day (Mon–Fri) of the month. day_of_month: day N of the month.' },
        when_n: { type: 'integer', description: 'N: 1–23 for working_day, 1–31 for day_of_month' },
        remind: { type: 'array', items: { type: 'string' }, description: 'Work emails to remind. Leave out to keep the current list (or, for a new receipt, the person asking).' },
      },
      required: ['name'],
    },
  },
  remove_receipt: {
    description: 'Stop reminding about a receipt. Past months\' records are kept. Asks the person to approve first.',
    input_schema: { type: 'object', properties: { receipt: { type: 'string', description: 'The receipt\'s name' } }, required: ['receipt'] },
  },
  mark_downloaded: {
    description: 'Record that a receipt has been downloaded for a month, which stops its reminders for everyone. Asks the person to approve first.',
    input_schema: {
      type: 'object',
      properties: {
        receipt: { type: 'string', description: 'The receipt\'s name' },
        month: { type: 'string', description: 'YYYY-MM; leave out for this month' },
      },
      required: ['receipt'],
    },
  },
};
const ADMIN_TOOLS = ['save_receipt', 'remove_receipt'];

function createReceiptTools(ctx, { date, now }) {
  const receipts = createReceipts(ctx.store);
  const isAdmin = ctx.hasRole('admin');
  const readyFrom = input => (input.when_kind || input.when_n !== undefined
    ? { kind: KINDS[input.when_kind], n: Number(input.when_n) }
    : undefined);

  async function known(name) {
    const receipt = await receipts.get(slug(name));
    if (!receipt) throw new InputError(`There's no receipt called "${name}". list_receipts shows them.`);
    return receipt;
  }

  // Everything a call will do, worked out without doing it: the approval card shows it, and an
  // invalid call is caught here before anyone is asked to approve something that can't be saved.
  async function plan(name, input) {
    if (ADMIN_TOOLS.includes(name) && !isAdmin) throw new InputError('Only receipts admins can add, change or stop receipts.');
    if (name === 'save_receipt') {
      const existing = await receipts.get(slug(input.name));
      const receipt = makeReceipt({ name: input.name, url: input.url, ready: readyFrom(input), remind: input.remind }, { addedBy: ctx.userEmail, existing });
      return { receipt, existing };
    }
    if (name === 'remove_receipt') return { receipt: await known(input.receipt) };
    if (name === 'mark_downloaded') {
      const month = input.month || date().slice(0, 7);
      if (!MONTH.test(month)) throw new InputError(`"${input.month}" isn't a month; use YYYY-MM.`);
      return { receipt: await known(input.receipt), month };
    }
    throw new InputError(`Unknown tool ${name}.`);
  }

  const readyLine = (receipt, d) => `${describeReady(receipt.ready)} · next: ${short(nextDue(receipt.ready, d))}`;

  return {
    definitions: Object.entries(DEFINITIONS)
      .filter(([name]) => isAdmin || !ADMIN_TOOLS.includes(name))
      .map(([name, def]) => ({ name, ...def })),

    // Listing changes nothing. Neither does a call that can't be carried out: it fails at once
    // with a sentence to pass on, instead of an approval card for something that won't work.
    async needsApproval(name, input) {
      if (name === 'list_receipts') return false;
      try { await plan(name, input); return true; } catch (e) { if (e instanceof InputError) return false; throw e; }
    },

    async describe(name, input) {
      const p = await plan(name, input);
      const d = date();
      if (name === 'save_receipt') {
        const { receipt, existing } = p;
        // On a change, each line says what it was, so the card shows exactly what moves.
        const was = (value, before) => (existing && before !== value ? `${value} (was ${before})` : value);
        return {
          title: existing ? `Change a receipt: ${receipt.name}` : `Add a receipt: ${receipt.name}`,
          effect: existing ? 'update' : 'create',
          fields: [
            { label: 'Link', value: was(receipt.url, existing && existing.url) },
            { label: 'Ready', value: was(readyLine(receipt, d), existing && readyLine(existing, d)) },
            { label: 'Reminds', value: was(receipt.remind.join(', '), existing && existing.remind.join(', ')) },
          ],
        };
      }
      if (name === 'remove_receipt') {
        return {
          title: `Stop reminders: ${p.receipt.name}`,
          effect: 'change',
          fields: [{ label: 'Receipt', value: p.receipt.name }, { label: 'Nobody is reminded any more', value: p.receipt.remind.join(', ') }],
        };
      }
      return {
        title: `Mark downloaded: ${p.receipt.name}`,
        effect: 'update',
        fields: [{ label: 'Month', value: p.month }, { label: 'Stops reminders for', value: p.receipt.remind.join(', ') }],
      };
    },

    async execute(name, input) {
      const d = date();
      if (name === 'list_receipts') {
        const all = await receipts.list();
        if (!all.length) return { content: 'No receipts yet.' };
        const lines = await Promise.all(all.map(async receipt => {
          const s = standing(receipt, await receipts.month(receipt.id, d.slice(0, 7)), d);
          return `- ${receipt.name} | ${receipt.url} | ready on the ${readyLine(receipt, d)} | ${statusLine(s)} | reminds ${receipt.remind.join(', ')}`;
        }));
        return { content: `Today is ${d}.\n${lines.join('\n')}` };
      }
      const p = await plan(name, input);
      const at = new Date(now()).toISOString();
      if (name === 'save_receipt') {
        const { replaced } = await receipts.save(p.receipt, { by: ctx.userEmail, at });
        ctx.log.info('receipt receipt saved', { receipt: p.receipt.id, replaced, by: ctx.userEmail, via: 'conversation' });
        return { content: `${replaced ? 'Changed' : 'Added'} ${p.receipt.name}: ready on the ${readyLine(p.receipt, d)}, reminds ${p.receipt.remind.join(', ')}.` };
      }
      if (name === 'remove_receipt') {
        await receipts.remove(p.receipt.id);
        ctx.log.info('receipt receipt removed', { receipt: p.receipt.id, by: ctx.userEmail, via: 'conversation' });
        return { content: `Stopped reminders for ${p.receipt.name}.` };
      }
      let already = null;
      await receipts.updateMonth(p.receipt.id, p.month, current => {
        if (current && current.done) { already = current.done; return undefined; }
        return { ...(current || {}), done: { by: ctx.userEmail, at } };
      });
      ctx.log.info('receipt marked downloaded', { receipt: p.receipt.id, month: p.month, by: ctx.userEmail, via: 'conversation' });
      return { content: already ? `${p.receipt.name} ${p.month} was already marked downloaded by ${already.by}.` : `${p.receipt.name} ${p.month} marked downloaded; its reminders stop.` };
    },
  };
}

const INSTRUCTIONS = 'Receipts (receipts module): people download receipts themselves and Buddy reminds them when one is ready; Buddy cannot '
  + 'log in anywhere or download a receipt, so say so if asked. Use list_receipts for what is due or done. A receipt needs a name, the https '
  + 'page where it is downloaded, and when it is usually ready: the Nth working day of the month, or day N of the month. If the person '
  + 'says it another way ("the first Monday", "around the 5th"), use the closest of those two and say how you read it. Never invent a '
  + 'link: ask for it. To change a receipt, pass only what changes.';

module.exports = { createReceiptTools, INSTRUCTIONS, DEFINITIONS };
