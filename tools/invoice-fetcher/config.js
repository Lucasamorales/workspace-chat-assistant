// Everything this tool needs to know, in one place. No secrets: the Gmail app password lives in
// Windows Credential Manager (set-password.ps1) and the Google session in the Chrome profile.
//
// Anything machine-specific (where Drive for desktop puts the folder, who is emailed) can be
// overridden in config.local.json next to this file, which is not committed.
const fs = require('node:fs');
const path = require('node:path');

const HOME = path.join(process.env.LOCALAPPDATA || path.join(require('node:os').homedir(), '.local'), 'buddy-invoice-fetcher');

const DEFAULTS = {
  billingAccountId: 'XXXXXX-XXXXXX-XXXXXX', // "Your Company"
  // Where the invoice PDFs are listed. Only ever this Google page: the tool never follows a link
  // to anywhere but Google.
  documentsUrl: 'https://console.cloud.google.com/billing/{account}/documents',
  timeZone: 'America/Argentina/Buenos_Aires',

  // The folder Drive for desktop syncs, shared as Viewer with buddy-bot, whose id is
  // INVOICES_FOLDER_ID in infra/config.env. Must be set in config.local.json.
  outputDir: '',

  // This PC only. The profile holds the Google session; the state remembers what was fetched.
  profileDir: path.join(HOME, 'chrome-profile'),
  stateFile: path.join(HOME, 'state.json'),
  logDir: path.join(HOME, 'logs'),

  mail: {
    // Who receives the invoices and the alerts. Work emails, comma-separated in the local file.
    to: ['robin@example.com'],
    // The account that sends them, and whose app password is in Credential Manager.
    from: 'robin@example.com',
    host: 'smtp.gmail.com',
    port: 465,
    credentialName: 'buddy-invoice-fetcher',
  },

  // How long to wait for Google's console, which is slow to draw its tables.
  pageTimeoutMs: 60_000,
  settleMs: 8_000,
  // A sanity limit: a page that suddenly offers more than this is not the page we know.
  maxPerRun: 24,
};

function loadConfig(dir = __dirname) {
  const file = path.join(dir, 'config.local.json');
  let local = {};
  if (fs.existsSync(file)) {
    try { local = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
    catch (err) { throw new Error(`config.local.json isn't valid JSON (${err.message}). Fix it or delete it.`); }
  }
  const config = { ...DEFAULTS, ...local, mail: { ...DEFAULTS.mail, ...(local.mail || {}) } };
  if (typeof config.mail.to === 'string') config.mail.to = config.mail.to.split(',');
  config.mail.to = config.mail.to.map(e => e.trim().toLowerCase()).filter(Boolean);
  config.documentsUrl = config.documentsUrl.replace('{account}', config.billingAccountId);
  return config;
}

// What a run can't do without; checked before any browser opens.
function problems(config, { needOutput = true, needMail = true } = {}) {
  const out = [];
  if (!/^[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}$/.test(config.billingAccountId)) out.push(`billingAccountId "${config.billingAccountId}" doesn't look like a billing account id (XXXXXX-XXXXXX-XXXXXX).`);
  if (new URL(config.documentsUrl).hostname !== 'console.cloud.google.com') out.push('documentsUrl must be on console.cloud.google.com.');
  if (needOutput && !config.outputDir) out.push('outputDir is empty: set it in config.local.json to the Drive for desktop folder, e.g. "G:\\\\My Drive\\\\Buddy invoices".');
  if (needMail && !config.mail.to.length) out.push('mail.to is empty: nobody would get the invoices or the alerts.');
  if (needMail && !config.mail.to.every(e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))) out.push(`mail.to has something that isn't an email: ${config.mail.to.join(', ')}`);
  return out;
}

module.exports = { loadConfig, problems, DEFAULTS, HOME };
