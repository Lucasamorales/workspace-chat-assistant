/**
 * Working hours, and the event shapes built from them.
 *
 * Kept identical to the Apps Script this replaces: a half-day is the shift's own morning or
 * afternoon, in the shift's own time zone, so AM leave for a UK person is 09:00–13:00 London
 * whoever asks and wherever Buddy happens to be running.
 */

const SHIFTS = {
  UK_9_5: { label: 'UK 9:00–17:00', tz: 'Europe/London', start: '09:00:00', mid: '13:00:00', end: '17:00:00' },
  ARG_6_3: { label: 'ARG 6:00–15:00', tz: 'America/Argentina/Buenos_Aires', start: '06:00:00', mid: '10:30:00', end: '15:00:00' },
  ARG_7_4: { label: 'ARG 7:00–16:00', tz: 'America/Argentina/Buenos_Aires', start: '07:00:00', mid: '11:30:00', end: '16:00:00' },
  ARG_8_5: { label: 'ARG 8:00–17:00', tz: 'America/Argentina/Buenos_Aires', start: '08:00:00', mid: '12:30:00', end: '17:00:00' },
};

const TYPES = { full: 'Full day', am: 'Half day (morning)', pm: 'Half day (afternoon)' };

const DECLINE_MESSAGE = 'I am currently out of the office and will respond upon my return.';

/** "GMT-03:00" → "-03:00" at that moment, so summer time is handled. */
function offsetAt(dateIso, timeZone) {
  const at = new Date(`${dateIso}T12:00:00Z`);
  const name = new Intl.DateTimeFormat('en-GB', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(at).find(p => p.type === 'timeZoneName').value;
  const match = /GMT([+-]\d{2}:\d{2})/.exec(name);
  return match ? match[1] : '+00:00';
}

const at = (dateIso, time, timeZone) => `${dateIso}T${time}${offsetAt(dateIso, timeZone)}`;

function addDays(dateIso, days) {
  const [y, m, d] = dateIso.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
}

/** When a leave block starts and ends, as Google wants it. */
function timesFor(leave, shift) {
  const { tz } = shift;
  if (leave.type === 'am') return { start: at(leave.from, shift.start, tz), end: at(leave.from, shift.mid, tz) };
  if (leave.type === 'pm') return { start: at(leave.from, shift.mid, tz), end: at(leave.from, shift.end, tz) };
  return { start: at(leave.from, '00:00:00', tz), end: at(leave.to, '23:59:59', tz) };
}

/**
 * The person's own out-of-office block: opaque, so it shows as busy, and auto-declining new
 * conflicting invitations. This is the part that only works on their own calendar.
 */
function personalEvent(leave, shift, nickname) {
  const { start, end } = timesFor(leave, shift);
  return {
    summary: `${nickname} (OOO)`,
    eventType: 'outOfOffice',
    transparency: 'opaque',
    outOfOfficeProperties: { autoDeclineMode: 'declineOnlyNewConflictingInvitations', declineMessage: DECLINE_MESSAGE },
    start: { dateTime: start },
    end: { dateTime: end },
  };
}

/**
 * The copy the team sees: transparent, so it never blocks anyone's availability. Full days go
 * as all-day events, whose end date Google treats as exclusive — hence the +1.
 */
function teamEvent(leave, shift, nickname, teamEmail) {
  const base = { summary: `${nickname} (OOO)`, transparency: 'transparent', attendees: [{ email: teamEmail }] };
  if (leave.type === 'full') {
    return { ...base, start: { date: leave.from }, end: { date: addDays(leave.to, 1) } };
  }
  const { start, end } = timesFor(leave, shift);
  return { ...base, start: { dateTime: start }, end: { dateTime: end } };
}

module.exports = { SHIFTS, TYPES, timesFor, personalEvent, teamEvent, addDays, offsetAt, at, DECLINE_MESSAGE };
