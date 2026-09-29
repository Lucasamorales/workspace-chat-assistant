/** Everything the invoices module says, as plain functions over plain data. */

const { describeReady, MAX_REMINDERS } = require('./schedule');

const DEFAULT_TZ = 'America/Argentina/Buenos_Aires';

/** "7 Oct" from "2026-10-07"; the date is already local, so it is read as UTC to stay put. */
const short = date => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(new Date(`${date}T12:00:00Z`));
const monthName = month => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'long' }).format(new Date(`${month}-15T12:00:00Z`));
const who = email => String(email).split('@')[0];
const folderButton = folderUrl => (folderUrl ? [{ text: 'Invoices folder', url: folderUrl }] : []);

function statusLine(s) {
  if (s.state === 'done') return `✅ ${monthName(s.month)}: downloaded by ${who(s.done.by)} on ${short(s.done.at.slice(0, 10))}`;
  if (s.state === 'upcoming') return `🗓️ ${monthName(s.month)}: due ${short(s.due)}`;
  const times = s.reminded.length;
  return `⏳ ${monthName(s.month)}: due since ${short(s.due)}, not downloaded yet${times ? ` (reminded ${times}×${s.gaveUp ? ', no more reminders this month' : ''})` : ''}`;
}

function listReply(rows, { folderUrl, isAdmin }) {
  if (!rows.length) {
    return {
      title: 'Invoices',
      text: isAdmin
        ? 'No bills yet. Add one:\n`/invoices add Google Cloud | https://link | 5th working day`'
        : 'No bills have been set up yet.',
    };
  }
  const blocks = rows.map(({ bill, standing }) => [
    `**[${bill.name.replace(/[[\]]/g, '')}](${bill.url})** · ready on the ${describeReady(bill.ready)}`,
    statusLine(standing),
    ...(isAdmin ? [`Reminds: ${bill.remind.join(', ')}`] : []),
  ].join('\n'));
  const pending = rows.filter(r => r.standing.state === 'pending');
  return {
    title: 'Invoices',
    text: [
      blocks.join('\n\n'),
      ...(isAdmin ? ['', 'Add or change one: `/invoices add Name | https://link | 5th working day | who@…` · stop one: `/invoices remove Name`'] : []),
    ].join('\n'),
    buttons: [
      ...pending.slice(0, 3).map(r => ({ text: `✓ ${r.bill.name} downloaded`, command: 'invoices', args: `done ${r.bill.id} ${r.standing.month}` })),
      ...folderButton(folderUrl),
    ],
  };
}

function reminder(bill, s, { folderUrl }) {
  const nth = s.reminded.length + 1;
  return {
    title: `🧾 ${bill.name}: this month's bill should be ready`,
    text: [
      `It's usually out by the ${describeReady(bill.ready)} (${short(s.due)}). Download it from the billing page${folderUrl ? ' and save it in the invoices folder' : ''}.`,
      'Press **Downloaded** when you have it and I\'ll stop reminding everyone.',
      ...(nth > 1 ? [`Reminder ${nth} of ${MAX_REMINDERS}.`] : []),
    ].join('\n'),
    buttons: [
      { text: `Open ${bill.name}`, url: bill.url },
      ...folderButton(folderUrl),
      { text: '✓ Downloaded', command: 'invoices', args: `done ${bill.id} ${s.month}`, replace: true },
      { text: 'Remind me tomorrow', command: 'invoices', args: `later ${bill.id} ${s.month}`, replace: true },
    ],
  };
}

function doneReply(bill, month, done, { already }) {
  return {
    title: `✅ ${bill.name}: ${monthName(month)} done`,
    text: already
      ? `${who(done.by)} already marked it downloaded on ${short(done.at.slice(0, 10))}. Nothing else to do.`
      : 'Marked as downloaded. Nobody will be reminded about it again this month.',
    buttons: [{ text: 'All invoices', command: 'invoices' }],
  };
}

const laterReply = (bill, nextOn) => ({
  title: `⏰ ${bill.name}: I'll remind you ${short(nextOn)}`,
  text: 'Same time, next working day. Press **Downloaded** on that one when you have it.',
  buttons: [{ text: 'All invoices', command: 'invoices' }],
});

const savedReply = (bill, { replaced }) => ({
  title: `${replaced ? 'Updated' : 'Added'}: ${bill.name}`,
  text: [
    `Ready on the ${describeReady(bill.ready)}. I'll remind ${bill.remind.join(', ')} that morning, and again every couple of working days until someone presses **Downloaded** (${MAX_REMINDERS} times at most).`,
    'Only people who can use Invoices get the reminders.',
  ].join('\n'),
  buttons: [{ text: `Open ${bill.name}`, url: bill.url }, { text: 'All invoices', command: 'invoices' }],
});

module.exports = { listReply, reminder, doneReply, laterReply, savedReply, statusLine, monthName, short, DEFAULT_TZ };
