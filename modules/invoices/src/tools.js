/**
 * What Claude can do with invoices when someone asks in words: list the bills, and — behind
 * Buddy's approval card — add or change one, stop one, or mark a month downloaded.
 *
 * Adding, changing and stopping bills are for invoices admins only: those tools aren't offered to
 * anyone else, and are refused again when they run. The checks are the same as the typed command's
 * (bills.js), so a bill can't be saved in words that couldn't be saved by typing.
 */

const { createBills, makeBill, slug, InputError } = require('./bills');
const { standing, nextDue, describeReady } = require('./schedule');
const { statusLine, short } = require('./present');

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const KINDS = { working_day: 'workday', day_of_month: 'day' };

const DEFINITIONS = {
  list_bills: {
    description: 'List every bill Buddy reminds people about: its link, when it is usually ready, this month\'s status (due, downloaded and by whom, reminders sent) and who is reminded. Read-only.',
    input_schema: { type: 'object', properties: {} },
  },
  save_bill: {
    description: 'Add a bill, or change one (same name). For a new bill give the name, the https page where it is downloaded, and when it is usually ready. For a change give the name and only what changes. Asks the person to approve first.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'e.g. "Google Cloud", "Adobe"' },
        url: { type: 'string', description: 'The https page where the bill is downloaded. Never guess one.' },
        when_kind: { type: 'string', enum: ['working_day', 'day_of_month'], description: 'working_day: the Nth working day (Mon–Fri) of the month. day_of_month: day N of the month.' },
        when_n: { type: 'integer', description: 'N: 1–23 for working_day, 1–31 for day_of_month' },
        remind: { type: 'array', items: { type: 'string' }, description: 'Work emails to remind. Leave out to keep the current list (or, for a new bill, the person asking).' },
      },
      required: ['name'],
    },
  },
  remove_bill: {
    description: 'Stop reminding about a bill. Past months\' records are kept. Asks the person to approve first.',
    input_schema: { type: 'object', properties: { bill: { type: 'string', description: 'The bill\'s name' } }, required: ['bill'] },
  },
  mark_downloaded: {
    description: 'Record that a bill has been downloaded for a month, which stops its reminders for everyone. Asks the person to approve first.',
    input_schema: {
      type: 'object',
      properties: {
        bill: { type: 'string', description: 'The bill\'s name' },
        month: { type: 'string', description: 'YYYY-MM; leave out for this month' },
      },
      required: ['bill'],
    },
  },
};
const ADMIN_TOOLS = ['save_bill', 'remove_bill'];

function createInvoiceTools(ctx, { date, now }) {
  const bills = createBills(ctx.store);
  const isAdmin = ctx.hasRole('admin');
  const readyFrom = input => (input.when_kind || input.when_n !== undefined
    ? { kind: KINDS[input.when_kind], n: Number(input.when_n) }
    : undefined);

  async function known(name) {
    const bill = await bills.get(slug(name));
    if (!bill) throw new InputError(`There's no bill called "${name}". list_bills shows them.`);
    return bill;
  }

  // Everything a call will do, worked out without doing it: the approval card shows it, and an
  // invalid call is caught here before anyone is asked to approve something that can't be saved.
  async function plan(name, input) {
    if (ADMIN_TOOLS.includes(name) && !isAdmin) throw new InputError('Only invoices admins can add, change or stop bills.');
    if (name === 'save_bill') {
      const existing = await bills.get(slug(input.name));
      const bill = makeBill({ name: input.name, url: input.url, ready: readyFrom(input), remind: input.remind }, { addedBy: ctx.userEmail, existing });
      return { bill, existing };
    }
    if (name === 'remove_bill') return { bill: await known(input.bill) };
    if (name === 'mark_downloaded') {
      const month = input.month || date().slice(0, 7);
      if (!MONTH.test(month)) throw new InputError(`"${input.month}" isn't a month; use YYYY-MM.`);
      return { bill: await known(input.bill), month };
    }
    throw new InputError(`Unknown tool ${name}.`);
  }

  const readyLine = (bill, d) => `${describeReady(bill.ready)} · next: ${short(nextDue(bill.ready, d))}`;

  return {
    definitions: Object.entries(DEFINITIONS)
      .filter(([name]) => isAdmin || !ADMIN_TOOLS.includes(name))
      .map(([name, def]) => ({ name, ...def })),

    // Listing changes nothing. Neither does a call that can't be carried out: it fails at once
    // with a sentence to pass on, instead of an approval card for something that won't work.
    async needsApproval(name, input) {
      if (name === 'list_bills') return false;
      try { await plan(name, input); return true; } catch (e) { if (e instanceof InputError) return false; throw e; }
    },

    async describe(name, input) {
      const p = await plan(name, input);
      const d = date();
      if (name === 'save_bill') {
        const { bill, existing } = p;
        // On a change, each line says what it was, so the card shows exactly what moves.
        const was = (value, before) => (existing && before !== value ? `${value} (was ${before})` : value);
        return {
          title: existing ? `Change a bill: ${bill.name}` : `Add a bill: ${bill.name}`,
          effect: existing ? 'update' : 'create',
          fields: [
            { label: 'Link', value: was(bill.url, existing && existing.url) },
            { label: 'Ready', value: was(readyLine(bill, d), existing && readyLine(existing, d)) },
            { label: 'Reminds', value: was(bill.remind.join(', '), existing && existing.remind.join(', ')) },
          ],
        };
      }
      if (name === 'remove_bill') {
        return {
          title: `Stop reminders: ${p.bill.name}`,
          effect: 'change',
          fields: [{ label: 'Bill', value: p.bill.name }, { label: 'Nobody is reminded any more', value: p.bill.remind.join(', ') }],
        };
      }
      return {
        title: `Mark downloaded: ${p.bill.name}`,
        effect: 'update',
        fields: [{ label: 'Month', value: p.month }, { label: 'Stops reminders for', value: p.bill.remind.join(', ') }],
      };
    },

    async execute(name, input) {
      const d = date();
      if (name === 'list_bills') {
        const all = await bills.list();
        if (!all.length) return { content: 'No bills yet.' };
        const lines = await Promise.all(all.map(async bill => {
          const s = standing(bill, await bills.month(bill.id, d.slice(0, 7)), d);
          return `- ${bill.name} | ${bill.url} | ready on the ${readyLine(bill, d)} | ${statusLine(s)} | reminds ${bill.remind.join(', ')}`;
        }));
        return { content: `Today is ${d}.\n${lines.join('\n')}` };
      }
      const p = await plan(name, input);
      const at = new Date(now()).toISOString();
      if (name === 'save_bill') {
        const { replaced } = await bills.save(p.bill, { by: ctx.userEmail, at });
        ctx.log.info('invoice bill saved', { bill: p.bill.id, replaced, by: ctx.userEmail, via: 'conversation' });
        return { content: `${replaced ? 'Changed' : 'Added'} ${p.bill.name}: ready on the ${readyLine(p.bill, d)}, reminds ${p.bill.remind.join(', ')}.` };
      }
      if (name === 'remove_bill') {
        await bills.remove(p.bill.id);
        ctx.log.info('invoice bill removed', { bill: p.bill.id, by: ctx.userEmail, via: 'conversation' });
        return { content: `Stopped reminders for ${p.bill.name}.` };
      }
      let already = null;
      await bills.updateMonth(p.bill.id, p.month, current => {
        if (current && current.done) { already = current.done; return undefined; }
        return { ...(current || {}), done: { by: ctx.userEmail, at } };
      });
      ctx.log.info('invoice marked downloaded', { bill: p.bill.id, month: p.month, by: ctx.userEmail, via: 'conversation' });
      return { content: already ? `${p.bill.name} ${p.month} was already marked downloaded by ${already.by}.` : `${p.bill.name} ${p.month} marked downloaded; its reminders stop.` };
    },
  };
}

const INSTRUCTIONS = 'Bills (invoices module): people download bills themselves and Buddy reminds them when one is ready; Buddy cannot '
  + 'log in anywhere or download a bill, so say so if asked. Use list_bills for what is due or done. A bill needs a name, the https '
  + 'page where it is downloaded, and when it is usually ready: the Nth working day of the month, or day N of the month. If the person '
  + 'says it another way ("the first Monday", "around the 5th"), use the closest of those two and say how you read it. Never invent a '
  + 'link: ask for it. To change a bill, pass only what changes.';

module.exports = { createInvoiceTools, INSTRUCTIONS, DEFINITIONS };
