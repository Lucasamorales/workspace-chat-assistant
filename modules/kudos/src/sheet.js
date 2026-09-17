/**
 * The Kudos Google Sheet, "Raw Data" tab:
 *   A Date · B Voter · C Value · D Nominee · E Space · F Raw text   (unchanged from Apps Script)
 *   G Voter Chat id · H Nominee Chat id                            (added by Buddy; empty on older rows)
 *
 * Buddy's service account only has access to this one Sheet, shared with it as Editor.
 */

const SHEETS_EPOCH_MS = Date.UTC(1899, 11, 30);
const DAY_MS = 24 * 60 * 60 * 1000;

/** Year/month as written in the cell (wall clock), whatever time zone the Sheet uses. */
function monthOfCell(value) {
  if (typeof value === 'number') {
    const d = new Date(SHEETS_EPOCH_MS + value * DAY_MS);
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
  }
  const match = /^(\d{4})-(\d{2})/.exec(String(value || ''));
  if (match) return { year: Number(match[1]), month: Number(match[2]) };
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : { year: d.getFullYear(), month: d.getMonth() + 1 };
}

/** Wall-clock parts of `date` in `timeZone`, built by hand so output never depends on ICU version. */
function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = type => parts.find(p => p.type === type).value;
  return { year: Number(get('year')), month: Number(get('month')), stamp: `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}` };
}

const SA_EMAIL = 'the buddy-bot service account';

/**
 * Turns Google API failures into messages people can act on. The original error is still
 * logged by the registry; users only see the explanation.
 */
function explain(error, action, tab) {
  const status = Number(error.status || error.code || (error.response && error.response.status));
  const wrap = message => Object.assign(new Error(message), { expose: true, cause: error });
  if (status === 403) {
    return wrap(action === 'write'
      ? `⚠️ Your vote wasn't logged: Buddy can read the Kudos Sheet but isn't allowed to add rows. Share the Sheet as Editor with ${SA_EMAIL}.`
      : `⚠️ Your vote wasn't logged: Buddy isn't allowed to open the Kudos Sheet. Share it as Editor with ${SA_EMAIL}.`);
  }
  if (status === 404) return wrap('⚠️ Your vote wasn\'t logged: the Kudos Sheet wasn\'t found. Check KUDOS_SHEET_ID.');
  if (status === 400) return wrap(`⚠️ Your vote wasn't logged: the Kudos Sheet has no "${tab}" tab.`);
  if (status === 429 || status >= 500) return wrap('⚠️ Your vote wasn\'t logged: Google Sheets is busy right now. Please try again in a minute.');
  return error;
}

function createKudosSheet({ sheetsApi, spreadsheetId, tab = 'Raw Data' }) {
  const range = cols => `'${tab.replace(/'/g, "''")}'!${cols}`;
  const guarded = (action, fn) => fn().catch(error => { throw explain(error, action, tab); });

  return {
    readVotes: () => guarded('read', async () => {
      const res = await sheetsApi.spreadsheets.values.get({
        spreadsheetId,
        range: range('A2:H'),
        valueRenderOption: 'UNFORMATTED_VALUE',
        dateTimeRenderOption: 'SERIAL_NUMBER',
      });
      return (res.data.values || [])
        .filter(r => r[0] !== undefined && r[0] !== '' && r[1] && r[3])
        .map(r => ({
          when: monthOfCell(r[0]),
          voter: String(r[1]),
          value: String(r[2] || ''),
          nominee: String(r[3]),
          space: String(r[4] || ''),
          voterId: r[6] ? String(r[6]) : '',
          nomineeId: r[7] ? String(r[7]) : '',
        }));
    }),

    /** Appends whole rows at the bottom; never edits existing rows or headers. */
    appendVotes: rows => guarded('write', async () => {
      if (!rows.length) return;
      await sheetsApi.spreadsheets.values.append({
        spreadsheetId,
        range: range('A:H'),
        // USER_ENTERED so "2026-09-17 14:32:05" is stored as a real date, like Apps Script's appendRow.
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: rows },
      });
    }),

    /** For /kudos check: can Buddy reach the Sheet and the tab, and what do the headers say? */
    async describe() {
      const meta = await sheetsApi.spreadsheets.get({ spreadsheetId, fields: 'properties(title,timeZone),sheets(properties(title))' });
      const tabs = (meta.data.sheets || []).map(s => s.properties.title);
      let headers = [];
      let canWrite = null;
      if (tabs.includes(tab)) {
        const res = await sheetsApi.spreadsheets.values.get({ spreadsheetId, range: range('A1:H1') });
        headers = (res.data.values && res.data.values[0]) || [];
        // Reading works for Viewers too, so prove edit access by writing A1's own content back
        // unchanged (as a formula if it is one). Only a 403 means "not allowed".
        try {
          const a1 = await sheetsApi.spreadsheets.values.get({ spreadsheetId, range: range('A1'), valueRenderOption: 'FORMULA' });
          const current = (a1.data.values && a1.data.values[0] && a1.data.values[0][0]) ?? '';
          await sheetsApi.spreadsheets.values.update({
            spreadsheetId, range: range('A1'), valueInputOption: 'USER_ENTERED', requestBody: { values: [[current]] },
          });
          canWrite = true;
        } catch (error) {
          if (Number(error.status || error.code || (error.response && error.response.status)) !== 403) throw error;
          canWrite = false;
        }
      }
      return { title: meta.data.properties.title, timeZone: meta.data.properties.timeZone, tabs, hasTab: tabs.includes(tab), headers, canWrite };
    },
  };
}

module.exports = { createKudosSheet, monthOfCell, zonedParts, explain };
