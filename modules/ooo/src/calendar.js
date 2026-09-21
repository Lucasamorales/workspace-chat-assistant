/**
 * Read-only view of the OOO calendar (`accounts@`), where the company's leave lives.
 *
 * Buddy reads it as the buddy-bot service account, through a share or group membership.
 * It never writes: booking leave is the `leave` module's job, and only that module holds
 * the delegation needed for it. (`wholeteam@` is the address `leave` invites, not this one.)
 */

const OOO_TAG = /\(OOO\)/i;
const SA_EMAIL = 'buddy-bot@your-gcp-project.iam.gserviceaccount.com';

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

function createOooCalendar({ calendarApi, calendarId }) {
  const guarded = fn => fn().catch(error => { throw explain(error, calendarId); });

  return {
    calendarId,

    /** Every `(OOO)` event overlapping the window, recurrences already expanded. */
    list: ({ timeMin, timeMax }) => guarded(async () => {
      const res = await calendarApi.events.list({
        calendarId,
        timeMin,
        timeMax,
        singleEvents: true,     // expand recurring events into real dates
        orderBy: 'startTime',
        maxResults: 250,
        q: 'OOO',               // narrows server-side; the tag check below is what decides
      });
      return (res.data.items || []).filter(ev => OOO_TAG.test(ev.summary || ''));
    }),

    /** For /ooo check: proves Buddy can actually open the calendar. */
    describe: () => guarded(async () => {
      const res = await calendarApi.calendars.get({ calendarId });
      return { title: res.data.summary || calendarId, timeZone: res.data.timeZone };
    }),
  };
}

module.exports = { createOooCalendar, explain, OOO_TAG, SA_EMAIL };
