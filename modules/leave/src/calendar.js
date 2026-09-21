/**
 * Google Calendar, as one particular person.
 *
 * Every call takes the subject it acts for. There is no "current user" hidden in here: the
 * caller has to say whose calendar it means, every time, so an omission cannot silently
 * fall back to someone else's.
 */

const API = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const OOO_TAG = /\(OOO\)/i;

function fail(message, cause) {
  return Object.assign(new Error(message), { expose: true, cause });
}

async function problem(res, subject) {
  const body = await res.text().catch(() => '');
  if (res.status === 401 || res.status === 403) {
    return fail(`Buddy isn't allowed to touch ${subject}'s calendar. Check the domain-wide delegation `
      + 'entry (buddy-bot\'s client id, scope calendar.events).', body);
  }
  if (res.status === 404) return fail('That out-of-office event has already gone.', body);
  if (res.status === 429 || res.status >= 500) return fail('Google Calendar is busy right now. Give it a minute and try again?', body);
  return fail('Google Calendar refused that change.', body);
}

function createLeaveCalendar({ tokenFor, fetch: doFetch = fetch }) {
  const call = async (subject, path, options = {}) => {
    const token = await tokenFor(subject);
    const res = await doFetch(`${API}${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    if (!res.ok) throw await problem(res, subject);
    return res.status === 204 ? null : res.json();
  };

  return {
    /** `(OOO)` events on that person's own calendar between two instants. */
    async listOoo(subject, { timeMin, timeMax }) {
      const query = new URLSearchParams({ timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: '250', q: 'OOO' });
      const data = await call(subject, `?${query}`);
      return (data.items || []).filter(ev => OOO_TAG.test(ev.summary || ''));
    },

    /** `sendUpdates=none`: booking leave should not email the whole company. */
    create(subject, event) {
      return call(subject, '?sendUpdates=none', { method: 'POST', body: JSON.stringify(event) });
    },

    remove(subject, eventId) {
      return call(subject, `/${encodeURIComponent(eventId)}?sendUpdates=none`, { method: 'DELETE' });
    },
  };
}

module.exports = { createLeaveCalendar, OOO_TAG };
