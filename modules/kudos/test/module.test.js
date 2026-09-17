const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryStore, createLocalSealer, createContextFactory, createAccessPolicy, validateModule } = require('@buddy/core');
const { createKudosModule } = require('../src/module');
const { monthOfCell, zonedParts } = require('../src/sheet');

const quietLog = { info() {}, warn() {}, error() {}, child() { return quietLog; } };
const KUDOS_SPACE = { name: 'spaces/kudos', displayName: 'Team - Kudos', kind: 'SPACE' };
const ENV = {
  KUDOS_SHEET_ID: 'sheet123',
  KUDOS_SPACES: 'spaces/kudos',
  KUDOS_LEADERSHIP: 'charlie@example.com',
  BUDDY_ACCESS_KUDOS: 'domain:example.com',
  BUDDY_ROLE_KUDOS_ADMIN: 'robin@example.com',
};

/** In-memory stand-in for the Sheets API, recording every call. */
function fakeSheets(initialRows = []) {
  const rows = initialRows.map(r => [...r]);
  const calls = [];
  return {
    rows,
    calls,
    spreadsheets: {
      values: {
        get: async params => {
          calls.push(['get', params]);
          if (params.range.endsWith('A1:H1')) return { data: { values: [['Date', 'Voter', 'Value', 'Nominee', 'Space', 'Raw Text']] } };
          return { data: { values: rows } };
        },
        append: async params => { calls.push(['append', params]); rows.push(...params.requestBody.values); return { data: {} }; },
      },
      get: async () => ({ data: { properties: { title: 'Kudos TEST', timeZone: 'America/Argentina/Buenos_Aires' }, sheets: [{ properties: { title: 'Raw Data' } }] } }),
    },
  };
}

function setup({ rows = [], now = new Date('2026-09-17T15:00:00Z') } = {}) {
  const sheets = fakeSheets(rows);
  const mod = createKudosModule({ sheetsApi: sheets, now: () => now });
  const store = createMemoryStore();
  const access = createAccessPolicy({ modules: [mod], env: ENV });
  const make = createContextFactory({ store, sealer: createLocalSealer(), env: ENV, log: quietLog, access });
  const ctxFor = (user, extra = {}) => ({
    ...make(mod, { userId: user.id.split('/')[1], userEmail: user.email, userDisplayName: user.name, spaceKind: 'SPACE' }),
    ...extra,
  });
  return { mod, sheets, ctxFor };
}

const ROBIN = { id: 'users/111', email: 'robin@example.com', name: 'Robin' };
const EVE = { id: 'users/333', email: 'eve@example.com', name: 'Eve' };
const CHARLIE = { id: 'users/444', email: 'charlie@example.com', name: 'Charlie' };

function vote(from, text, space = KUDOS_SPACE) {
  const mentions = [];
  const re = /@(\w+)/g;
  let m;
  while ((m = re.exec(text))) {
    const person = { Eve: EVE, Robin: ROBIN, Charlie: CHARLIE }[m[1]];
    mentions.push({
      userId: person ? person.id : 'users/bot', displayName: m[1], type: person ? 'HUMAN' : 'BOT', startIndex: m.index, length: m[0].length,
    });
  }
  return { text, argumentText: text, mentions, space, sender: { userId: from.id, email: from.email, displayName: from.name } };
}

test('module satisfies the contract and declares the admin role', () => {
  const { mod } = setup();
  validateModule(mod);
  assert.deepEqual(mod.roles, ['admin']);
});

test('a valid vote appends one row per nominee with A–F as before plus Chat ids, in Argentina time', async () => {
  const { mod, sheets, ctxFor } = setup();
  const reply = await mod.handleMessage(ctxFor(ROBIN), vote(ROBIN, '@Buddy kudos to @Eve for thinking big'));
  assert.equal(reply, '✅ Got it! Logged 1 vote(s) from Robin:\n• Eve: "Think big"');

  const append = sheets.calls.find(c => c[0] === 'append')[1];
  assert.equal(append.spreadsheetId, 'sheet123');
  assert.equal(append.range, "'Raw Data'!A:H");
  assert.equal(append.valueInputOption, 'USER_ENTERED');
  assert.deepEqual(append.requestBody.values, [[
    '2026-09-17 12:00:00', 'Robin', 'Think big', 'Eve', 'Team - Kudos', '@Buddy kudos to @Eve for thinking big', 'users/111', 'users/333',
  ]]);
});

test('votes outside the Kudos space or in DMs are not logged', async () => {
  const { mod, sheets, ctxFor } = setup();
  const elsewhere = await mod.handleMessage(ctxFor(ROBIN), vote(ROBIN, '@Buddy kudos to @Eve for thinking big', { name: 'spaces/random', displayName: 'Random', kind: 'SPACE' }));
  assert.match(elsewhere, /only count in the official Kudos space/);
  const dm = await mod.handleMessage(ctxFor(ROBIN), vote(ROBIN, 'kudos to @Eve for thinking big', { name: 'spaces/dm', kind: 'DM' }));
  assert.match(dm, /Nice try! Kudos votes must be cast publicly/);
  assert.equal(sheets.calls.filter(c => c[0] === 'append').length, 0);
});

test('normal requests pass through to Claude; forgetting to tag someone gets a hint', async () => {
  const { mod, ctxFor } = setup();
  assert.equal(await mod.handleMessage(ctxFor(ROBIN), vote(ROBIN, '@Buddy summarise what @Eve said')), null);
  assert.match(await mod.handleMessage(ctxFor(ROBIN), vote(ROBIN, '@Buddy kudos for thinking big')), /didn't see any humans tagged/);
});

test('limits count this month only (Argentina time) and use the Sheet, including older name-only rows', async () => {
  // 17 Sep 2026: four votes this month (one old row without ids), one in August that must not count.
  const septSerial = (Date.UTC(2026, 8, 10) - Date.UTC(1899, 11, 30)) / 86_400_000;
  const augSerial = (Date.UTC(2026, 7, 31) - Date.UTC(1899, 11, 30)) / 86_400_000;
  const rows = [
    [septSerial, 'Robin', 'Own it', 'Eve', 'Team - Kudos', '', 'users/111', 'users/333'],
    [septSerial, 'Robin', 'Own it', 'Eve', 'Team - Kudos', '', 'users/111', 'users/333'],
    [septSerial, 'Robin', 'Own it', 'Eve', 'Team - Kudos', ''],
    [augSerial, 'Robin', 'Own it', 'Eve', 'Team - Kudos', '', 'users/111', 'users/333'],
  ];
  const { mod, sheets, ctxFor } = setup({ rows });
  const reply = await mod.handleMessage(ctxFor(ROBIN), vote(ROBIN, '@Buddy kudos to @Eve for owning it'));
  assert.match(reply, /already given 3 kudos this month to: Eve/);
  assert.equal(sheets.calls.filter(c => c[0] === 'append').length, 0);
});

test('leadership (by email) is exempt from the giving limits', async () => {
  const serial = (Date.UTC(2026, 8, 1) - Date.UTC(1899, 11, 30)) / 86_400_000;
  const rows = Array.from({ length: 6 }, () => [serial, 'Charlie', 'Own it', 'Eve', 'Team - Kudos', '', 'users/444', 'users/333']);
  const { mod, ctxFor } = setup({ rows });
  assert.match(await mod.handleMessage(ctxFor(CHARLIE), vote(CHARLIE, '@Buddy kudos to @Eve for owning it')), /Logged 1 vote/);
});

test('/kudos shows your own month; /kudos check and leadership are admin-only', async () => {
  const serial = (Date.UTC(2026, 8, 2) - Date.UTC(1899, 11, 30)) / 86_400_000;
  const rows = [
    [serial, 'Robin', 'Think big', 'Eve', 'Team - Kudos', '', 'users/111', 'users/333'],
    [serial, 'Charlie', 'Own it', 'Eve', 'Team - Kudos', '', 'users/444', 'users/333'],
  ];
  const { mod, ctxFor } = setup({ rows });
  const run = (user, args, message) => mod.commands.kudos.run({ ...ctxFor(user), message }, args);

  const mine = await run(EVE, '');
  assert.equal(mine.title, 'Your kudos this month');
  assert.match(mine.text, /Received: 2 \(Think big ×1, Own it ×1\)/);
  assert.match(mine.text, /Given: 0 of 5/);

  assert.equal(await run(EVE, 'check', vote(EVE, '/kudos check')), 'Only Kudos admins can do that.');
  assert.equal(await run(EVE, 'leadership', vote(EVE, '/kudos leadership @Charlie')), 'Only Kudos admins can do that.');

  const check = await run(ROBIN, 'check', vote(ROBIN, '/kudos check'));
  assert.match(check.text, /id spaces\/kudos[\s\S]*Votes count here[\s\S]*Sheet reachable: "Kudos TEST"/);

  const set = await run(ROBIN, 'leadership', vote(ROBIN, '/kudos leadership @Charlie'));
  assert.match(set.text, /• Charlie/);
  const shown = await run(ROBIN, 'leadership', vote(ROBIN, '/kudos leadership'));
  assert.match(shown.text, /• Charlie/, 'stored list is kept');
});

test('sheet dates: serial numbers, text dates and Argentina wall-clock stamps', () => {
  assert.deepEqual(monthOfCell((Date.UTC(2026, 6, 31) - Date.UTC(1899, 11, 30)) / 86_400_000 + 0.99), { year: 2026, month: 7 });
  assert.deepEqual(monthOfCell('2026-08-01 00:10:00'), { year: 2026, month: 8 });
  // 1 Oct 01:30 UTC is still 30 Sep in Buenos Aires: the vote belongs to September.
  assert.deepEqual(zonedParts(new Date('2026-10-01T01:30:00Z'), 'America/Argentina/Buenos_Aires'), { year: 2026, month: 9, stamp: '2026-09-30 22:30:00' });
});

test('Sheet access problems give a specific, actionable reply instead of a generic error', async () => {
  const cases = [
    { status: 403, op: 'append', expect: /can read the Kudos Sheet but isn't allowed to add rows\. Share the Sheet as Editor/ },
    { status: 403, op: 'get', expect: /isn't allowed to open the Kudos Sheet/ },
    { status: 404, op: 'get', expect: /Kudos Sheet wasn't found/ },
    { status: 503, op: 'append', expect: /Google Sheets is busy/ },
  ];
  for (const c of cases) {
    const { mod, sheets, ctxFor } = setup();
    const original = sheets.spreadsheets.values[c.op];
    sheets.spreadsheets.values[c.op] = async params => {
      if (c.op === 'get' && params.range.endsWith('A1:H1')) return original(params);
      throw Object.assign(new Error('Google says no'), { status: c.status });
    };
    await assert.rejects(
      mod.handleMessage(ctxFor(ROBIN), vote(ROBIN, '@Buddy id like to give a kudos to @Eve for going above and beyond')),
      e => e.expose === true && c.expect.test(e.message),
      `${c.op} ${c.status}`,
    );
  }
});
