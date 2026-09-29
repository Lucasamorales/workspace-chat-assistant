/** Everything the receipts module says, as plain functions over plain data. */

const { describeReady, MAX_REMINDERS } = require('./schedule');

const DEFAULT_TZ = 'America/Argentina/Buenos_Aires';

/** "7 Oct" from "2026-10-07"; the date is already local, so it is read as UTC to stay put. */
const short = date => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(new Date(`${date}T12:00:00Z`));
const monthName = month => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'long' }).format(new Date(`${month}-15T12:00:00Z`));
const who = email => String(email).split('@')[0];
const folderButton = folderUrl => (folderUrl ? [{ text: 'Receipts folder', url: folderUrl }] : []);

function statusLine(s) {
  if (s.state === 'done') return `✅ ${monthName(s.month)}: downloaded by ${who(s.done.by)} on ${short(s.done.at.slice(0, 10))}`;
  if (s.state === 'upcoming') return `🗓️ ${monthName(s.month)}: due ${short(s.due)}`;
  const times = s.reminded.length;
  return `⏳ ${monthName(s.month)}: due since ${short(s.due)}, not downloaded yet${times ? ` (reminded ${times}×${s.gaveUp ? ', no more reminders this month' : ''})` : ''}`;
}

const addButton = isAdmin => (isAdmin ? [{ text: '+ Add a receipt', command: 'receipts', args: 'new' }] : []);
// Each receipt brings up to two buttons; past this many the card becomes a wall of them.
const BUTTON_RECEIPTS = 8;

function listReply(rows, { month, folderUrl, isAdmin }) {
  const title = `🧾 Receipts — ${monthName(month)}`;
  if (!rows.length) {
    return {
      title,
      text: isAdmin ? 'No receipts yet. Press **+ Add a receipt**, or just tell me about one.' : 'No receipts have been set up yet.',
      buttons: addButton(isAdmin),
    };
  }
  const blocks = rows.map(({ receipt, standing }) => [
    `**${receipt.name}** · ready on the ${describeReady(receipt.ready)}`,
    statusLine(standing),
    ...(isAdmin ? [`Reminds: ${receipt.remind.join(', ')}`] : []),
  ].join('\n'));
  // The buttons follow the card's order, one receipt at a time: its page, then Downloaded if due.
  const perReceipt = rows.slice(0, BUTTON_RECEIPTS).flatMap(({ receipt, standing }) => [
    { text: `Open ${receipt.name}`, url: receipt.url },
    ...(standing.state === 'pending' ? [{ text: `✓ ${receipt.name} downloaded`, command: 'receipts', args: `done ${receipt.id} ${standing.month}`, replace: true }] : []),
  ]);
  return {
    title,
    text: [
      blocks.join('\n\n'),
      ...(isAdmin ? ['', 'To add, change or stop a receipt, press **+ Add a receipt** or just tell me, e.g. "Figma is ready on the 3rd working day now".'] : []),
    ].join('\n'),
    buttons: [...perReceipt, ...addButton(isAdmin), ...folderButton(folderUrl)],
  };
}

function reminder(receipt, s, { folderUrl }) {
  const nth = s.reminded.length + 1;
  return {
    title: `🧾 ${receipt.name}: this month's receipt should be ready`,
    text: [
      `It's usually out by the ${describeReady(receipt.ready)} (${short(s.due)}). Download it from the billing page${folderUrl ? ' and save it in the receipts folder' : ''}.`,
      'Press **Downloaded** when you have it and I\'ll stop reminding everyone.',
      ...(nth > 1 ? [`Reminder ${nth} of ${MAX_REMINDERS}.`] : []),
    ].join('\n'),
    buttons: [
      { text: `Open ${receipt.name}`, url: receipt.url },
      ...folderButton(folderUrl),
      { text: '✓ Downloaded', command: 'receipts', args: `done ${receipt.id} ${s.month}`, replace: true },
      { text: 'Remind me tomorrow', command: 'receipts', args: `later ${receipt.id} ${s.month}`, replace: true },
    ],
  };
}

function doneReply(receipt, month, done, { already }) {
  return {
    title: `✅ ${receipt.name}: ${monthName(month)} done`,
    text: already
      ? `${who(done.by)} already marked it downloaded on ${short(done.at.slice(0, 10))}. Nothing else to do.`
      : 'Marked as downloaded. Nobody will be reminded about it again this month.',
    buttons: [{ text: 'All receipts', command: 'receipts' }],
  };
}

const laterReply = (receipt, nextOn) => ({
  title: `⏰ ${receipt.name}: I'll remind you ${short(nextOn)}`,
  text: 'Same time, next working day. Press **Downloaded** on that one when you have it.',
  buttons: [{ text: 'All receipts', command: 'receipts' }],
});

const savedReply = (receipt, { replaced }) => ({
  title: `${replaced ? 'Updated' : 'Added'}: ${receipt.name}`,
  text: [
    `Ready on the ${describeReady(receipt.ready)}. I'll remind ${receipt.remind.join(', ')} that morning, and again every couple of working days until someone presses **Downloaded** (${MAX_REMINDERS} times at most).`,
    'Only people who can use Receipts get the reminders.',
  ].join('\n'),
  buttons: [{ text: `Open ${receipt.name}`, url: receipt.url }, { text: 'All receipts', command: 'receipts' }],
});

module.exports = { listReply, reminder, doneReply, laterReply, savedReply, statusLine, monthName, short, DEFAULT_TZ };
