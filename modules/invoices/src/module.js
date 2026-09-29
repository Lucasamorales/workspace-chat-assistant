/**
 * Invoices: Google Cloud's invoices, where you can find them, and a message when a new one lands.
 *
 * Google has no API for invoice PDFs, so a fetcher on a PC (tools/invoice-fetcher) downloads them
 * from the billing console and saves them into a Drive folder. This module only reads that folder:
 * it never touches Google billing, and never holds anyone's Google login.
 *
 * Who can use it comes from BUDDY_ACCESS_INVOICES, like every module. Who is *told* about a new
 * invoice comes from INVOICES_NOTIFY, and Buddy only ever delivers that to people who can use
 * the module — adding someone to the notify list alone is not enough to show them anything.
 */

const { createDrive } = require('./drive');
const { createTokens } = require('./token');
const { listReply, announcement, checkReply, DEFAULT_TZ } = require('./present');

const STATE = 'state';
const KEEP_SEEN = 500;
// The first announcement after switching on covers the last week only, not years of invoices.
const FIRST_RUN_DAYS = 7;

const list = raw => String(raw || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

function defaultTokens(log) {
  // Required lazily so tests never load the Google client.
  const { GoogleAuth } = require('google-auth-library');
  return createTokens({ auth: new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }), log });
}

function createInvoicesModule({ drive: injected, tokens: injectedTokens, now = () => Date.now() } = {}) {
  let tokens = injectedTokens;
  const driveFor = ctx => injected || createDrive({
    tokenFor: () => {
      if (!tokens) tokens = defaultTokens(ctx.log);
      return tokens.forDrive();
    },
    folderId: ctx.settings.INVOICES_FOLDER_ID,
  });
  const zone = ctx => ctx.settings.INVOICES_TIMEZONE || DEFAULT_TZ;
  const notifyList = ctx => list(ctx.settings.INVOICES_NOTIFY);

  /**
   * Which invoices nobody has been told about yet — decided apart from telling anyone, so it can
   * be tested on its own. An invoice counts as told once its note is handed to Buddy, even if a
   * delivery then fails (someone who never opened a chat with Buddy, say): re-announcing it every
   * day would be worse, and it is always in /invoices.
   */
  function whatIsNew(files, state) {
    if (!state || !state.initialised) {
      const since = now() - FIRST_RUN_DAYS * 24 * 3600 * 1000;
      return files.filter(f => Date.parse(f.createdTime) >= since);
    }
    const seen = new Set(state.seen || []);
    return files.filter(f => !seen.has(f.id));
  }

  async function daily(ctx) {
    const notify = notifyList(ctx);
    // With nobody to tell, don't even start keeping track: switching the list on later should
    // still announce the latest week, not silently swallow it.
    if (!notify.length) return [];

    const col = ctx.store.collection('invoices');
    const files = await driveFor(ctx).invoices();
    const state = await col.get(STATE);
    const fresh = whatIsNew(files, state);
    const seen = [...new Set([...files.map(f => f.id), ...((state && state.seen) || [])])].slice(0, KEEP_SEEN);
    await col.set(STATE, { initialised: true, seen, checkedAt: new Date(now()).toISOString() });
    ctx.log.info('invoices checked', { inFolder: files.length, fresh: fresh.length, notify: notify.length });
    return fresh.length ? [{ to: notify, reply: announcement(fresh, { timeZone: zone(ctx) }) }] : [];
  }

  return {
    name: 'invoices',
    description: 'Google Cloud invoices, as they arrive',
    allowedIn: ['DM'],
    settings: ['INVOICES_FOLDER_ID'],
    examples: ['/invoices'],

    commands: {
      invoices: {
        description: 'The latest Google Cloud invoices',
        usage: '/invoices [check]',
        async run(ctx, args) {
          const sub = String(args || '').trim().toLowerCase();
          if (sub === 'check') {
            try {
              const d = driveFor(ctx);
              const [folder, files] = await Promise.all([d.folder(), d.invoices()]);
              return checkReply({ folder, files, notify: notifyList(ctx) });
            } catch (error) {
              ctx.log.warn('invoices check failed', { error, detail: error.detail });
              return checkReply({ error: error.expose ? error : { message: 'I couldn\'t read the invoices folder.' }, notify: notifyList(ctx) });
            }
          }
          if (sub) return 'Usage: `/invoices`, or `/invoices check` to see whether the folder is set up.';
          return listReply(await driveFor(ctx).invoices(), { timeZone: zone(ctx) });
        },
      },
    },

    quickActions: async () => [{ text: 'Latest invoices', command: 'invoices' }],

    async onSchedule(ctx, task) {
      if (task !== 'daily') return [];
      return daily(ctx);
    },
  };
}

module.exports = { createInvoicesModule, FIRST_RUN_DAYS };
