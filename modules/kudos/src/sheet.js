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

function createKudosSheet({ sheetsApi, spreadsheetId, tab = 'Raw Data' }) {
  const range = cols => `'${tab.replace(/'/g, "''")}'!${cols}`;

  return {
    async readVotes() {
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
    },

    /** Appends whole rows at the bottom; never edits existing rows or headers. */
    async appendVotes(rows) {
      if (!rows.length) return;
      await sheetsApi.spreadsheets.values.append({
        spreadsheetId,
        range: range('A:H'),
        // USER_ENTERED so "2026-09-17 14:32:05" is stored as a real date, like Apps Script's appendRow.
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: rows },
      });
    },

    /** For /kudos check: can Buddy reach the Sheet and the tab, and what do the headers say? */
    async describe() {
      const meta = await sheetsApi.spreadsheets.get({ spreadsheetId, fields: 'properties(title,timeZone),sheets(properties(title))' });
      const tabs = (meta.data.sheets || []).map(s => s.properties.title);
      let headers = [];
      if (tabs.includes(tab)) {
        const res = await sheetsApi.spreadsheets.values.get({ spreadsheetId, range: range('A1:H1') });
        headers = (res.data.values && res.data.values[0]) || [];
      }
      return { title: meta.data.properties.title, timeZone: meta.data.properties.timeZone, tabs, hasTab: tabs.includes(tab), headers };
    },
  };
}

module.exports = { createKudosSheet, monthOfCell, zonedParts };
