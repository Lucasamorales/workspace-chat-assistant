/**
 * The only Google calls this module makes: read one Drive folder. Nothing here writes, and there
 * is no code that could — the token is read-only as well.
 *
 * The folder is filled by the invoice fetcher on the PC (tools/invoice-fetcher), through Drive
 * for desktop; this side never touches Google billing or any Google login.
 */

const API = 'https://www.googleapis.com/drive/v3';
// Drive folder ids are letters, digits, '-' and '_'. Checked before it goes into a query string.
const FOLDER_ID = /^[A-Za-z0-9_-]{10,}$/;

const fail = (message, detail) => Object.assign(new Error(message), { expose: true, detail });

function createDrive({ tokenFor, folderId, fetch: doFetch = fetch }) {
  if (!FOLDER_ID.test(String(folderId || ''))) {
    throw fail('INVOICES_FOLDER_ID is missing or doesn\'t look like a Drive folder id.');
  }

  async function get(path, params) {
    const url = `${API}/${path}?${new URLSearchParams({ supportsAllDrives: 'true', ...params })}`;
    const res = await doFetch(url, { headers: { Authorization: `Bearer ${await tokenFor()}` } });
    if (res.ok) return res.json();
    let detail = '';
    try { detail = (await res.json()).error.message; } catch { /* no body worth quoting */ }
    if (res.status === 404) {
      throw fail('Buddy can\'t see the invoices folder. Share it as Viewer with buddy-bot@your-gcp-project.iam.gserviceaccount.com.', detail);
    }
    if (res.status === 403) throw fail('Drive refused Buddy access to the invoices folder.', detail);
    throw fail(`Drive answered ${res.status} when Buddy looked at the invoices folder.`, detail);
  }

  return {
    /** The folder itself — proves it exists and is shared. */
    folder: () => get(`files/${folderId}`, { fields: 'id,name,mimeType' }),

    /** Every PDF in the folder, newest first. */
    async invoices() {
      const data = await get('files', {
        q: `'${folderId}' in parents and trashed = false and mimeType = 'application/pdf'`,
        orderBy: 'createdTime desc',
        pageSize: '200',
        includeItemsFromAllDrives: 'true',
        fields: 'files(id,name,createdTime,size,webViewLink)',
      });
      return (data.files || []).map(f => ({
        id: f.id, name: f.name, createdTime: f.createdTime, size: Number(f.size) || 0, link: f.webViewLink,
      }));
    },
  };
}

module.exports = { createDrive };
