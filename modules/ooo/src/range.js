/**
 * Date ranges in the team's own time zone.
 *
 * Everything is built from wall-clock parts rather than from Date arithmetic: "this week"
 * has to mean the week people are living in, not the week UTC happens to be in. Month names
 * and offsets are assembled by hand so output never shifts with the ICU version.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "GMT-03:00" → "-03:00", for the given instant (so DST is handled). */
function offsetAt(date, timeZone) {
  const name = new Intl.DateTimeFormat('en-GB', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(date).find(p => p.type === 'timeZoneName').value;
  const match = /GMT([+-]\d{2}:\d{2})/.exec(name);
  return match ? match[1] : '+00:00';
}

/** Wall-clock parts of an instant in `timeZone`. */
function partsAt(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = type => parts.find(p => p.type === type).value;
  return {
    year: Number(get('year')), month: Number(get('month')), day: Number(get('day')),
    hour: get('hour'), minute: get('minute'),
  };
}

const iso = ({ year, month, day }) => `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
const fromIso = s => { const [y, m, d] = s.split('-').map(Number); return { year: y, month: m, day: d }; };

function addDays(dateIso, days) {
  const { year, month, day } = fromIso(dateIso);
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return iso({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
}

/** Monday = 1 … Sunday = 7, like the Apps Script it replaces. */
function weekday(dateIso) {
  const { year, month, day } = fromIso(dateIso);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay() || 7;
}

const WHEN = ['today', 'tomorrow', 'week', 'next week', 'month', 'next month'];

/** @returns {{from: string, to: string, label: string}} inclusive local dates */
function rangeFor(when, now, timeZone) {
  const today = iso(partsAt(now, timeZone));
  switch (when) {
    case 'today': return { from: today, to: today, label: 'today' };
    case 'tomorrow': return { from: addDays(today, 1), to: addDays(today, 1), label: 'tomorrow' };
    case 'week': {
      const monday = addDays(today, 1 - weekday(today));
      return { from: monday, to: addDays(monday, 6), label: 'this week' };
    }
    case 'next week': {
      const monday = addDays(today, 8 - weekday(today));
      return { from: monday, to: addDays(monday, 6), label: 'next week' };
    }
    case 'month': {
      const { year, month } = fromIso(today);
      return { from: iso({ year, month, day: 1 }), to: lastDayOf(year, month), label: 'this month' };
    }
    case 'next month': {
      const { year, month } = fromIso(today);
      const y = month === 12 ? year + 1 : year;
      const m = month === 12 ? 1 : month + 1;
      return { from: iso({ year: y, month: m, day: 1 }), to: lastDayOf(y, m), label: 'next month' };
    }
    default: return rangeFor('today', now, timeZone);
  }
}

function lastDayOf(year, month) {
  const d = new Date(Date.UTC(year, month, 0)); // day 0 of the next month
  return iso({ year, month, day: d.getUTCDate() });
}

/** The instants to ask Google for: the whole of `from`..`to` as lived in `timeZone`. */
function instantsFor(range, timeZone) {
  const noon = dateIso => new Date(`${dateIso}T12:00:00Z`);
  return {
    timeMin: `${range.from}T00:00:00${offsetAt(noon(range.from), timeZone)}`,
    timeMax: `${range.to}T23:59:59${offsetAt(noon(range.to), timeZone)}`,
  };
}

/** "Sep 22" */
const dayLabel = dateIso => { const { month, day } = fromIso(dateIso); return `${MONTHS[month - 1]} ${day}`; };

module.exports = { WHEN, rangeFor, instantsFor, partsAt, addDays, dayLabel, iso, MONTHS };
