/**
 * The costs Google Sheet: append-only, one row per person per module per week.
 *
 * The column order is the contract agreed when the workbook was handed over — never reorder,
 * only ever add to the right, or old rows stop lining up with new ones.
 */

const TAB = 'Weekly';
const SA_EMAIL = 'buddy-bot@your-gcp-project.iam.gserviceaccount.com';

function explain(error, action, tab = TAB) {
  const status = Number(error.status || error.code || (error.response && error.response.status));
  // Google's own words: "no such tab" and "this file isn't a Google Sheet at all" both arrive
  // as 400, and guessing between them sends people to fix the wrong thing.
  const reason = String((error.response && error.response.data && error.response.data.error
    && error.response.data.error.message) || error.message || '');
  const wrap = message => Object.assign(new Error(message), { expose: true, cause: error, detail: reason });
  const notASheet = 'That file isn\'t a Google Sheet yet — an uploaded .xlsx stays an Excel file in Drive. '
    + 'Open it, choose File → Save as Google Sheets, and use the new file\'s id.';

  if (status === 403) {
    return wrap(`Buddy can't ${action} the costs Sheet. Share it as Editor with ${SA_EMAIL}.`);
  }
  if (status === 404) return wrap('I couldn\'t find the costs Sheet. Check COSTS_SHEET_ID.');
  if (status === 400) return wrap(/parse range|Unable to parse/i.test(reason) ? `The costs Sheet has no "${tab}" tab.` : notASheet);
  if (status === 429 || status >= 500) return wrap('Google Sheets is busy right now. Try again in a minute?');
  return error;
}

function createCostsSheet({ sheetsApi, spreadsheetId, tab = TAB }) {
  const range = cols => `'${tab.replace(/'/g, "''")}'!${cols}`;
  const guarded = (action, fn) => fn().catch(error => { throw explain(error, action, tab); });

  return {
    /** The weeks already written, so a rollup never doubles up a week. */
    weeksWritten: () => guarded('read', async () => {
      const res = await sheetsApi.spreadsheets.values.get({ spreadsheetId, range: range('A2:A') });
      return new Set(((res.data && res.data.values) || []).map(row => String(row[0] || '')).filter(Boolean));
    }),

    append: rows => guarded('write', async () => {
      if (!rows.length) return 0;
      await sheetsApi.spreadsheets.values.append({
        spreadsheetId,
        range: range('A:N'),
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: rows },
      });
      return rows.length;
    }),

    describe: () => guarded('open', async () => {
      const res = await sheetsApi.spreadsheets.get({ spreadsheetId, fields: 'properties.title,sheets.properties.title' });
      const tabs = (res.data.sheets || []).map(s => s.properties.title);
      return { title: res.data.properties.title, tabs, hasTab: tabs.includes(tab) };
    }),
  };
}

module.exports = { createCostsSheet, TAB };
