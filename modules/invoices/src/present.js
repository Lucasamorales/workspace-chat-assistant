/** Everything the invoices module says, as plain functions over plain data. */

const DEFAULT_TZ = 'America/Argentina/Buenos_Aires';

/** "29 Sep 2026", in the reporting time zone rather than the server's. */
const day = (iso, timeZone = DEFAULT_TZ) => new Intl.DateTimeFormat('en-GB', {
  timeZone, day: 'numeric', month: 'short', year: 'numeric',
}).format(new Date(iso));

const sizeOf = bytes => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

const line = (f, timeZone) => `• [${f.name.replace(/[[\]]/g, '')}](${f.link}) — added ${day(f.createdTime, timeZone)} · ${sizeOf(f.size)}`;

function listReply(files, { timeZone, shown = 10 } = {}) {
  if (!files.length) {
    return {
      title: 'Google Cloud invoices',
      text: 'No invoices in the folder yet. The fetcher on the PC saves them there every Monday.',
    };
  }
  const latest = files.slice(0, shown);
  return {
    title: 'Google Cloud invoices',
    text: [
      ...latest.map(f => line(f, timeZone)),
      ...(files.length > shown ? ['', `…and ${files.length - shown} older ones in the folder.`] : []),
    ].join('\n'),
  };
}

function announcement(files, { timeZone } = {}) {
  return {
    title: files.length === 1 ? 'A new Google Cloud invoice' : `${files.length} new Google Cloud invoices`,
    text: files.map(f => line(f, timeZone)).join('\n'),
    buttons: [{ text: 'All invoices', command: 'invoices' }],
  };
}

function checkReply({ folder, files, notify, error }) {
  const lines = [];
  if (error) {
    lines.push(`❌ ${error.message}`);
    if (error.detail) lines.push(`Google said: ${error.detail}`);
  } else {
    lines.push(`✅ I can read the folder **${folder.name}**: ${files.length} invoice${files.length === 1 ? '' : 's'}.`);
    if (files[0]) lines.push(`Newest: ${files[0].name}`);
  }
  lines.push(notify.length
    ? `New invoices are announced to: ${notify.join(', ')} (only those who can use this module).`
    : '⚠️ Nobody is set to be told about new invoices (INVOICES_NOTIFY).');
  return { title: 'Invoices setup check', text: lines.join('\n') };
}

module.exports = { listReply, announcement, checkReply, day, sizeOf, DEFAULT_TZ };
