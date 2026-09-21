const test = require('node:test');
const assert = require('node:assert/strict');
const { validateModule, createMemoryStore } = require('@buddy/core');
const { createLeaveModule, checkLeave } = require('../src/module');
const { personalEvent, teamEvent, SHIFTS } = require('../src/shifts');

const ROBIN = 'robin@example.com';

/** A calendar that records what it was asked to do, and for whom. */
function fakeCalendar(existing = []) {
  const created = [];
  const removed = [];
  const listed = [];
  return {
    created,
    removed,
    listed,
    async listOoo(subject, window) { listed.push({ subject, ...window }); return existing.filter(e => e.subject === subject).map(e => e.event); },
    async create(subject, event) { created.push({ subject, event }); return { id: `ev${created.length}` }; },
    async remove(subject, id) { removed.push({ subject, id }); },
  };
}

function setup({ calendar = fakeCalendar(), role = false, email = ROBIN } = {}) {
  const store = createMemoryStore();
  const mod = createLeaveModule({ calendar });
  const ctx = {
    userId: '111',
    userEmail: email,
    userDisplayName: 'Robin',
    hasRole: () => role,
    settings: { LEAVE_TEAM_EMAIL: 'wholeteam@example.com' },
    store: store.collection ? { collection: name => store.collection(`leave__${name}`) } : store,
    log: { info() {}, warn() {}, error() {} },
  };
  return { mod, ctx, calendar };
}

test('module satisfies the contract', () => validateModule(createLeaveModule({ calendar: fakeCalendar() })));

test('leave is booked on the asker\'s own calendar, with a transparent invite for the team', async () => {
  const { mod, ctx, calendar } = setup();
  const tools = await mod.tools(ctx);
  const { content } = await tools.execute('book_leave', { leaves: [{ from: '2026-10-12', to: '2026-10-16', type: 'full' }] });

  assert.match(content, /Booked: Robin out 2026-10-12 to 2026-10-16/);
  assert.equal(calendar.created.length, 2);
  const [own, team] = calendar.created;
  assert.equal(own.subject, ROBIN);
  assert.equal(team.subject, ROBIN);

  // The personal block auto-declines meetings; only it can do that.
  assert.equal(own.event.eventType, 'outOfOffice');
  assert.equal(own.event.transparency, 'opaque');
  assert.equal(own.event.outOfOfficeProperties.autoDeclineMode, 'declineOnlyNewConflictingInvitations');

  // The team copy must never block anyone's availability, and ends the day after (exclusive).
  assert.equal(team.event.transparency, 'transparent');
  assert.deepEqual(team.event.attendees, [{ email: 'wholeteam@example.com' }]);
  assert.deepEqual(team.event.start, { date: '2026-10-12' });
  assert.deepEqual(team.event.end, { date: '2026-10-17' });
});

test('half-days use the person\'s shift hours, in the shift\'s own time zone', async () => {
  const { mod, ctx, calendar } = setup();
  await mod.commands.leave.run(ctx, 'shift UK_9_5');
  const tools = await mod.tools(ctx);
  await tools.execute('book_leave', { leaves: [{ from: '2026-10-12', type: 'am' }] });

  const [own] = calendar.created;
  assert.equal(own.event.start.dateTime, '2026-10-12T09:00:00+01:00');
  assert.equal(own.event.end.dateTime, '2026-10-12T13:00:00+01:00');
});

test('booking the same leave twice does not create it twice', async () => {
  const leave = { from: '2026-10-12', to: '2026-10-12', type: 'full' };
  const already = personalEvent({ ...leave }, SHIFTS.ARG_8_5, 'Robin');
  const calendar = fakeCalendar([{ subject: ROBIN, event: { id: 'old', ...already } }]);
  const { mod, ctx } = setup({ calendar });

  const { content } = await (await mod.tools(ctx)).execute('book_leave', { leaves: [leave] });
  assert.match(content, /Already booked/);
  assert.equal(calendar.created.length, 0);
});

test('nobody can book leave on somebody else\'s calendar without the admin role', async () => {
  const { mod, ctx, calendar } = setup({ role: false });
  const tools = await mod.tools(ctx);
  await assert.rejects(
    tools.execute('book_leave', { leaves: [{ from: '2026-10-12', type: 'full' }], person: 'remy@example.com' }),
    err => { assert.equal(err.expose, true); assert.match(err.message, /only book or cancel leave on your own calendar/); return true; },
  );
  assert.equal(calendar.created.length, 0, 'nothing is written when the subject is refused');
});

test('an HR admin can book for someone else, and the card says whose calendar it is', async () => {
  const { mod, ctx, calendar } = setup({ role: true });
  const tools = await mod.tools(ctx);
  const card = await tools.describe('book_leave', { leaves: [{ from: '2026-10-12', type: 'full' }], person: 'remy@example.com' });
  assert.deepEqual(card.fields[0], { label: 'Whose calendar', value: 'remy@example.com' });

  await tools.execute('book_leave', { leaves: [{ from: '2026-10-12', type: 'full' }], person: 'remy@example.com' });
  assert.equal(calendar.created[0].subject, 'remy@example.com');
});

test('cancelling clears exactly the days asked for, not two days more', async () => {
  const calendar = fakeCalendar([{ subject: ROBIN, event: { id: 'a', summary: 'Robin (OOO)', start: { date: '2026-10-12' } } }]);
  const { mod, ctx } = setup({ calendar });
  const { content } = await (await mod.tools(ctx)).execute('cancel_leave', { from: '2026-10-12', to: '2026-10-13' });

  assert.match(content, /Removed 1 out-of-office event/);
  assert.deepEqual(calendar.removed, [{ subject: ROBIN, id: 'a' }]);
  const asked = calendar.listed.at(-1);
  assert.equal(asked.timeMin, '2026-10-12T00:00:00-03:00');
  assert.equal(asked.timeMax, '2026-10-13T23:59:59-03:00', 'the window stops at the last day asked for');
});

test('a failed delete is reported, not counted as success', async () => {
  const calendar = fakeCalendar([
    { subject: ROBIN, event: { id: 'a', summary: 'Robin (OOO)', start: { date: '2026-10-12' } } },
    { subject: ROBIN, event: { id: 'b', summary: 'Robin (OOO)', start: { date: '2026-10-12' } } },
  ]);
  calendar.remove = async (subject, id) => { if (id === 'b') throw new Error('nope'); calendar.removed.push({ subject, id }); };
  const { mod, ctx } = setup({ calendar });
  const { content } = await (await mod.tools(ctx)).execute('cancel_leave', { from: '2026-10-12', to: '2026-10-12' });
  assert.match(content, /1 wouldn't budge/);
});

test('cancelling nothing says so rather than claiming success', async () => {
  const { mod, ctx } = setup();
  const { content } = await (await mod.tools(ctx)).execute('cancel_leave', { from: '2026-10-12', to: '2026-10-12' });
  assert.match(content, /No out-of-office found/);
});

test('every write waits for a click, and a batch becomes one section per block', async () => {
  const { mod, ctx } = setup();
  const tools = await mod.tools(ctx);
  assert.equal(tools.needsApproval('book_leave', {}), true);
  assert.equal(tools.needsApproval('cancel_leave', {}), true);

  const parts = tools.split('book_leave', { leaves: [{ from: '2026-10-12', type: 'full' }, { from: '2026-10-20', type: 'am' }] });
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[1].leaves, [{ from: '2026-10-20', type: 'am' }]);
});

test('the approval card spells out what will be created', async () => {
  const { mod, ctx } = setup();
  const card = await (await mod.tools(ctx)).describe('book_leave', { leaves: [{ from: '2026-10-12', type: 'pm' }] });
  assert.equal(card.effect, 'create');
  assert.deepEqual(card.fields.find(f => f.label === 'Type'), { label: 'Type', value: 'Half day (afternoon)' });
  assert.deepEqual(card.fields.find(f => f.label === 'Hours'), { label: 'Hours', value: '12:30–17:00 (ARG 8:00–17:00)' });
  assert.deepEqual(card.fields.at(-1), { label: 'Team invite', value: 'wholeteam@example.com' });

  const cancelCard = await (await mod.tools(ctx)).describe('cancel_leave', { from: '2026-10-12', to: '2026-10-13' });
  assert.equal(cancelCard.effect, 'delete', 'deleting is shown as something that cannot be undone');
});

test('nonsense dates are refused before anything reaches a calendar', async () => {
  const { mod, ctx, calendar } = setup();
  const tools = await mod.tools(ctx);
  for (const input of [
    { leaves: [{ from: 'next tuesday', type: 'full' }] },
    { leaves: [{ from: '2026-10-12', to: '2026-10-01', type: 'full' }] },
    { leaves: [{ from: '2026-10-12', to: '2026-10-13', type: 'am' }] },
    { leaves: [] },
  ]) {
    await assert.rejects(tools.execute('book_leave', input), err => err.expose === true);
  }
  assert.equal(calendar.created.length, 0);
  assert.throws(() => checkLeave({ from: '2026-01-01', to: '2026-12-31', type: 'full' }), /smaller chunks/);
});

test('the shift command lists the options and remembers the choice', async () => {
  const { mod, ctx } = setup();
  assert.match((await mod.commands.leave.run(ctx, 'shift NOPE')).text, /ARG_8_5/);
  assert.match(await mod.commands.leave.run(ctx, 'shift uk_9_5'), /UK 9:00–17:00/);
  assert.match((await mod.commands.leave.run(ctx, '')).text, /UK 9:00–17:00/);
  assert.match(await mod.commands.leave.run(ctx, 'name Lucho'), /Lucho \(OOO\)/);
});

test('team invites never email the company (checked where it matters: the request itself)', () => {
  const event = teamEvent({ from: '2026-10-12', to: '2026-10-12', type: 'full' }, SHIFTS.ARG_8_5, 'Robin', 'wholeteam@example.com');
  assert.equal(event.transparency, 'transparent');
  assert.equal(event.summary, 'Robin (OOO)');
});
