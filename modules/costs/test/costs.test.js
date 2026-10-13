const test = require('node:test');
const assert = require('node:assert/strict');
const { validateModule, createMemoryStore, createUsage } = require('@buddy/core');
const { createCostsModule } = require('../src/module');
const { groupBy, byTool, waste, weeklyRows, weekOf, totals } = require('../src/report');

const NOW = new Date('2026-09-23T12:00:00Z'); // a Wednesday
const TZ = 'America/Argentina/Buenos_Aires';

const event = (over = {}) => ({
  at: '2026-09-22T10:00:00.000Z',
  userEmail: 'robin@example.com',
  module: 'manual',
  tools: [{ name: 'manual__search_manual' }],
  outcome: 'answered',
  calls: 1,
  requests: 1,
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  usd: 0.004,
  ms: 2000,
  ...over,
});

function fakeSheet() {
  const appended = [];
  let rows = [];
  return {
    appended,
    api: {
      spreadsheets: {
        get: async () => ({ data: { properties: { title: 'Buddy costs' }, sheets: [{ properties: { title: 'Weekly' } }] } }),
        values: {
          get: async () => ({ data: { values: rows.map(r => [r[0]]) } }),
          append: async ({ requestBody }) => { appended.push(...requestBody.values); rows = [...rows, ...requestBody.values]; return {}; },
        },
      },
    },
  };
}

function setup({ events = [], sheetId = 'sheet1' } = {}) {
  const store = createMemoryStore();
  const usage = {
    events: async since => events.filter(e => !since || e.at >= since).sort((a, b) => a.at.localeCompare(b.at)),
  };
  const sheet = fakeSheet();
  const mod = createCostsModule({ usage, sheetsApi: sheet.api, now: () => NOW });
  const logged = [];
  const ctx = {
    userEmail: 'robin@example.com',
    hasRole: () => true,
    settings: { ...(sheetId ? { COSTS_SHEET_ID: sheetId } : {}), COSTS_TIMEZONE: TZ },
    store: { collection: name => store.collection(`costs__${name}`) },
    log: { info: (msg, data) => logged.push({ msg, data }), warn: (msg, data) => logged.push({ msg, data }), error() {} },
  };
  return { mod, ctx, sheet, logged };
}

test('module satisfies the contract', () => validateModule(createCostsModule({ usage: {} })));

/* ---------- the numbers ---------- */

test('spend is grouped by person and by module, biggest first', () => {
  const events = [
    event({ userEmail: 'robin@example.com', module: 'manual', usd: 0.01 }),
    event({ userEmail: 'remy@example.com', module: 'asana', usd: 0.05 }),
    event({ userEmail: 'remy@example.com', module: 'manual', usd: 0.02 }),
  ];
  assert.deepEqual(groupBy(events, 'userEmail').map(p => [p.name, p.requests]), [
    ['remy@example.com', 2],
    ['robin@example.com', 1],
  ]);
  assert.deepEqual(groupBy(events, 'module').map(m => m.name), ['asana', 'manual']);
  assert.equal(totals(events).requests, 3);
});

test('tools are counted with their failures', () => {
  const events = [
    event({ tools: [{ name: 'manual__search_manual' }, { name: 'asana__create', failed: true }] }),
    event({ tools: [{ name: 'manual__search_manual' }] }),
  ];
  assert.deepEqual(byTool(events), [
    { name: 'manual__search_manual', calls: 2, failed: 0 },
    { name: 'asana__create', calls: 1, failed: 1 },
  ]);
});

test('waste is what was paid for requests that produced nothing', () => {
  const events = [
    event({ outcome: 'answered', usd: 0.10 }),
    event({ outcome: 'failed', usd: 0.02 }),
    event({ outcome: 'declined', usd: 0.03 }),
    event({ outcome: 'expired', usd: 0.01 }),
  ];
  const w = waste(events);
  assert.equal(w.requests, 3);
  assert.equal(Number(w.usd.toFixed(2)), 0.06);
  assert.deepEqual(w.byOutcome.map(o => o.name).sort(), ['declined', 'expired', 'failed']);
});

test('cache hit rate shows history being paid for twice', () => {
  assert.equal(waste([event({ cacheReadTokens: 9000, cacheWriteTokens: 1000 })]).cacheHitRate, 0.9);
  assert.equal(waste([event({ cacheReadTokens: 0, cacheWriteTokens: 4000 })]).cacheHitRate, 0);
  assert.equal(waste([event()]).cacheHitRate, null, 'nothing cached yet is not a zero score');
});

test('a week runs Monday to Sunday in the reporting time zone', () => {
  assert.equal(weekOf('2026-09-23T12:00:00Z', TZ), '2026-09-21');
  // 02:00 UTC on Monday is 23:00 on Sunday in Buenos Aires — still last week for the team.
  assert.equal(weekOf('2026-09-21T02:00:00Z', TZ), '2026-09-14');
  assert.equal(weekOf('2026-09-21T03:00:00Z', TZ), '2026-09-21', 'and 03:00 UTC is Monday there');
  assert.equal(weekOf('2026-09-27T23:00:00Z', TZ), '2026-09-21');
});

test('a Sheet row is one person, one module, one week, in the agreed column order', () => {
  const rows = weeklyRows([
    event({ at: '2026-09-15T10:00:00.000Z', usd: 0.01, tools: [{ name: 'manual__search_manual' }] }),
    event({ at: '2026-09-16T10:00:00.000Z', usd: 0.02, outcome: 'failed' }),
  ], TZ, '2026-09-23T12:00:00.000Z');

  assert.equal(rows.length, 1, 'same person, module and week is one row');
  assert.deepEqual(rows[0].slice(0, 5), ['2026-09-14', 'robin@example.com', 'manual', 2, 2]);
  assert.equal(rows[0][9], 0.03, 'cost');
  assert.equal(rows[0][10], 1, 'failed');
  assert.equal(rows[0].length, 14, 'the workbook has 14 columns; adding one goes on the right');
});

/* ---------- the command ---------- */

test('/costs shows the month by person and module', async () => {
  const { mod, ctx } = setup({
    events: [
      event({ userEmail: 'robin@example.com', module: 'manual', usd: 0.5 }),
      event({ userEmail: 'remy@example.com', module: 'asana', usd: 1.5 }),
    ],
  });
  const reply = await mod.commands.costs.run(ctx, '');
  assert.match(reply.title, /Costs this month/);
  assert.match(reply.text, /\*\*\$2\.00\*\* over \*\*2 requests\*\*/);
  assert.match(reply.text, /remy/);
  assert.match(reply.text, /asana/);
});

test('/costs waste calls out a low cache hit rate', async () => {
  const { mod, ctx } = setup({
    events: [
      event({ outcome: 'failed', usd: 0.2, cacheReadTokens: 100, cacheWriteTokens: 900 }),
      event({ outcome: 'answered', usd: 0.1, tools: [{ name: 'asana__create', failed: true }] }),
    ],
  });
  const reply = await mod.commands.costs.run(ctx, 'waste');
  assert.match(reply.text, /1 requests that produced nothing|on 1 requests/);
  assert.match(reply.text, /10% of repeated context/);
  assert.match(reply.text, /asana__create/);
});

test('/costs tools lists what ran', async () => {
  const { mod, ctx } = setup({ events: [event(), event({ tools: [{ name: 'ooo__who_is_out' }] })] });
  const reply = await mod.commands.costs.run(ctx, 'tools');
  assert.match(reply.text, /manual__search_manual/);
  assert.match(reply.text, /ooo__who_is_out/);
});

test('nothing recorded yet reads as nothing recorded, not as zero', async () => {
  const { mod, ctx } = setup({ events: [] });
  assert.match((await mod.commands.costs.run(ctx, '')).text, /Nothing recorded yet/);
});

/* ---------- the weekly Sheet ---------- */

test('the rollup writes finished weeks only, never the week in progress', async () => {
  const { mod, ctx, sheet } = setup({
    events: [
      event({ at: '2026-09-15T10:00:00.000Z' }),   // week of the 14th: finished
      event({ at: '2026-09-23T10:00:00.000Z' }),   // this week: still running
    ],
  });
  const reply = await mod.commands.costs.run(ctx, 'sheet');
  assert.match(reply, /Wrote 1 row/);
  assert.equal(sheet.appended.length, 1);
  assert.equal(sheet.appended[0][0], '2026-09-14');
});

test('a week already in the Sheet is not written twice', async () => {
  const { mod, ctx, sheet } = setup({ events: [event({ at: '2026-09-15T10:00:00.000Z' })] });
  await mod.commands.costs.run(ctx, 'sheet');
  const second = await mod.commands.costs.run(ctx, 'sheet');
  assert.match(second, /already in the Sheet/);
  assert.equal(sheet.appended.length, 1);
});

test('the weekly write rides an ordinary message, once a week', async () => {
  const { mod, ctx, sheet } = setup({ events: [event({ at: '2026-09-15T10:00:00.000Z' })] });
  assert.equal(await mod.handleMessage(ctx), null, 'it never answers a message');
  assert.equal(sheet.appended.length, 1);

  await mod.handleMessage(ctx);
  assert.equal(sheet.appended.length, 1, 'once this week is enough');
});

test('a Sheet failure never reaches the person who happened to send a message', async () => {
  const { mod, ctx, logged } = setup({ events: [event({ at: '2026-09-15T10:00:00.000Z' })] });
  const broken = createCostsModule({
    usage: { events: async () => [event({ at: '2026-09-15T10:00:00.000Z' })] },
    sheetsApi: { spreadsheets: { values: { get: async () => { throw Object.assign(new Error('nope'), { code: 403 }); } } } },
    now: () => NOW,
  });
  assert.equal(await broken.handleMessage(ctx), null);
  assert.ok(logged.some(l => /rollup failed/.test(l.msg)), 'it is logged rather than shown');
});

test('with no Sheet configured, everything else still works', async () => {
  const { mod, ctx } = setup({ events: [event()], sheetId: null });
  assert.equal(await mod.handleMessage(ctx), null);
  assert.match(await mod.commands.costs.run(ctx, 'sheet'), /no Sheet configured/);
  assert.match((await mod.commands.costs.run(ctx, 'check')).text, /No costs Sheet configured/);
  assert.match((await mod.commands.costs.run(ctx, '')).text, /over \*\*1 requests\*\*/);
});

test('costs are never offered to Claude as a tool', () => {
  const { mod } = setup();
  assert.equal(mod.tools, undefined, 'no conversation can be steered into reporting on someone');
});

/* ---------- spend that isn't a conversation ---------- */

const spendEvent = (over = {}) => ({
  at: '2026-09-22T11:00:00.000Z',
  userEmail: 'robin@example.com',
  module: 'manual',
  kind: 'embeddings',
  outcome: 'spend',
  units: 500000,
  usd: 0.0125,
  calls: 0,
  tools: [],
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ms: 0,
  ...over,
});

test('embedding spend is reported, and never inflates the request count', async () => {
  const { mod, ctx } = setup({ events: [event({ usd: 0.10 }), spendEvent()] });
  const reply = await mod.commands.costs.run(ctx, '');

  assert.match(reply.text, /over \*\*1 requests\*\*/, 'indexing is not a conversation');
  assert.match(reply.text, /\*\*Outside Claude\*\*/);
  assert.match(reply.text, /manual embeddings/);
  assert.match(reply.text, /500,000 characters/);
});

test('spend alone still reports, rather than dividing by no requests', async () => {
  const { mod, ctx } = setup({ events: [spendEvent()] });
  const reply = await mod.commands.costs.run(ctx, '');
  assert.match(reply.text, /No conversations yet/);
  assert.match(reply.text, /manual embeddings/);
});

test('the weekly Sheet counts a conversation row, not the embedding row', () => {
  const rows = weeklyRows([
    event({ at: '2026-09-15T10:00:00.000Z', usd: 0.01 }),
    spendEvent({ at: '2026-09-15T11:00:00.000Z' }),
  ].filter(e => e.outcome !== 'spend'), TZ, '2026-09-23T12:00:00.000Z');
  assert.equal(rows.length, 1);
  assert.equal(rows[0][3], 1, 'one request');
});

test('an uploaded .xlsx is named as the problem, not a missing tab', async () => {
  const { createCostsSheet } = require('../src/sheet');
  const excel = createCostsSheet({
    spreadsheetId: 'x',
    sheetsApi: {
      spreadsheets: {
        get: async () => {
          throw Object.assign(new Error('bad'), {
            code: 400,
            response: { data: { error: { message: 'This operation is not supported for this document' } } },
          });
        },
      },
    },
  });
  await assert.rejects(excel.describe(), err => {
    assert.match(err.message, /isn't a Google Sheet yet/);
    assert.match(err.message, /Save as Google Sheets/);
    return true;
  });

  const noTab = createCostsSheet({
    spreadsheetId: 'x',
    sheetsApi: {
      spreadsheets: {
        values: {
          get: async () => {
            throw Object.assign(new Error('bad'), {
              code: 400,
              response: { data: { error: { message: 'Unable to parse range: \'Weekly\'!A2:A' } } },
            });
          },
        },
      },
    },
  });
  await assert.rejects(noTab.weeksWritten(), /no "Weekly" tab/);
});

test('a request that failed before Claude answered is still recorded', async () => {
  const store = createMemoryStore();
  const usage = createUsage({ store, capUsd: 15, prices: { inPerMTok: 2, outPerMTok: 10 }, now: () => NOW });
  const meter = usage.meter({ userId: '111', userEmail: 'robin@example.com' });

  const failed = await meter.finish({ outcome: 'failed' });
  assert.ok(failed, 'a failure that cost nothing is exactly what the waste report is for');
  assert.equal(failed.usd, 0);
  assert.equal((await usage.events()).length, 1);

  // A request that did nothing at all and simply answered is still not worth a row.
  const quiet = usage.meter({ userId: '111', userEmail: 'robin@example.com' });
  assert.equal(await quiet.finish({ outcome: 'answered' }), null);
});

test('/costs splits by model once more than one is in play, and stays quiet when it is not', async () => {
  const oneModel = setup({
    events: [event({ model: 'claude-sonnet-5', usd: 0.5 }), event({ model: 'claude-sonnet-5', usd: 0.5 })],
  });
  assert.doesNotMatch((await oneModel.mod.commands.costs.run(oneModel.ctx, '')).text, /By model/);

  const { mod, ctx } = setup({
    events: [
      event({ model: 'claude-sonnet-5', usd: 0.90 }),
      event({ model: 'claude-haiku-4-5', usd: 0.10 }),
    ],
  });
  const reply = await mod.commands.costs.run(ctx, '');
  assert.match(reply.text, /\*\*By model\*\*/);
  assert.match(reply.text, /sonnet-5/);
  assert.match(reply.text, /haiku-4-5/);
  assert.doesNotMatch(reply.text, /claude-haiku/, 'the repeated "claude-" prefix is dropped');
});

/* ---------- experiment 0010: the subscription proxy ---------- */

test('/costs keeps subscription requests out of the API figures and reports the window instead', async () => {
  const sub = over => event({
    backend: 'subscription', usd: 0, apiEquivalentUsd: 0.04, ms: 1500,
    subscription: { fiveHour: 0.31, sevenDay: 0.04, resetsAt: 1790610000, usingOverage: false }, ...over,
  });
  const { mod, ctx } = setup({
    events: [
      event({ userEmail: 'remy@example.com', module: 'asana', usd: 0.10 }),
      sub({ at: '2026-09-22T10:00:00.000Z' }),
      sub({ at: '2026-09-22T11:00:00.000Z', subscription: { fiveHour: 0.35, sevenDay: 0.05, resetsAt: 1790610000, usingOverage: false } }),
    ],
  });
  const reply = await mod.commands.costs.run(ctx, '');
  assert.match(reply.text, /\*\*10\.0¢\*\* over \*\*1 requests\*\*/, 'the API average is not diluted by $0 requests');
  assert.match(reply.text, /On the subscription/);
  assert.match(reply.text, /2 requests · 35% of the 5-hour window · 5% of the week/, 'the latest window, not the first');
  assert.match(reply.text, /Would have cost \*\*8\.0¢\*\* on the API/);
});

test('/costs with only subscription use says so, rather than "nothing yet"', async () => {
  const { mod, ctx } = setup({ events: [event({ backend: 'subscription', usd: 0, apiEquivalentUsd: 0.02, subscription: { fiveHour: 0.2 } })] });
  const reply = await mod.commands.costs.run(ctx, '');
  assert.match(reply.text, /No API conversations yet/);
  assert.match(reply.text, /On the subscription/);
});
