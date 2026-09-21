const test = require('node:test');
const assert = require('node:assert/strict');
const { validateModule } = require('@buddy/core');
const { createOooModule, whenFrom } = require('../src/module');
const { rangeFor, instantsFor } = require('../src/range');

const TZ = 'America/Argentina/Buenos_Aires';
// A Wednesday, 10:00 in Buenos Aires.
const NOW = new Date('2026-09-23T13:00:00Z');

const allDay = (summary, start, end) => ({ summary, start: { date: start }, end: { date: end } });
const timed = (summary, start, end) => ({ summary, start: { dateTime: start }, end: { dateTime: end } });

function setup(items = [], settings = {}) {
  const calls = [];
  const calendarApi = {
    events: { list: async params => { calls.push(params); return { data: { items } }; } },
    calendars: { get: async () => ({ data: { summary: 'Accounts', timeZone: TZ } }) },
  };
  const mod = createOooModule({ calendarApi, now: () => NOW });
  const ctx = {
    settings: { OOO_CALENDAR_ID: 'accounts@example.com', ...settings },
    log: { info() {}, warn() {}, error() {} },
  };
  return { mod, ctx, calls };
}

test('module satisfies the contract', () => validateModule(createOooModule({ calendarApi: {} })));

test('ranges are the week people live in, not UTC', () => {
  assert.deepEqual(rangeFor('today', NOW, TZ), { from: '2026-09-23', to: '2026-09-23', label: 'today' });
  assert.deepEqual(rangeFor('tomorrow', NOW, TZ), { from: '2026-09-24', to: '2026-09-24', label: 'tomorrow' });
  // Monday to Sunday, as the Apps Script did
  assert.deepEqual(rangeFor('week', NOW, TZ), { from: '2026-09-21', to: '2026-09-27', label: 'this week' });
  assert.deepEqual(rangeFor('next week', NOW, TZ), { from: '2026-09-28', to: '2026-10-04', label: 'next week' });
  assert.deepEqual(rangeFor('month', NOW, TZ), { from: '2026-09-01', to: '2026-09-30', label: 'this month' });
  assert.deepEqual(rangeFor('next month', NOW, TZ), { from: '2026-10-01', to: '2026-10-31', label: 'next month' });
});

test('late-evening in Argentina is still "today" there, though UTC has moved on', () => {
  const lateHere = new Date('2026-09-24T02:30:00Z'); // 23:30 on the 23rd in Buenos Aires
  assert.equal(rangeFor('today', lateHere, TZ).from, '2026-09-23');
  assert.equal(rangeFor('today', lateHere, 'Europe/London').from, '2026-09-24');
});

test('the window asked of Google covers the whole local day', () => {
  const { timeMin, timeMax } = instantsFor(rangeFor('today', NOW, TZ), TZ);
  assert.equal(timeMin, '2026-09-23T00:00:00-03:00');
  assert.equal(timeMax, '2026-09-23T23:59:59-03:00');
});

test('all-day leave shows the real last day, not Google\'s exclusive end', async () => {
  // Google stores 22nd–25th inclusive as end date 26th.
  const { mod, ctx } = setup([allDay('Robin (OOO)', '2026-09-22', '2026-09-26')]);
  const reply = await mod.commands.ooo.run(ctx, 'week');
  assert.equal(reply.title, 'Who\'s out this week');
  assert.match(reply.text, /<b>Robin<\/b>: Sep 22 to Sep 25/);
});

test('a single all-day absence is one date, and half-days keep their hours', async () => {
  const { mod, ctx } = setup([
    allDay('Remy (OOO)', '2026-09-23', '2026-09-24'),
    timed('Riley (OOO)', '2026-09-23T08:00:00-03:00', '2026-09-23T12:30:00-03:00'),
  ]);
  const reply = await mod.commands.ooo.run(ctx, 'today');
  assert.match(reply.text, /<b>Remy<\/b>: Sep 23\n/);
  assert.match(reply.text, /<b>Riley<\/b>: Sep 23 \(08:00 - 12:30 ARG\)/);
});

test('the personal block and the team invite are one absence, listed once', async () => {
  const { mod, ctx } = setup([
    allDay('Robin (OOO)', '2026-09-23', '2026-09-24'),
    allDay('Robin (OOO)', '2026-09-23', '2026-09-24'),
  ]);
  const reply = await mod.commands.ooo.run(ctx, 'today');
  assert.equal(reply.text.split('\n').length, 1);
});

test('events without the (OOO) tag are ignored', async () => {
  const { mod, ctx } = setup([
    allDay('All-hands', '2026-09-23', '2026-09-24'),
    allDay('Charlie (OOO)', '2026-09-23', '2026-09-24'),
  ]);
  const reply = await mod.commands.ooo.run(ctx, 'today');
  assert.equal(reply.text, '• <b>Charlie</b>: Sep 23');
});

test('nobody out reads as good news, not as an error', async () => {
  const { mod, ctx } = setup([]);
  const reply = await mod.commands.ooo.run(ctx, 'tomorrow');
  assert.equal(reply.title, 'Nobody\'s out tomorrow');
});

test('no access explains what to fix instead of showing a raw error', async () => {
  const { mod, ctx } = setup();
  mod.commands.ooo.run(ctx, 'today'); // warm the lazy client
  const failing = createOooModule({
    calendarApi: { events: { list: async () => { throw Object.assign(new Error('nope'), { code: 403 }); } } },
    now: () => NOW,
  });
  await assert.rejects(failing.commands.ooo.run(ctx, 'today'), err => {
    assert.equal(err.expose, true);
    assert.match(err.message, /doesn't have access to accounts@example\.com/);
    assert.match(err.message, /buddy-bot@your-gcp-project\.iam\.gserviceaccount\.com/);
    return true;
  });
});

test('the check command reports what Buddy can and cannot reach', async () => {
  const { mod, ctx } = setup([allDay('Robin (OOO)', '2026-09-23', '2026-09-24')]);
  const reply = await mod.commands.ooo.run(ctx, 'check');
  assert.match(reply.text, /✅ Calendar reachable: "Accounts"/);
  assert.match(reply.text, /✅ I can read events: 1 OOO entry this week/);

  const broken = createOooModule({
    calendarApi: { calendars: { get: async () => { throw Object.assign(new Error('nope'), { code: 404 }); } } },
    now: () => NOW,
  });
  assert.match((await broken.commands.ooo.run(ctx, 'check')).text, /❌ .*couldn't find the calendar/);
});

test('the tool is read-only and never asks for approval', async () => {
  const { mod, ctx } = setup([allDay('Robin (OOO)', '2026-09-28', '2026-09-29')]);
  const toolset = await mod.tools(ctx);
  assert.equal(toolset.needsApproval('who_is_out', {}), false);
  const { content } = await toolset.execute('who_is_out', { when: 'next week' });
  assert.equal(content, 'Out of office next week:\n- Robin: Sep 28');
});

test('plain wording maps to a period', () => {
  assert.equal(whenFrom('next week please'), 'next week');
  assert.equal(whenFrom('this week'), 'week');
  assert.equal(whenFrom('tomorrow'), 'tomorrow');
  assert.equal(whenFrom('whatever'), 'today');
});
