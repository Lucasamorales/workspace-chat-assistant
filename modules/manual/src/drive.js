/**
 * Reading the manual's Drive folder.
 *
 * Read-only by construction: this file knows how to list a folder and export a file to text,
 * and nothing else. `buddy-bot` sees the folder because it is shared with it as Viewer, so
 * Buddy can only ever read what a human deliberately put in that one folder.
 */

const FILES = 'https://www.googleapis.com/drive/v3/files';
const FOLDER = 'application/vnd.google-apps.folder';

/** What we can turn into text, and what Google exports it as. */
const EXPORTS = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.presentation': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
};
const PLAIN = /^text\/(plain|csv|markdown)$/;

const fail = (message, cause) => Object.assign(new Error(message), { expose: true, cause });

function explain(status, folderId, body) {
  if (status === 401 || status === 403) {
    return fail('I can\'t read the manual folder. Share it as Viewer with '
      + 'buddy-bot@your-gcp-project.iam.gserviceaccount.com and I\'ll be able to look things up.', body);
  }
  if (status === 404) return fail(`I couldn't find the manual folder (${folderId}). Check MANUAL_FOLDER_ID.`, body);
  if (status === 429 || status >= 500) return fail('Google Drive is busy right now. Give it a minute?', body);
  return fail('Google Drive refused that request.', body);
}

function createDrive({ tokenFor, folderId, fetch: doFetch = fetch }) {
  const get = async (url, kind = 'json') => {
    const token = await tokenFor();
    const res = await doFetch(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw explain(res.status, folderId, await res.text().catch(() => ''));
    return kind === 'text' ? res.text() : res.json();
  };

  /** Everything in the folder and its subfolders, with the path people would recognise. */
  async function walk(id = folderId, trail = []) {
    const found = [];
    let pageToken = null;
    do {
      const query = new URLSearchParams({
        q: `'${id}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, webViewLink, size)',
        pageSize: '200',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
        ...(pageToken ? { pageToken } : {}),
      });
      const page = await get(`${FILES}?${query}`);
      for (const file of page.files || []) {
        if (file.mimeType === FOLDER) {
          found.push(...await walk(file.id, [...trail, file.name]));
        } else {
          found.push({ ...file, section: trail.join(' / ') });
        }
      }
      pageToken = page.nextPageToken || null;
    } while (pageToken);
    return found;
  }

  return {
    folderId,
    list: () => walk(),

    /** @returns {Promise<string|null>} null for anything we cannot turn into text (e.g. a PDF) */
    async textOf(file) {
      const exportAs = EXPORTS[file.mimeType];
      if (exportAs) {
        return get(`${FILES}/${file.id}/export?mimeType=${encodeURIComponent(exportAs)}`, 'text');
      }
      if (PLAIN.test(file.mimeType || '')) return get(`${FILES}/${file.id}?alt=media`, 'text');
      return null;
    },

    supported: file => Boolean(EXPORTS[file.mimeType] || PLAIN.test(file.mimeType || '')),
  };
}

module.exports = { createDrive, EXPORTS, FOLDER };
