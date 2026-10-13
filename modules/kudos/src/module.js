/**
 * Kudos: peer recognition by company value, logged to the Kudos Google Sheet.
 * Votes are handled directly (no Claude), only in the configured Kudos space(s).
 *
 * Built by a factory so tests can inject a fake Sheets client and clock.
 */

const { looksLikeKudos, nominationsFrom, applyPolicy, replyText, DEFAULT_LIMITS } = require('./votes');
const { createKudosSheet, zonedParts } = require('./sheet');

const DEFAULT_TZ = 'America/Argentina/Buenos_Aires';

const list = raw => String(raw || '').split(',').map(s => s.trim()).filter(Boolean);
const positiveInt = (raw, fallback) => (Number.isInteger(Number(raw)) && Number(raw) > 0 ? Number(raw) : fallback);

function defaultSheetsApi() {
  // Required lazily so modules/tests that never touch Google don't load the client.
  const { sheets } = require('@googleapis/sheets');
  const { GoogleAuth } = require('google-auth-library');
  return sheets({ version: 'v4', auth: new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets'] }) });
}

function createKudosModule({ sheetsApi, now = () => new Date() } = {}) {
  let api = sheetsApi;
  const sheetFor = ctx => {
    if (!api) api = defaultSheetsApi();
    return createKudosSheet({ sheetsApi: api, spreadsheetId: ctx.settings.KUDOS_SHEET_ID, tab: ctx.settings.KUDOS_RAW_TAB || 'Raw Data' });
  };

  const config = ctx => ({
    spaces: list(ctx.settings.KUDOS_SPACES),
    timeZone: ctx.settings.KUDOS_TIMEZONE || DEFAULT_TZ,
    leadershipEmails: list(ctx.settings.KUDOS_LEADERSHIP).map(e => e.toLowerCase()),
    limits: {
      perMonth: positiveInt(ctx.settings.KUDOS_MAX_PER_MONTH, DEFAULT_LIMITS.perMonth),
      perPerson: positiveInt(ctx.settings.KUDOS_MAX_PER_PERSON, DEFAULT_LIMITS.perPerson),
    },
  });

  const leadershipIds = async ctx => ((await ctx.store.collection('settings').get('leadership')) || {}).members || [];

  async function isLeader(ctx, sender) {
    const cfg = config(ctx);
    if (sender.email && cfg.leadershipEmails.includes(sender.email.toLowerCase())) return true;
    return (await leadershipIds(ctx)).some(m => m.userId === sender.userId);
  }

  async function thisMonthRows(ctx) {
    const { year, month } = zonedParts(now(), config(ctx).timeZone);
    const rows = await sheetFor(ctx).readVotes();
    return { rows, monthRows: rows.filter(r => r.when && r.when.year === year && r.when.month === month) };
  }

  async function vote(ctx, message) {
    const cfg = config(ctx);
    if (message.space.kind === 'DM') {
      return 'Nice try, chap! Kudos only count when they\'re given in the Kudos channel, not in private chats.';
    }
    if (!cfg.spaces.includes(message.space.name)) {
      return 'Ah, kudos only count in the official Kudos space, so this one wasn\'t logged. Pop it in there!';
    }

    const nominations = nominationsFrom(message);
    if (!nominations.length) return 'Hmm, I didn\'t spot anyone tagged! Type @ and pick your teammate from the list.';

    const { monthRows } = await thisMonthRows(ctx);
    const { accepted, rejected } = applyPolicy({
      nominations,
      sender: message.sender,
      monthRows,
      isLeader: await isLeader(ctx, message.sender),
      limits: cfg.limits,
    });

    if (accepted.length) {
      const { stamp } = zonedParts(now(), cfg.timeZone);
      await sheetFor(ctx).appendVotes(accepted.map(a => [
        stamp, message.sender.displayName, a.value, a.name, message.space.displayName || message.space.name, message.text,
        message.sender.userId, a.userId,
      ]));
      ctx.log.info('kudos logged', { votes: accepted.length, space: message.space.name });
    }
    return replyText({ voterName: message.sender.displayName, accepted, rejected, limits: cfg.limits });
  }

  async function mine(ctx) {
    const cfg = config(ctx);
    const me = { userId: ctx.userId ? `users/${ctx.userId}` : '', displayName: ctx.userDisplayName || '' };
    const { monthRows } = await thisMonthRows(ctx);
    const received = monthRows.filter(r => (r.nomineeId ? r.nomineeId === me.userId : Boolean(me.displayName) && r.nominee === me.displayName));
    const given = monthRows.filter(r => (r.voterId ? r.voterId === me.userId : Boolean(me.displayName) && r.voter === me.displayName));
    const byValue = received.reduce((acc, r) => ({ ...acc, [r.value]: (acc[r.value] || 0) + 1 }), {});
    const breakdown = Object.entries(byValue).map(([v, n]) => `${v} ×${n}`).join(', ');
    return {
      title: 'Your kudos this month',
      text: [
        `Received: ${received.length}${breakdown ? ` (${breakdown})` : ''}`,
        `Given: ${given.length}${(await isLeader(ctx, { email: ctx.userEmail, userId: me.userId })) ? '' : ` of ${cfg.limits.perMonth}`}`,
      ].join('\n'),
    };
  }

  const adminOnly = 'Sorry, chap, only Kudos admins can do that.';

  async function leadership(ctx, message) {
    if (!ctx.hasRole('admin')) return adminOnly;
    const tagged = ((message && message.mentions) || []).filter(m => m.type === 'HUMAN');
    const settings = ctx.store.collection('settings');
    if (tagged.length) {
      const members = tagged.map(m => ({ userId: m.userId, displayName: m.displayName }));
      await settings.set('leadership', { members, updatedBy: ctx.userEmail, updatedAt: now() });
      ctx.log.info('kudos leadership updated', { count: members.length, by: ctx.userEmail });
    }
    const members = await leadershipIds(ctx);
    return {
      title: tagged.length ? 'Leadership updated' : 'Leadership',
      text: members.length
        ? `These people can't win kudos rewards:\n${members.map(m => `• ${m.displayName}`).join('\n')}\n\nTo change the list, tag everyone again: /kudos leadership @Name @Name …`
        : 'No leadership set yet. In a space, tag them: /kudos leadership @Name @Name …',
    };
  }

  async function check(ctx, message) {
    if (!ctx.hasRole('admin')) return adminOnly;
    const cfg = config(ctx);
    const lines = [];
    const here = message && message.space;
    if (here && here.kind === 'SPACE') {
      lines.push(`This space: ${here.displayName || '(no name)'} — id ${here.name}`);
      lines.push(cfg.spaces.includes(here.name) ? '✅ Votes count here.' : `⚠️ Votes don't count here. To allow them, add ${here.name} to KUDOS_SPACES.`);
    }
    try {
      const info = await sheetFor(ctx).describe();
      lines.push(`✅ Sheet reachable: "${info.title}" (time zone ${info.timeZone})`);
      lines.push(info.hasTab ? `✅ Tab "${ctx.settings.KUDOS_RAW_TAB || 'Raw Data'}" found. Headers: ${info.headers.join(' | ') || '(none)'}` : `❌ Tab "${ctx.settings.KUDOS_RAW_TAB || 'Raw Data'}" not found. Tabs: ${info.tabs.join(', ')}`);
      if (info.canWrite === true) lines.push('✅ Buddy can add rows.');
      if (info.canWrite === false) lines.push('❌ Buddy can read the Sheet but can\'t add rows. Share it as Editor with the buddy-bot service account.');
    } catch (error) {
      ctx.log.warn('kudos sheet check failed', { error });
      lines.push('❌ Buddy can\'t open the Kudos Sheet. Share it as Editor with the buddy-bot service account.');
    }
    lines.push(`Time zone for months: ${cfg.timeZone} · Limits: ${cfg.limits.perMonth}/month, ${cfg.limits.perPerson}/person`);
    return { title: 'Kudos setup check', text: lines.join('\n') };
  }

  return {
    name: 'kudos',
    description: 'Give kudos to teammates for living the company values',
    roles: ['admin'],
    settings: ['KUDOS_SHEET_ID'],
    examples: ['In the Kudos space: @Buddy kudos to @Eve for thinking big'],
    instructions: 'Votes are logged automatically in the Kudos space; you cannot log one yourself. If asked how: in '
      + 'that space, "@Buddy kudos to @Name for <value>" — Own it, Think big, Go beyond, Be curious.',

    async handleMessage(ctx, message) {
      if (!looksLikeKudos(message)) return null;
      return vote(ctx, message);
    },

    commands: {
      kudos: {
        description: 'Your kudos this month',
        usage: '/kudos',
        async run(ctx, args) {
          const [sub] = String(args || '').trim().toLowerCase().split(/\s+/);
          if (!sub || sub === 'mine') return mine(ctx);
          if (sub === 'leadership') return leadership(ctx, ctx.message);
          if (sub === 'check') return check(ctx, ctx.message);
          return ctx.hasRole('admin')
            ? 'Usage: /kudos, /kudos check, /kudos leadership @Name …'
            : 'Send /kudos to see your kudos this month.';
        },
      },
    },

    quickActions: async () => [{ text: 'My kudos', command: 'kudos' }],
  };
}

module.exports = { createKudosModule };
