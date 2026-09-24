const test = require('node:test');
const assert = require('node:assert/strict');
const { validateModule } = require('@buddy/core');
const { createOooModule, whenFrom } = require('../src/module');
const { createOooCalendar } = require('../src/calendar');
const { createReadTokens, readAs, READONLY_SCOPE } = require('../src/token');
const { rangeFor, instantsFor } = require('../src/range');

const TZ = 'America/Argentina/Buenos_Aires';
// A Wednesday, 10:00 in Buenos Aires.
const NOW = new Date('2026-09-23T13:00:00Z');

const allDay = (summary, start, end) => ({ summary, start: { date: start }, end: { date: end } });
const timed = (summary, start, end) => ({ summary, start: { dateTime: start }, end: { dateTime: end } });

function setup(items = [], settings = {}) {
  const calls = [];
  const calendar = {
    calendarId: 'accounts@example.com',
    readAs: 'accounts@example.com',
    async list(window) { calls.push(window); return items; },
    async describe() { return { title: 'Accounts', timeZone: TZ }; },
  };
  const mod = createOooModule({ calendar, now: () => NOW });
  const ctx = {
    settings: { OOO_CALENDAR_ID: 'accounts@example.com', OOO_READ_AS: 'accounts@example.com', ...settings },
    log: { info() {}, warn() {}, error() {} },
  };
  return { mod, ctx, calls };
}

/** A reader built the real way, over a fake network. */
function wired(responses, settings = {}) {
  const requests = [];
  const fetch = async (url, options = {}) => {
    requests.push({ url, method: options.method, body: options.body });
    const next = responses.shift();
    if (!next) throw new Error('unexpected request: ' + url);
    return next;
  };
  const auth = {
    getCredentials: async () => ({ client_email: 'buddy-bot@your-gcp-project.iam.gserviceaccount.com' }),
    getClient: async () => ({ getAccessToken: async () => ({ token: 'own-identity' }) }),
  };
  const log = { info() {}, warn(msg, data) { requests.push({ warn: msg, data }); }, error() {} };
  const tokenFor = createReadTokens({ auth, fetch, log });
  const calendar = createOooCalendar({
    tokenFor,
    calendarId: settings.calendarId || 'accounts@example.com',
    readAs: readAs(settings.readAs === undefined ? 'accounts@example.com' : settings.readAs),
    fetch,
  });
  return { calendar, requests };
}

const ok = body => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const bad = (status, body) => ({ ok: false, status, json: async () => body, text: async () => JSON.stringify(body) });

test('module satisfies the contract', () => validateModule(createOooModule({ calendar: {} })));

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
  assert.match(reply.text, /\*\*Robin\*\*: Sep 22 to Sep 25/);
});

test('a single all-day absence is one date, and half-days keep their hours', async () => {
  const { mod, ctx } = setup([
    allDay('Remy (OOO)', '2026-09-23', '2026-09-24'),
    timed('Riley (OOO)', '2026-09-23T08:00:00-03:00', '2026-09-23T12:30:00-03:00'),
  ]);
  const reply = await mod.commands.ooo.run(ctx, 'today');
  assert.match(reply.text, /\*\*Remy\*\*: Sep 23\n/);
  assert.match(reply.text, /\*\*Riley\*\*: Sep 23 \(08:00 - 12:30 ARG\)/);
});

test('the personal block and the team invite are one absence, listed once', async () => {
  const { mod, ctx } = setup([
    allDay('Robin (OOO)', '2026-09-23', '2026-09-24'),
    allDay('Robin (OOO)', '2026-09-23', '2026-09-24'),
  ]);
  const reply = await mod.commands.ooo.run(ctx, 'today');
  assert.equal(reply.text.split('\n').length, 1);
});

test('events without the OOO tag are ignored, in any of the ways people write it', async () => {
  const { calendar } = wired([
    ok({ signedJwt: 's' }),
    ok({ access_token: 'reading' }),
    ok({
      items: [
        allDay('All-hands', '2026-09-23', '2026-09-24'),
        allDay('Charlie (OOO)', '2026-09-23', '2026-09-24'),
        allDay('Ian OOO', '2026-09-23', '2026-09-24'),      // how the real calendar writes it
        allDay('OOO - Lenny', '2026-09-23', '2026-09-24'),
        allDay('Woooo party', '2026-09-23', '2026-09-24'),  // must not match
      ],
    }),
  ]);
  const events = await calendar.list({ timeMin: '2026-09-23T00:00:00-03:00', timeMax: '2026-09-23T23:59:59-03:00' });
  assert.deepEqual(events.map(e => e.summary), ['Charlie (OOO)', 'Ian OOO', 'OOO - Lenny']);
});

test('the tag is stripped however it was written, leaving just the person', async () => {
  const { mod, ctx } = setup([
    allDay('Ian OOO', '2026-09-14', '2026-09-26'),
    allDay('Ella (OOO)', '2026-09-17', '2026-09-26'),
    allDay('OOO - Lenny', '2026-09-21', '2026-09-26'),
  ]);
  const reply = await mod.commands.ooo.run(ctx, 'today');
  assert.equal(reply.text, [
    '• **Ian**: Sep 14 to Sep 25',
    '• **Ella**: Sep 17 to Sep 25',
    '• **Lenny**: Sep 21 to Sep 25',
  ].join('\n'));
});

test('multi-day leave counts on every day it covers, not just the day it starts', async () => {
  // The live calendar's answer for "today" on the 23rd includes leave that began on the 14th.
  const { mod, ctx, calls } = setup([allDay('Ian OOO', '2026-09-14', '2026-09-26')]);
  const reply = await mod.commands.ooo.run(ctx, 'today');
  assert.match(reply.text, /\*\*Ian\*\*/);
  assert.equal(calls.at(-1).timeMin, '2026-09-23T00:00:00-03:00', 'asks Google for the day, and overlaps come back');
});

/* ---------- guardrails: this module may only ever read ---------- */

test('the reader has no way to write: no create, delete or patch exists on it', () => {
  const { calendar } = wired([]);
  assert.deepEqual(Object.keys(calendar).sort(), ['calendarId', 'describe', 'list', 'readAs']);
  for (const forbidden of ['create', 'insert', 'remove', 'delete', 'patch', 'update']) {
    assert.equal(calendar[forbidden], undefined, `${forbidden} must not exist`);
  }
  assert.ok(Object.isFrozen(calendar), 'nothing can bolt a write method onto it later');
});

test('every request is a GET, to the one configured calendar', async () => {
  const { calendar, requests } = wired([ok({ signedJwt: 's' }), ok({ access_token: 'reading' }), ok({ items: [] })]);
  await calendar.list({ timeMin: '2026-09-23T00:00:00-03:00', timeMax: '2026-09-23T23:59:59-03:00' });

  const calendarCalls = requests.filter(r => String(r.url).includes('/calendar/v3/'));
  assert.equal(calendarCalls.length, 1);
  assert.equal(calendarCalls[0].method, 'GET');
  assert.equal(calendarCalls[0].body, undefined, 'a read never carries a body');
  // Acting as the calendar's own account, so its own calendar is "primary".
  assert.match(calendarCalls[0].url, /\/calendars\/primary\/events\?/);
});

test('the read-only scope is asked for first, and the writable one only if forced', async () => {
  const { calendar, requests } = wired([ok({ signedJwt: 's' }), ok({ access_token: 'reading' }), ok({ items: [] })]);
  await calendar.list({ timeMin: 'a', timeMax: 'b' });
  const claims = JSON.parse(JSON.parse(requests[0].body).payload);
  assert.equal(claims.scope, READONLY_SCOPE);
  assert.equal(claims.sub, 'accounts@example.com');

  // Delegation without the readonly scope: it falls back, but says so loudly.
  const second = wired([
    ok({ signedJwt: 's1' }), bad(400, { error: 'unauthorized_client' }),
    ok({ signedJwt: 's2' }), ok({ access_token: 'reading' }), ok({ items: [] }),
  ]);
  await second.calendar.list({ timeMin: 'a', timeMax: 'b' });
  const warned = second.requests.find(r => r.warn);
  assert.match(warned.warn, /writable scope/);
  assert.match(warned.data.fix, /calendar\.events\.readonly/);
});

test('the account acted as comes from settings alone, never from a caller', () => {
  // Anything that is not a single, well-formed address is refused outright.
  for (const attempt of ['robin@x.com,remy@x.com', 'not-an-email', 'me@x.com me@y.com', '*@example.com']) {
    assert.throws(() => readAs(attempt), /single work email address/);
  }
  assert.equal(readAs(''), null, 'unset means no impersonation at all');
  assert.equal(readAs(' Accounts@Example.com '), 'accounts@example.com');

  // The module reads it from settings; the tool takes only a period, so there is no field to abuse.
  const { mod, ctx } = setup([]);
  const schema = mod.tools(ctx);
  return schema.then(toolset => {
    assert.deepEqual(Object.keys(toolset.definitions[0].input_schema.properties), ['when']);
  });
});

test('a range is required: no window, no request', async () => {
  const { calendar } = wired([]);
  await assert.rejects(calendar.list({}), /date range/);
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
    calendar: { calendarId: 'accounts@example.com', list: async () => { throw Object.assign(new Error('nope'), { expose: true, message: "Oh no, I can't read the team calendar: buddy-bot@your-gcp-project.iam.gserviceaccount.com doesn't have access to accounts@example.com." }); } },
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
  assert.match(reply.text, /✅ I can read the calendar: 1 OOO entry this week/);
  assert.match(reply.text, /✅ Calendar: "Accounts"/);

  const broken = createOooModule({
    calendar: {
      calendarId: 'accounts@example.com',
      list: async () => { throw Object.assign(new Error("Oh no, I couldn't find the calendar accounts@example.com. Check OOO_CALENDAR_ID."), { expose: true, detail: 'Not Found' }); },
    },
    now: () => NOW,
  });
  const failed = await broken.commands.ooo.run(ctx, 'check');
  assert.match(failed.text, /❌ .*couldn't find the calendar/);
  assert.match(failed.text, /Google said: Not Found/, 'the real reason is shown, not guessed at');
});

test('the check passes on events alone: calendar details need a wider scope than we ask for', async () => {
  // This is the bug that made /ooo check fail while the module itself was fine: calendars.get
  // needs calendar.readonly, but the delegation grants calendar.events.
  const { mod, ctx } = setup([allDay('Robin (OOO)', '2026-09-23', '2026-09-24')]);
  const noMetadata = createOooModule({
    calendar: {
      calendarId: 'accounts@example.com',
      readAs: 'accounts@example.com',
      list: async () => [allDay('Robin (OOO)', '2026-09-23', '2026-09-24')],
      describe: async () => { throw Object.assign(new Error('insufficient scopes'), { status: 403 }); },
    },
    now: () => NOW,
  });
  const reply = await noMetadata.commands.ooo.run(ctx, 'check');
  assert.match(reply.text, /✅ I can read the calendar/);
  assert.ok(!reply.text.includes('❌'), 'metadata we do not need must never fail the check');
  assert.equal(mod.name, 'ooo');
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

/* ---------- answering without Claude: the most-asked question at company scale ---------- */

const asked = text => ({ argumentText: text, text });

test('"who\'s out" is answered directly, in the words people actually use', async () => {
  const { mod, ctx } = setup([allDay('Ian OOO', '2026-09-23', '2026-09-24')]);

  for (const question of [
    'who is out today?',
    "who's off today",
    'Who is OOO?',
    'anyone out today?',
    'who is on holiday today',
    '¿quién está de vacaciones?',
    'quienes estan de licencia hoy',
  ]) {
    const reply = await mod.handleMessage(ctx, asked(question));
    assert.ok(reply, `should have answered: ${question}`);
    assert.match(reply.text, /<b>Ian<\/b>|\*\*Ian\*\*/, question);
  }
});

test('the period still comes from the question', async () => {
  const { mod, ctx, calls } = setup([]);
  await mod.handleMessage(ctx, asked("who's off next week?"));
  assert.equal(calls.at(-1).timeMin, '2026-09-28T00:00:00-03:00');
});

test('a question about the leave *policy* is left for the manual', async () => {
  const { mod, ctx } = setup([allDay('Ian OOO', '2026-09-23', '2026-09-24')]);
  for (const question of [
    'what is the policy for being out of office?',
    'how do I request time off?',
    'cómo pido vacaciones',
    'where do I book leave',
  ]) {
    assert.equal(await mod.handleMessage(ctx, asked(question)), null, question);
  }
});

test('anything else passes through to Claude untouched', async () => {
  const { mod, ctx } = setup([]);
  for (const question of ['write me a poem', 'what are my asana tasks', 'hello', '']) {
    assert.equal(await mod.handleMessage(ctx, asked(question)), null, question);
  }
});

test('a calendar failure falls through to Claude rather than failing the message', async () => {
  const broken = createOooModule({
    calendar: { calendarId: 'accounts@example.com', list: async () => { throw new Error('calendar down'); } },
    now: () => NOW,
  });
  const { ctx } = setup([]);
  assert.equal(await broken.handleMessage(ctx, asked('who is out today?')), null);
});
