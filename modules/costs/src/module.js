/**
 * Costs: what Buddy is spending, by person, module and tool.
 *
 * Admin-only, and metadata only — what people asked and what Buddy answered are never recorded,
 * so this can say "Robin spent $2.10 on the manual" and can never say what he asked it.
 * Decision: docs/decisions/0006-costs.md.
 */

const { createCostsSheet } = require('./sheet');
const { groupBy, byTool, waste, weeklyRows, weekOf, totals, money, round } = require('./report');

const DEFAULT_TZ = 'America/Argentina/Buenos_Aires';
const STATE = 'state';

function defaultSheetsApi() {
  // Required lazily so tests and other modules never load the Google client.
  const { sheets } = require('@googleapis/sheets');
  const { GoogleAuth } = require('google-auth-library');
  return sheets({ version: 'v4', auth: new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets'] }) });
}

const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const shortName = email => String(email || '').split('@')[0];

function createCostsModule({ usage, sheetsApi, now = () => new Date() } = {}) {
  let api = sheetsApi;
  const sheetFor = ctx => {
    if (!ctx.settings.COSTS_SHEET_ID) return null;
    if (!api) api = defaultSheetsApi();
    return createCostsSheet({ sheetsApi: api, spreadsheetId: ctx.settings.COSTS_SHEET_ID, tab: ctx.settings.COSTS_SHEET_TAB });
  };
  const zone = ctx => ctx.settings.COSTS_TIMEZONE || DEFAULT_TZ;
  const state = ctx => ctx.store.collection('state');

  const since = days => new Date(now().getTime() - days * 24 * 3600 * 1000).toISOString();

  /** This month so far, in the reporting time zone. */
  const monthStart = ctx => {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone(ctx), year: 'numeric', month: '2-digit' })
      .formatToParts(now());
    const get = t => parts.find(p => p.type === t).value;
    return `${get('year')}-${get('month')}-01T00:00:00.000Z`;
  };

  async function summary(ctx, from, label) {
    const events = await usage.events(from);
    if (!events.length) return { title: `Costs ${label}`, text: 'Nothing recorded yet.' };

    const all = totals(events);
    const people = groupBy(events, 'userEmail');
    const modules = groupBy(events, 'module');
    const w = waste(events);

    const lines = [
      `**${money(all.usd)}** over **${all.requests} requests** · ${money(all.usd / all.requests)} each`
      + ` · ${(all.ms / all.requests / 1000).toFixed(1)}s each`,
      '',
      '**By person**',
      ...people.map(p => `\`${pad(shortName(p.name), 12)} ${pad(money(p.usd), 8)}\` ${p.requests} requests`),
      '',
      '**By module**',
      ...modules.map(m => `\`${pad(m.name, 12)} ${pad(money(m.usd), 8)}\` ${m.requests} requests`),
    ];

    if (w.requests) {
      lines.push('', `**Wasted** ${money(w.usd)} on ${w.requests} requests that produced nothing`
        + ` (${w.byOutcome.map(o => `${o.requests} ${o.name}`).join(', ')})`);
    }
    if (w.cacheHitRate !== null) {
      lines.push(`**Cache** ${(w.cacheHitRate * 100).toFixed(0)}% of repeated context read from cache`
        + `${w.cacheHitRate < 0.5 ? ' — low, so history is being paid for twice' : ''}`);
    }
    return { title: `Costs ${label}`, text: lines.join('\n') };
  }

  /** Writes any completed week that is not in the Sheet yet. Never writes the week in progress. */
  async function rollup(ctx, { force = false } = {}) {
    const sheet = sheetFor(ctx);
    if (!sheet) return { written: 0, reason: 'no Sheet configured (COSTS_SHEET_ID)' };

    const thisWeek = weekOf(now().toISOString(), zone(ctx));
    const events = (await usage.events(since(90))).filter(e => weekOf(e.at, zone(ctx)) < thisWeek);
    if (!events.length) return { written: 0, reason: 'no finished week to write yet' };

    const already = await sheet.weeksWritten();
    const rows = weeklyRows(events, zone(ctx), now().toISOString())
      .filter(row => force || !already.has(row[0]));
    if (!rows.length) return { written: 0, reason: 'every finished week is already in the Sheet' };

    await sheet.append(rows);
    await state(ctx).set(STATE, { lastRollupAt: now().toISOString(), lastWeek: thisWeek });
    ctx.log.info('costs rolled up to the Sheet', { rows: rows.length, by: ctx.userEmail || 'automatic' });
    return { written: rows.length, weeks: [...new Set(rows.map(r => r[0]))] };
  }

  /** Once a week, on the first message after the week turns over. Failure must never be visible. */
  async function maybeRollup(ctx) {
    if (!ctx.settings.COSTS_SHEET_ID) return;
    const thisWeek = weekOf(now().toISOString(), zone(ctx));
    const saved = (await state(ctx).get(STATE)) || {};
    if (saved.lastWeek === thisWeek) return;
    try {
      await rollup(ctx);
    } catch (error) {
      ctx.log.warn('weekly costs rollup failed', { error });
      await state(ctx).set(STATE, { ...saved, lastAttemptAt: now().toISOString() });
    }
  }

  return {
    name: 'costs',
    description: 'What Buddy costs, by person and module',
    allowedIn: ['DM'],
    settings: [],
    examples: [],

    // Nothing here is offered to Claude: costs are read with a command, never through a tool,
    // so no conversation can be steered into reporting on someone.

    async handleMessage(ctx) {
      // Riding an ordinary message avoids opening buddy-bot to a scheduler (0006-costs.md).
      await maybeRollup(ctx);
      return null;
    },

    commands: {
      costs: {
        description: 'What Buddy costs',
        usage: '/costs [week|waste|sheet|check]',
        async run(ctx, args) {
          const sub = String(args || '').trim().toLowerCase();

          if (sub === 'week') return summary(ctx, since(7), 'in the last 7 days');

          if (sub === 'waste') {
            const events = await usage.events(monthStart(ctx));
            if (!events.length) return { title: 'Waste', text: 'Nothing recorded yet.' };
            const w = waste(events);
            const tools = byTool(events).filter(t => t.failed);
            return {
              title: 'Waste this month',
              text: [
                `**${money(w.usd)}** on ${w.requests} requests that produced nothing.`,
                ...w.byOutcome.map(o => `\`${pad(o.name, 10)} ${pad(money(o.usd), 8)}\` ${o.requests}`),
                '',
                w.cacheHitRate === null
                  ? '**Cache** nothing cached yet.'
                  : `**Cache** ${(w.cacheHitRate * 100).toFixed(0)}% of repeated context read from cache`
                    + ` (${w.cacheRead.toLocaleString()} read, ${w.cacheWrite.toLocaleString()} written)`,
                ...(tools.length ? ['', '**Tools that failed**', ...tools.map(t => `\`${pad(t.name, 26)}\` ${t.failed} of ${t.calls}`)] : []),
              ].join('\n'),
            };
          }

          if (sub === 'tools') {
            const tools = byTool(await usage.events(monthStart(ctx)));
            if (!tools.length) return { title: 'Tools this month', text: 'No tools have run yet.' };
            return {
              title: 'Tools this month',
              text: tools.map(t => `\`${pad(t.name, 28)}\` ${t.calls} call${t.calls === 1 ? '' : 's'}`
                + `${t.failed ? ` · ${t.failed} failed` : ''}`).join('\n'),
            };
          }

          if (sub === 'sheet') {
            const result = await rollup(ctx, { force: false });
            return result.written
              ? `Wrote ${result.written} row(s) to the costs Sheet for ${result.weeks.join(', ')}.`
              : `Nothing to write: ${result.reason}.`;
          }

          if (sub === 'check') {
            const lines = [];
            const sheet = sheetFor(ctx);
            if (!sheet) {
              lines.push('⚠️ No costs Sheet configured — set COSTS_SHEET_ID to get the weekly rollup.');
            } else {
              try {
                const info = await sheet.describe();
                lines.push(`✅ Sheet reachable: "${info.title}"`);
                lines.push(info.hasTab ? '✅ "Weekly" tab found.' : `❌ No "Weekly" tab. Tabs: ${info.tabs.join(', ')}`);
                const weeks = await sheet.weeksWritten();
                lines.push(`Weeks already written: ${weeks.size || 'none yet'}`);
              } catch (error) {
                ctx.log.warn('costs sheet check failed', { error });
                lines.push(`❌ ${error.expose ? error.message : 'Buddy can\'t open the costs Sheet.'}`);
              }
            }
            const events = await usage.events(since(90));
            lines.push(`Events kept: ${events.length} (90 days) · reporting in ${zone(ctx)}`);
            return { title: 'Costs setup check', text: lines.join('\n') };
          }

          return summary(ctx, monthStart(ctx), 'this month');
        },
      },
    },

    quickActions: async () => [{ text: 'Costs', command: 'costs' }],
  };
}

module.exports = { createCostsModule, round };
