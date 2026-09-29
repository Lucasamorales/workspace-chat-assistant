// What Claude can do when someone asks in words, and what the approval card shows first.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryStore } = require('@buddy/core');
const { createInvoicesModule } = require('../src/module');

const ADOBE = 'https://account.adobe.com/billing';
const at = date => Date.parse(`${date}T12:00:00Z`);

function setup() {
  const clock = { now: at('2026-09-29') };
  const store = createMemoryStore();
  const mod = createInvoicesModule({ now: () => clock.now });
  const ctxFor = (email = 'marta@example.com', admin = true) => ({
    userEmail: email,
    settings: { INVOICES_TIMEZONE: 'America/Argentina/Buenos_Aires' },
    store: { collection: name => store.collection(`m_invoices__${name}`) },
    hasRole: role => role === 'admin' && admin,
    log: { info() {}, warn() {}, error() {} },
  });
  return { mod, clock, ctxFor, tools: ctx => mod.tools(ctx), daily: () => mod.onSchedule(ctxFor('', false), 'daily') };
}

test('admins get all four tools; everyone else can only list and mark downloaded', async () => {
  const s = setup();
  assert.deepEqual((await s.tools(s.ctxFor())).definitions.map(d => d.name), ['list_bills', 'save_bill', 'remove_bill', 'mark_downloaded']);
  assert.deepEqual((await s.tools(s.ctxFor('riley@example.com', false))).definitions.map(d => d.name), ['list_bills', 'mark_downloaded']);
});

test('"Add Adobe, ready on the 1st": an approval card showing the next date, then saved', async () => {
  const s = setup();
  const t = await s.tools(s.ctxFor());
  const input = { name: 'Adobe', url: ADOBE, when_kind: 'day_of_month', when_n: 1 };
  assert.equal(await t.needsApproval('save_bill', input), true);
  const card = await t.describe('save_bill', input);
  assert.equal(card.title, 'Add a bill: Adobe');
  assert.equal(card.effect, 'create');
  assert.deepEqual(card.fields, [
    { label: 'Link', value: ADOBE },
    { label: 'Ready', value: '1st of the month · next: 1 Oct' },
    { label: 'Reminds', value: 'marta@example.com' },
  ]);
  assert.match((await t.execute('save_bill', input)).content, /Added Adobe/);
  assert.match((await t.execute('list_bills', {})).content, /Adobe \| https:\/\/account\.adobe\.com\/billing \| ready on the 1st of the month · next: 1 Oct/);
});

test('a change shows only what moves, "was" beside it', async () => {
  const s = setup();
  const t = await s.tools(s.ctxFor());
  await t.execute('save_bill', { name: 'Adobe', url: ADOBE, when_kind: 'day_of_month', when_n: 1 });
  const card = await t.describe('save_bill', { name: 'adobe', when_kind: 'working_day', when_n: 3 });
  assert.equal(card.title, 'Change a bill: Adobe');
  assert.equal(card.effect, 'update');
  assert.equal(card.fields[0].value, ADOBE, 'the link isn\'t changing, so no "was"');
  assert.equal(card.fields[1].value, '3rd working day · next: 5 Oct (was 1st of the month · next: 1 Oct)');
});

test('a request that can\'t be saved fails at once with what\'s missing, not with an approval card', async () => {
  const s = setup();
  const t = await s.tools(s.ctxFor());
  const noLink = { name: 'Adobe', when_kind: 'day_of_month', when_n: 1 };
  assert.equal(await t.needsApproval('save_bill', noLink), false, 'nothing can change, so nobody is asked');
  await assert.rejects(t.execute('save_bill', noLink), /isn't an https link/);
  await assert.rejects(t.execute('save_bill', { name: 'Adobe', url: ADOBE }), /When is it ready/);
  await assert.rejects(t.execute('save_bill', { name: 'Adobe', url: ADOBE, when_kind: 'day_of_month', when_n: 40 }), /When is it ready/);
  await assert.rejects(t.execute('mark_downloaded', { bill: 'Nope' }), /There's no bill called "Nope"/);
});

test('an admin tool is refused when it runs for someone who isn\'t an admin, even if called', async () => {
  const s = setup();
  const t = await s.tools(s.ctxFor('riley@example.com', false));
  await assert.rejects(t.execute('save_bill', { name: 'Adobe', url: ADOBE, when_kind: 'day_of_month', when_n: 1 }), /Only invoices admins/);
});

test('"I\'ve downloaded Google Cloud" stops its reminders; "stop reminding me about Adobe" removes it', async () => {
  const s = setup();
  const t = await s.tools(s.ctxFor());
  await t.execute('save_bill', { name: 'Google Cloud', url: 'https://console.cloud.google.com/billing', when_kind: 'working_day', when_n: 5 });
  await t.execute('save_bill', { name: 'Adobe', url: ADOBE, when_kind: 'day_of_month', when_n: 1 });
  s.clock.now = at('2026-10-07');
  const t2 = await s.tools(s.ctxFor());
  assert.equal((await t2.describe('mark_downloaded', { bill: 'Google Cloud' })).title, 'Mark downloaded: Google Cloud');
  await t2.execute('mark_downloaded', { bill: 'google cloud' });
  const removeCard = await t2.describe('remove_bill', { bill: 'Adobe' });
  assert.equal(removeCard.title, 'Stop reminders: Adobe');
  await t2.execute('remove_bill', { bill: 'Adobe' });
  assert.deepEqual(await s.daily(), [], 'Google Cloud done, Adobe gone: nobody is reminded');
});
