/**
 * Calendar events → the "who's out" list, in Buddy's voice.
 *
 * All-day events from Google end on an *exclusive* date, so a one-day leave comes back as
 * 22nd → 23rd. Half-days arrive as timed events and keep their hours, as the team reads
 * them in the office time zone.
 */

const { partsAt, dayLabel, addDays } = require('./range');

/** "Ian OOO" / "Ella (OOO)" / "OOO - Lenny" → the person. Separators around it go too. */
const nameOf = event => String(event.summary || '')
  .replace(/\(\s*OOO\s*\)/ig, ' ')
  .replace(/\bOOO\b/ig, ' ')
  .replace(/\s*[-–—:|]\s*/g, ' ')
  .replace(/\s+/g, ' ')
  .trim() || 'Someone';

/** One person's absence, as dates and a readable label. */
function entryOf(event, timeZone, tzLabel) {
  const name = nameOf(event);

  if (event.start && event.start.date) {
    const from = event.start.date;
    const to = addDays(event.end && event.end.date ? event.end.date : addDays(from, 1), -1);
    return {
      name,
      sortKey: `${from}T00:00`,
      when: from === to ? dayLabel(from) : `${dayLabel(from)} to ${dayLabel(to)}`,
    };
  }

  const start = new Date(event.start.dateTime);
  const end = new Date(event.end.dateTime);
  const s = partsAt(start, timeZone);
  const e = partsAt(end, timeZone);
  const day = `${s.year}-${String(s.month).padStart(2, '0')}-${String(s.day).padStart(2, '0')}`;
  return {
    name,
    sortKey: `${day}T${s.hour}:${s.minute}`,
    when: `${dayLabel(day)} (${s.hour}:${s.minute} - ${e.hour}:${e.minute} ${tzLabel})`,
  };
}

/**
 * The same leave often appears twice: the person's own OOO block and the invite sent to the
 * team address. Identical name + dates means one absence, so it is listed once.
 */
function entriesFrom(events, timeZone, tzLabel) {
  const seen = new Map();
  events.map(ev => entryOf(ev, timeZone, tzLabel)).forEach(entry => {
    const key = `${entry.name.toLowerCase()}|${entry.when}`;
    if (!seen.has(key)) seen.set(key, entry);
  });
  return [...seen.values()].sort((a, b) => (a.sortKey === b.sortKey ? a.name.localeCompare(b.name) : a.sortKey.localeCompare(b.sortKey)));
}

function replyFor(entries, label) {
  if (!entries.length) return { title: `Nobody\'s out ${label}`, text: 'Full house! 🎉' };
  return {
    title: `Who\'s out ${label}`,
    text: entries.map(e => `• **${e.name}**: ${e.when}`).join('\n'),
  };
}

/** The same list as plain text, for Claude. */
const textFor = (entries, label) => (entries.length
  ? `Out of office ${label}:\n${entries.map(e => `- ${e.name}: ${e.when}`).join('\n')}`
  : `Nobody is out of office ${label}.`);

module.exports = { entriesFrom, entryOf, replyFor, textFor, nameOf };
