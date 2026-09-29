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

const addButton = isAdmin => (isAdmin ? [{ text: '+ Add a bill', command: 'invoices', args: 'new' }] : []);
// Each bill brings up to two buttons; past this many the card becomes a wall of them.
const BUTTON_BILLS = 8;

function listReply(rows, { month, folderUrl, isAdmin }) {
  const title = `🧾 Invoices — ${monthName(month)}`;
  if (!rows.length) {
    return {
      title,
      text: isAdmin ? 'No bills yet. Press **+ Add a bill**, or just tell me about one.' : 'No bills have been set up yet.',
      buttons: addButton(isAdmin),
    };
  }
  const blocks = rows.map(({ bill, standing }) => [
    `**${bill.name}** · ready on the ${describeReady(bill.ready)}`,
    statusLine(standing),
    ...(isAdmin ? [`Reminds: ${bill.remind.join(', ')}`] : []),
  ].join('\n'));
  // The buttons follow the card's order, one bill at a time: its page, then Downloaded if due.
  const perBill = rows.slice(0, BUTTON_BILLS).flatMap(({ bill, standing }) => [
    { text: `Open ${bill.name}`, url: bill.url },
    ...(standing.state === 'pending' ? [{ text: `✓ ${bill.name} downloaded`, command: 'invoices', args: `done ${bill.id} ${standing.month}`, replace: true }] : []),
  ]);
  return {
    title,
    text: [
      blocks.join('\n\n'),
      ...(isAdmin ? ['', 'To add, change or stop a bill, press **+ Add a bill** or just tell me, e.g. "Figma is ready on the 3rd working day now".'] : []),
    ].join('\n'),
    buttons: [...perBill, ...addButton(isAdmin), ...folderButton(folderUrl)],
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
