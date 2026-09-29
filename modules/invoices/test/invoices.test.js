const test = require('node:test');
const assert = require('node:assert/strict');
const { validateModule, createMemoryStore } = require('@buddy/core');
const { createInvoicesModule } = require('../src/module');
const { dueDate, parseReady, standing, afterReminder, addWorkdays, MAX_REMINDERS } = require('../src/schedule');
const { parseBill } = require('../src/bills');

const TZ = 'America/Argentina/Buenos_Aires';
const GCP = 'https://console.cloud.google.com/billing/XXXXXX-XXXXXX-XXXXXX/invoices?organizationId=000000000000';
// 09:00 in Buenos Aires (UTC-3) on a given day.
const at = date => Date.parse(`${date}T12:00:00Z`);

function setup({ admin = true, email = 'robin@example.com', folder = '1UaRlFoSIiRoanmiq_FDHnBMPqCycf6t9' } = {}) {
  const clock = { now: at('2026-09-29') };
  const store = createMemoryStore();
  const mod = createInvoicesModule({ now: () => clock.now });
  const ctxFor = (who = email, isAdmin = admin) => ({
    userEmail: who,
    settings: { INVOICES_TIMEZONE: TZ, INVOICES_FOLDER_ID: folder },
    store: { collection: name => store.collection(`m_invoices__${name}`) },
    hasRole: role => role === 'admin' && isAdmin,
    log: { info() {}, warn() {}, error() {} },
  });
  const run = (args, ctx = ctxFor()) => mod.commands.invoices.run(ctx, args);
  const system = ctxFor('', false);
  return { mod, clock, ctxFor, run, daily: () => mod.onSchedule(system, 'daily'), store };
}
const addGcp = run => run(`add Google Cloud | ${GCP} | 5th working day`);

test('module satisfies the contract', () => validateModule(createInvoicesModule()));

/* ---------- when a bill is due ---------- */

test('the 5th working day of October 2026 is Wednesday the 7th (the 1st is a Thursday)', () => {
  assert.equal(dueDate({ kind: 'workday', n: 5 }, '2026-10'), '2026-10-07');
  assert.equal(dueDate({ kind: 'workday', n: 1 }, '2026-08'), '2026-08-03', 'August 2026 starts on a Saturday');
  assert.equal(dueDate({ kind: 'day', n: 31 }, '2026-02'), '2026-02-28', 'a day the month lacks means its last day');
  assert.equal(dueDate({ kind: 'workday', n: 23 }, '2026-02'), '2026-02-27', 'more working days than the month has: the last one');
});

test('"when it\'s ready" in the words people use', () => {
  assert.deepEqual(parseReady('5th working day'), { kind: 'workday', n: 5 });
  assert.deepEqual(parseReady('the 3rd business day of the month'), { kind: 'workday', n: 3 });
  assert.deepEqual(parseReady('workday 2'), { kind: 'workday', n: 2 });
  assert.deepEqual(parseReady('day 1'), { kind: 'day', n: 1 });
  assert.deepEqual(parseReady('15th of each month'), { kind: 'day', n: 15 });
  assert.equal(parseReady('soon'), null);
  assert.equal(parseReady('day 32'), null);
});

test('reminders: on the due day, then every 2 working days, 3 times at most, never at weekends', () => {
  const bill = { ready: { kind: 'workday', n: 5 } };
  assert.equal(standing(bill, null, '2026-10-06').state, 'upcoming');
  let s = standing(bill, null, '2026-10-07');
  assert.equal(s.remindNow, true);
  let month = afterReminder(null, '2026-10-07');
  assert.equal(month.nextOn, '2026-10-09');
  assert.equal(standing(bill, month, '2026-10-07').remindNow, false, 'not twice on the same day');
  assert.equal(standing(bill, month, '2026-10-08').remindNow, false);
  month = afterReminder(month, '2026-10-09'); // Friday → next is Tuesday
  assert.equal(month.nextOn, '2026-10-13');
  assert.equal(standing(bill, { ...month, nextOn: '2026-10-10' }, '2026-10-10').remindNow, false, 'Saturday: no');
  month = afterReminder(month, '2026-10-13');
  s = standing(bill, month, '2026-10-15');
  assert.equal(s.remindNow, undefined);
  assert.equal(s.gaveUp, true);
  assert.equal(month.reminded.length, MAX_REMINDERS);
  assert.equal(addWorkdays('2026-10-09', 1), '2026-10-12');
});

/* ---------- adding bills ---------- */

test('an admin adds a bill; it defaults to reminding them', async () => {
  const { run } = setup();
  const reply = await addGcp(run);
  assert.equal(reply.title, 'Added: Google Cloud');
  assert.match(reply.text, /5th working day/);
  assert.match(reply.text, /robin@example\.com/);
  assert.equal((await addGcp(run)).title, 'Updated: Google Cloud', 'adding it again replaces it');
});

test('what an admin types is checked, with a sentence saying what to fix', () => {
  const by = { addedBy: 'robin@example.com' };
  assert.throws(() => parseBill('Google Cloud', by), /Use: `\/invoices add/);
  assert.throws(() => parseBill(`X | http://example.com | day 1`, by), /isn't an https link/);
  assert.throws(() => parseBill(`X | javascript:alert(1) | day 1`, by), /isn't an https link/);
  assert.throws(() => parseBill(`X | ${GCP} | whenever`, by), /don't understand "whenever"/);
  assert.throws(() => parseBill(`X | ${GCP} | day 1 | riley`, by), /this isn't one: riley/);
  const bill = parseBill(`Figma | https://www.figma.com/billing | day 1 | Riley@example.com, robin@example.com`, by);
  assert.equal(bill.id, 'figma');
  assert.deepEqual(bill.remind, ['riley@example.com', 'robin@example.com']);
});

test('only invoices admins add, remove or preview; everyone with access lists and marks done', async () => {
  const s = setup();
  await addGcp(s.run);
  const riley = s.ctxFor('riley@example.com', false);
  assert.match(await s.run(`add Figma | https://www.figma.com | day 1`, riley), /Only invoices admins/);
  assert.match(await s.run('remove Google Cloud', riley), /Only invoices admins/);
  const list = await s.run('', riley);
  assert.match(list.text, /Google Cloud/);
  assert.doesNotMatch(list.text, /Reminds:/, 'who is reminded is for admins');
});

/* ---------- the month ---------- */

test('the daily check reminds on the due day, with the link, the folder and the buttons', async () => {
  const s = setup();
  await addGcp(s.run);
  s.clock.now = at('2026-10-06');
  assert.deepEqual(await s.daily(), [], 'the day before: nothing');
  s.clock.now = at('2026-10-07');
  const [note] = await s.daily();
  assert.deepEqual(note.to, ['robin@example.com']);
  assert.equal(note.reply.title, '🧾 Google Cloud: this month\'s bill should be ready');
  assert.deepEqual(note.reply.buttons.map(b => b.text), ['Open Google Cloud', 'Invoices folder', '✓ Downloaded', 'Remind me tomorrow']);
  assert.equal(note.reply.buttons[0].url, GCP);
  assert.equal(note.reply.buttons[1].url, 'https://drive.google.com/drive/folders/1UaRlFoSIiRoanmiq_FDHnBMPqCycf6t9');
  assert.deepEqual(note.reply.buttons[2], { text: '✓ Downloaded', command: 'invoices', args: 'done google-cloud 2026-10', replace: true });
  assert.deepEqual(await s.daily(), [], 'the task running twice in a day sends nothing new');
});

test('"Downloaded" stops the reminders for everyone, and says who did it', async () => {
  const s = setup();
  await addGcp(s.run);
  s.clock.now = at('2026-10-07');
  await s.daily();
  const done = await s.run('done google-cloud 2026-10');
  assert.equal(done.title, '✅ Google Cloud: October done');
  s.clock.now = at('2026-10-09');
  assert.deepEqual(await s.daily(), [], 'no reminder after it is done');
  const again = await s.run('done google-cloud 2026-10', s.ctxFor('riley@example.com', false));
  assert.match(again.text, /robin already marked it downloaded on 7 Oct/);
  assert.match((await s.run('')).text, /✅ October: downloaded by robin on 7 Oct/);
  s.clock.now = at('2026-11-06'); // November's 5th working day
  assert.equal((await s.daily()).length, 1, 'next month starts over');
});

test('"Remind me tomorrow" moves it to the next working day without using up a reminder', async () => {
  const s = setup();
  await addGcp(s.run);
  s.clock.now = at('2026-10-09'); // Friday
  await s.daily();
  const later = await s.run('later google-cloud 2026-10');
  assert.match(later.title, /I'll remind you 12 Oct/);
  s.clock.now = at('2026-10-12');
  const [note] = await s.daily();
  assert.match(note.reply.text, /Reminder 2 of 3/);
});

test('a bill can be marked done early, typed by name, before any reminder', async () => {
  const s = setup();
  await addGcp(s.run);
  s.clock.now = at('2026-10-02');
  assert.equal((await s.run('done Google Cloud')).title, '✅ Google Cloud: October done');
  s.clock.now = at('2026-10-07');
  assert.deepEqual(await s.daily(), []);
});

test('unknown bills and removed bills', async () => {
  const s = setup();
  assert.match(await s.run('done nope'), /I don't know that bill/);
  await addGcp(s.run);
  assert.match(await s.run('remove Google Cloud'), /Removed \*\*Google Cloud\*\*/);
  s.clock.now = at('2026-10-07');
  assert.deepEqual(await s.daily(), [], 'a removed bill is never reminded about');
});

test('/invoices: each bill with its own buttons, and "+ Add a bill" for admins', async () => {
  const s = setup();
  const empty = await s.run('');
  assert.match(empty.text, /No bills yet. Press \*\*\+ Add a bill\*\*/);
  assert.deepEqual(empty.buttons, [{ text: '+ Add a bill', command: 'invoices', args: 'new' }]);
  await addGcp(s.run);
  await s.run(`add Figma | https://www.figma.com/billing | day 1`);
  s.clock.now = at('2026-10-07');
  await s.run('done figma 2026-10');
  const list = await s.run('');
  assert.equal(list.title, '🧾 Invoices — October');
  assert.match(list.text, /\*\*Figma\*\* · ready on the 1st of the month\n✅ October: downloaded by robin on 7 Oct/);
  assert.match(list.text, /\*\*Google Cloud\*\* · ready on the 5th working day\n⏳ October: due since 7 Oct, not downloaded yet/);
  assert.deepEqual(list.buttons.map(b => b.text), ['Open Figma', 'Open Google Cloud', '✓ Google Cloud downloaded', '+ Add a bill', 'Invoices folder']);
  assert.equal(list.buttons[0].url, 'https://www.figma.com/billing');

  const riley = await s.run('', s.ctxFor('riley@example.com', false));
  assert.ok(!riley.buttons.some(b => b.text === '+ Add a bill'), 'only admins get "+ Add a bill"');
});

test('"+ Add a bill" says what to tell Buddy; typing "invoices" alone shows the card for free', async () => {
  const s = setup();
  const start = await s.run('new');
  assert.equal(start.title, 'Add a bill');
  assert.match(start.text, /the \*\*link\*\* to the page where the bill is downloaded/);
  assert.match(await s.run('new', s.ctxFor('riley@example.com', false)), /Only invoices admins/);

  const dm = text => ({ text, argumentText: text, space: { kind: 'DM' } });
  const ctx = s.ctxFor();
  assert.match((await s.mod.handleMessage(ctx, dm('Invoices'))).title, /🧾 Invoices/);
  assert.ok(await s.mod.handleMessage(ctx, dm('bills?')));
  assert.equal(await s.mod.handleMessage(ctx, dm('what bills are due this week?')), null, 'a question goes to Claude');
  assert.equal(await s.mod.handleMessage(ctx, { ...dm('invoices'), space: { kind: 'SPACE' } }), null, 'DMs only');
});

test('preview shows an admin the reminder without counting it', async () => {
  const s = setup();
  await addGcp(s.run);
  s.clock.now = at('2026-10-07');
  const card = await s.run('preview Google Cloud');
  assert.match(card.title, /should be ready/);
  assert.equal((await s.daily()).length, 1, 'the real reminder still goes');
});

test('dates follow the people\'s time zone: 01:00 UTC on the 7th is still the 6th in Buenos Aires', async () => {
  const s = setup();
  await addGcp(s.run);
  s.clock.now = Date.parse('2026-10-07T01:00:00Z');
  assert.deepEqual(await s.daily(), []);
});
