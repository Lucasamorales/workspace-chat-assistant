/**
 * Read-only view of the OOO calendar (`accounts@`), where the company's leave lives.
 *
 * Deliberately tiny, because it is the only thing in `ooo` that talks to Google. There is no
 * create, no delete, no patch — not "they are never called", they do not exist. Requests are
 * built here, always GET, always events.list or calendars.get on the one configured calendar;
 * nothing a user, a message or Claude says can change the URL, the method or the calendar.
 *
 * (`wholeteam@` is the address the `leave` module invites. This module never writes anywhere.)
 */

const BASE = 'https://www.googleapis.com/calendar/v3/calendars';
const OOO_TAG = /\(OOO\)/i;
const SA_EMAIL = 'buddy-bot@your-gcp-project.iam.gserviceaccount.com';
const MAX_RESULTS = '250';

const fail = (message, cause) => Object.assign(new Error(message), { expose: true, cause });

/** Google API failures become something a person can act on; the raw error is still logged. */
function explain(error, calendarId) {
  const status = Number(error.status || error.code || (error.response && error.response.status));
  const wrap = message => Object.assign(new Error(message), { expose: true, cause: error });
  if (status === 401 || status === 403) {
    return wrap(`Oh no, I can't read the team calendar: ${SA_EMAIL} doesn't have access to ${calendarId}. `
      + 'Add it as a member of the group (or share the calendar with it) and I\'ll be able to see who\'s out.');
  }
  if (status === 404) return wrap(`Oh no, I couldn't find the calendar ${calendarId}. Check OOO_CALENDAR_ID.`);
  if (status === 429 || status >= 500) return wrap('Oh no, Google Calendar is a bit busy right now. Give it a minute and try again?');
  return error;
}

/**
 * @param tokenFor    () => access token; the account acted as is decided in token.js, from settings
 * @param calendarId  the one calendar this module may ever look at
 * @param readAs      the configured mailbox, when reading by acting as it
 */
function createOooCalendar({ tokenFor, calendarId, readAs = null, fetch: doFetch = fetch }) {
  if (!calendarId) throw new Error('ooo: calendarId is required');
  // Acting as the account whose own calendar this is: "primary" is that same calendar, and
  // avoids relying on it also being shared with itself by address.
  const target = readAs && readAs === String(calendarId).toLowerCase() ? 'primary' : calendarId;
  const path = encodeURIComponent(target);

  /** The only way out of this module. GET only, no caller-supplied options. */
  async function get(suffix, params) {
    const token = await tokenFor(readAs);
    const query = params ? `?${new URLSearchParams(params)}` : '';
    const res = await doFetch(`${BASE}/${path}${suffix}${query}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw explain(Object.assign(new Error('calendar request failed'), { status: res.status }), calendarId);
    return res.json();
  }

  return Object.freeze({
    calendarId,
    readAs,

    /** Every `(OOO)` event overlapping the window, recurrences already expanded. */
    async list({ timeMin, timeMax }) {
      if (!timeMin || !timeMax) throw fail('I need a date range to look at.');
      const data = await get('/events', {
        timeMin,
        timeMax,
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: MAX_RESULTS,
        q: 'OOO',
      });
      return (data.items || []).filter(ev => OOO_TAG.test(ev.summary || ''));
    },

    /** For /ooo check: proves Buddy can actually open the calendar. */
    async describe() {
      const data = await get('');
      return { title: data.summary || calendarId, timeZone: data.timeZone };
    },
  });
}

module.exports = { createOooCalendar, explain, OOO_TAG, SA_EMAIL };
