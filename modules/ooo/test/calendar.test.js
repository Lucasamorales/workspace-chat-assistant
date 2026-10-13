const test = require('node:test');
const assert = require('node:assert/strict');
const { createOooCalendar, explain, SA_EMAIL } = require('../src/calendar');

const CALENDAR = 'accounts@example.com';
const WINDOW = { timeMin: '2026-09-21T00:00:00Z', timeMax: '2026-09-28T00:00:00Z' };

// A stand-in for the Calendar API that records each request, so the tests can assert the
// module only ever reads.
function google({ status = 200, body = {} } = {}) {
  const calls = [];
  const doFetch = async (url, init) => {
    calls.push({ url: new URL(url), method: init.method, headers: init.headers });
    return { ok: status < 400, status, json: async () => body };
  };
  return { calls, doFetch };
}

function calendar(reply, options = {}) {
  const fake = google(reply);
  const asked = [];
  const tokenFor = async (subject) => { asked.push(subject); return 'tok'; };
  const cal = createOooCalendar({ tokenFor, calendarId: CALENDAR, fetch: fake.doFetch, ...options });
  return { cal, calls: fake.calls, asked };
}

test('listing asks for expanded OOO events in the window, with a GET', async () => {
  const { cal, calls } = calendar({ body: { items: [] } });
  await cal.list(WINDOW);
  const { url, method, headers } = calls[0];
  assert.equal(method, 'GET');
  assert.equal(headers.Authorization, 'Bearer tok');
  assert.equal(url.pathname, `/calendar/v3/calendars/${encodeURIComponent(CALENDAR)}/events`);
  assert.equal(url.searchParams.get('timeMin'), WINDOW.timeMin);
  assert.equal(url.searchParams.get('timeMax'), WINDOW.timeMax);
  assert.equal(url.searchParams.get('singleEvents'), 'true');
  assert.equal(url.searchParams.get('orderBy'), 'startTime');
  assert.equal(url.searchParams.get('q'), 'OOO');
});

test('only events with OOO as a word are returned, however it is written', async () => {
  const items = [
    { summary: 'Eve OOO' }, { summary: 'Remy (ooo)' }, { summary: 'OOO - Toni' },
    { summary: 'Zoo trip' }, { summary: 'Kazooo band practice' }, {},
  ];
  const { cal } = calendar({ body: { items } });
  const out = await cal.list(WINDOW);
  assert.deepEqual(out.map(e => e.summary), ['Eve OOO', 'Remy (ooo)', 'OOO - Toni']);
});

test('a reply with no items is an empty list', async () => {
  const { cal } = calendar({ body: {} });
  assert.deepEqual(await cal.list(WINDOW), []);
});

test('a missing date range is refused before any request is made', async () => {
  const { cal, calls } = calendar();
  await assert.rejects(cal.list({ timeMin: WINDOW.timeMin }), /date range/);
  assert.equal(calls.length, 0);
});

test('describe reads the calendar itself and reports its title and time zone', async () => {
  const { cal, calls } = calendar({ body: { summary: 'Team OOO', timeZone: 'Europe/London' } });
  assert.deepEqual(await cal.describe(), { title: 'Team OOO', timeZone: 'Europe/London' });
  assert.equal(calls[0].url.pathname, `/calendar/v3/calendars/${encodeURIComponent(CALENDAR)}`);
  assert.equal(calls[0].url.search, '');
});

test('a calendar with no title is described by its id', async () => {
  const { cal } = calendar({ body: {} });
  assert.equal((await cal.describe()).title, CALENDAR);
});

test('acting as the account that owns the calendar reads "primary" and asks for that account\'s token', async () => {
  const { cal, calls, asked } = calendar({ body: { items: [] } }, { readAs: CALENDAR });
  await cal.list(WINDOW);
  assert.equal(calls[0].url.pathname, '/calendar/v3/calendars/primary/events');
  assert.deepEqual(asked, [CALENDAR]);
});

test('acting as a different account still reads the configured calendar by address', async () => {
  const { cal, calls } = calendar({ body: { items: [] } }, { readAs: 'robin@example.com' });
  await cal.list(WINDOW);
  assert.equal(calls[0].url.pathname, `/calendar/v3/calendars/${encodeURIComponent(CALENDAR)}/events`);
});

test('the client exposes nothing that could write', () => {
  const { cal } = calendar();
  assert.deepEqual(Object.keys(cal).sort(), ['calendarId', 'describe', 'list', 'readAs']);
  assert.ok(Object.isFrozen(cal));
});

test('a calendar id is required', () => {
  assert.throws(() => createOooCalendar({ tokenFor: async () => 't' }), /calendarId is required/);
});

test('no access names the service account and the calendar, and keeps Google\'s own wording', async () => {
  const { cal } = calendar({ status: 403, body: { error: { message: 'Insufficient Permission' } } });
  await assert.rejects(cal.list(WINDOW), (error) => {
    assert.ok(error.message.includes(SA_EMAIL));
    assert.ok(error.message.includes(CALENDAR));
    assert.equal(error.detail, 'Insufficient Permission');
    assert.equal(error.expose, true);
    return true;
  });
});

test('no access while acting as an account names that account instead', async () => {
  const { cal } = calendar({ status: 401, body: {} }, { readAs: 'robin@example.com' });
  await assert.rejects(cal.describe(), /while acting as robin@example\.com/);
});

test('a missing calendar points at the setting to check', async () => {
  const { cal } = calendar({ status: 404, body: { error: { status: 'NOT_FOUND' } } });
  await assert.rejects(cal.describe(), (error) => {
    assert.match(error.message, /OOO_CALENDAR_ID/);
    assert.equal(error.detail, 'NOT_FOUND');
    return true;
  });
});

for (const status of [429, 503]) {
  test(`a ${status} is reported as Google being busy`, async () => {
    const { cal } = calendar({ status, body: {} });
    await assert.rejects(cal.list(WINDOW), /a bit busy right now/);
  });
}

test('an error body that is not JSON still produces a readable error', async () => {
  const doFetch = async () => ({ ok: false, status: 403, json: async () => { throw new SyntaxError('not json'); } });
  const cal = createOooCalendar({ tokenFor: async () => 't', calendarId: CALENDAR, fetch: doFetch });
  await assert.rejects(cal.describe(), /can't read the team calendar/);
});

test('an error with no recognised status is passed through untouched', () => {
  const original = Object.assign(new Error('socket hang up'), { status: 418 });
  assert.equal(explain(original, CALENDAR), original);
});

test('explain reads the status from wherever a Google client put it', () => {
  assert.match(explain({ code: 404 }, CALENDAR).message, /couldn't find the calendar/);
  assert.match(explain({ response: { status: 500 } }, CALENDAR).message, /busy/);
});
