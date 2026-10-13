const test = require('node:test');
const assert = require('node:assert/strict');
const { createLeaveCalendar } = require('../src/calendar');

const EVE = 'eve@example.com';
const BASE = '/calendar/v3/calendars/primary/events';

// A stand-in for the Calendar API. Records each request so the subject, method and URL the
// real client chose can be checked.
function google({ status = 200, body = {} } = {}) {
  const calls = [];
  const doFetch = async (url, init) => {
    calls.push({ url: new URL(url), method: init.method || 'GET', headers: init.headers, body: init.body });
    return { ok: status < 400, status, json: async () => body, text: async () => 'google said no' };
  };
  return { calls, doFetch };
}

function calendar(reply) {
  const fake = google(reply);
  const asked = [];
  const tokenFor = async (subject) => { asked.push(subject); return `tok-${subject}`; };
  return { cal: createLeaveCalendar({ tokenFor, fetch: fake.doFetch }), calls: fake.calls, asked };
}

test('every call fetches a token for the person it acts as, and nobody else', async () => {
  const { cal, calls, asked } = calendar({ body: { items: [] } });
  await cal.listOoo(EVE, { timeMin: 'a', timeMax: 'b' });
  assert.deepEqual(asked, [EVE]);
  assert.equal(calls[0].headers.Authorization, `Bearer tok-${EVE}`);
});

test('listing reads that person\'s own calendar and keeps only (OOO) events', async () => {
  const items = [{ summary: 'Eve (OOO)' }, { summary: 'Lunch' }, { summary: 'half day (ooo)' }, {}];
  const { cal, calls } = calendar({ body: { items } });
  const out = await cal.listOoo(EVE, { timeMin: '2026-09-01T00:00:00Z', timeMax: '2026-10-01T00:00:00Z' });
  assert.deepEqual(out.map(e => e.summary), ['Eve (OOO)', 'half day (ooo)']);
  assert.equal(calls[0].url.pathname, BASE);
  assert.equal(calls[0].url.searchParams.get('singleEvents'), 'true');
  assert.equal(calls[0].url.searchParams.get('timeMin'), '2026-09-01T00:00:00Z');
});

test('a reply with no items is an empty list', async () => {
  const { cal } = calendar({ body: {} });
  assert.deepEqual(await cal.listOoo(EVE, { timeMin: 'a', timeMax: 'b' }), []);
});

test('creating posts the event without emailing anybody', async () => {
  const event = { summary: 'Eve (OOO)', start: { date: '2026-09-24' }, end: { date: '2026-09-25' } };
  const { cal, calls } = calendar({ body: { id: 'ev1' } });
  assert.deepEqual(await cal.create(EVE, event), { id: 'ev1' });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url.pathname, BASE);
  assert.equal(calls[0].url.searchParams.get('sendUpdates'), 'none');
  assert.deepEqual(JSON.parse(calls[0].body), event);
  assert.equal(calls[0].headers['Content-Type'], 'application/json');
});

test('removing deletes that one event, also without emailing, and returns nothing', async () => {
  const { cal, calls } = calendar({ status: 204 });
  assert.equal(await cal.remove(EVE, 'ev/1 weird'), null);
  assert.equal(calls[0].method, 'DELETE');
  assert.equal(calls[0].url.pathname, `${BASE}/${encodeURIComponent('ev/1 weird')}`);
  assert.equal(calls[0].url.searchParams.get('sendUpdates'), 'none');
});

for (const status of [401, 403]) {
  test(`a ${status} names whose calendar it was and what to check`, async () => {
    const { cal } = calendar({ status });
    await assert.rejects(cal.create(EVE, {}), (error) => {
      assert.ok(error.message.includes(`${EVE}'s calendar`));
      assert.match(error.message, /domain-wide delegation/);
      assert.equal(error.expose, true);
      assert.equal(error.cause, 'google said no');
      return true;
    });
  });
}

test('removing an event that has already gone says so', async () => {
  const { cal } = calendar({ status: 404 });
  await assert.rejects(cal.remove(EVE, 'ev1'), /already gone/);
});

for (const status of [429, 500]) {
  test(`a ${status} is reported as Google being busy`, async () => {
    const { cal } = calendar({ status });
    await assert.rejects(cal.listOoo(EVE, { timeMin: 'a', timeMax: 'b' }), /busy right now/);
  });
}

test('any other refusal is reported as a refused change', async () => {
  const { cal } = calendar({ status: 400 });
  await assert.rejects(cal.create(EVE, {}), /refused that change/);
});
