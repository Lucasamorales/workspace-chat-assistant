/**
 * When a bill is due, and whether to remind someone about it today. Plain functions over
 * YYYY-MM-DD strings: no clock, no storage, no Chat, so every rule is tested on its own.
 *
 * Working days are Monday to Friday. Public holidays aren't known, so a holiday can make a
 * reminder a day early: harmless for a reminder, and better than a holiday list to maintain.
 */

// A bill that nobody marks as downloaded is reminded about this many times in a month, then left
// alone (it still shows as pending in /invoices). Nagging forever teaches people to ignore Buddy.
const MAX_REMINDERS = 3;
// Working days between reminders when nobody has pressed anything.
const GAP_WORKDAYS = 2;

const pad = n => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const parts = date => date.split('-').map(Number);
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const weekday = date => { const [y, m, d] = parts(date); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
const isWorkday = date => { const w = weekday(date); return w >= 1 && w <= 5; };

function addDays(date, n) {
  const [y, m, d] = parts(date);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

function addWorkdays(date, n) {
  let out = date;
  for (let left = n; left > 0;) { out = addDays(out, 1); if (isWorkday(out)) left -= 1; }
  return out;
}

/** Today as YYYY-MM-DD where the people are, not where the server is. */
function today(now, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
}

/**
 * The day a bill is due in a month ("2026-10").
 *   { kind: 'workday', n: 5 }  the 5th working day (the last one, if the month has fewer)
 *   { kind: 'day', n: 31 }     that day of the month (the last day, in a shorter month)
 */
function dueDate(ready, month) {
  const [y, m] = parts(month);
  const last = daysIn(y, m);
  if (ready.kind === 'day') return ymd(y, m, Math.min(ready.n, last));
  let count = 0;
  let lastWorkday = null;
  for (let d = 1; d <= last; d++) {
    if (!isWorkday(ymd(y, m, d))) continue;
    lastWorkday = ymd(y, m, d);
    if (++count === ready.n) return lastWorkday;
  }
  return lastWorkday;
}

/** "5th working day", "day 1", "the 5th working day" → a ready rule, or null. */
function parseReady(text) {
  const s = String(text || '').trim().toLowerCase().replace(/^the\s+/, '').replace(/\s+/g, ' ');
  let m = s.match(/^(\d{1,2})(?:st|nd|rd|th)? (?:working|business|work) day(?: of the month)?$/) || s.match(/^(?:working|business|work) ?day (\d{1,2})$/);
  if (m && +m[1] >= 1 && +m[1] <= 23) return { kind: 'workday', n: +m[1] };
  m = s.match(/^day (\d{1,2})(?: of the month)?$/) || s.match(/^(\d{1,2})(?:st|nd|rd|th)?(?: of (?:the|each|every) month)?$/);
  if (m && +m[1] >= 1 && +m[1] <= 31) return { kind: 'day', n: +m[1] };
  return null;
}

function ordinal(n) {
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
  return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'}`;
}
const describeReady = ready => (ready.kind === 'workday' ? `${ordinal(ready.n)} working day` : `${ordinal(ready.n)} of the month`);

/**
 * Where a bill stands today, and whether to remind now. `period` is this month's record:
 * { done: {by, at} | null, reminded: [dates], nextOn: date | null }.
 */
function standing(bill, period, date) {
  const month = date.slice(0, 7);
  const due = dueDate(bill.ready, month);
  const p = period || {};
  if (p.done) return { state: 'done', due, month, done: p.done };
  if (date < due) return { state: 'upcoming', due, month };
  const reminded = p.reminded || [];
  if (reminded.length >= MAX_REMINDERS) return { state: 'pending', due, month, reminded, gaveUp: true };
  // Only on working days: a Saturday reminder would arrive with nobody to act on it.
  const remindNow = isWorkday(date) && date >= (p.nextOn || due) && !reminded.includes(date);
  return { state: 'pending', due, month, reminded, remindNow };
}

/** The next due date from today: this month's if it hasn't passed, otherwise next month's. */
function nextDue(ready, date) {
  const due = dueDate(ready, date.slice(0, 7));
  if (due >= date) return due;
  const [y, m] = parts(date);
  return dueDate(ready, m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`);
}

/** What this month's record becomes once a reminder is handed over. */
const afterReminder = (period, date) => ({
  ...(period || {}),
  done: null,
  reminded: [...((period && period.reminded) || []), date],
  nextOn: addWorkdays(date, GAP_WORKDAYS),
});

/** "Remind me later": the next working day, and it doesn't use up a reminder. */
const afterLater = (period, date) => ({ ...(period || {}), nextOn: addWorkdays(date, 1) });

module.exports = {
  MAX_REMINDERS, GAP_WORKDAYS,
  today, dueDate, nextDue, parseReady, describeReady, isWorkday, addWorkdays, standing, afterReminder, afterLater,
};
