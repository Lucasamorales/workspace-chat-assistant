const test = require('node:test');
const assert = require('node:assert/strict');
const { createRegistry, createAccessPolicy, parseRule, validateModule } = require('../src');

const quietLog = { info() {}, warn() {}, error() {}, child() { return quietLog; } };
const make = (modules, env = {}, access = null) => createRegistry({ modules, env, access, log: quietLog, timeouts: { hook: 50, tool: 50 } });
const ROBIN = { email: 'robin@example.com', id: 'users/111' };
const DM = { kind: 'DM', user: ROBIN };
const SPACE = { kind: 'SPACE', user: ROBIN };

test('contract rejects malformed modules', () => {
  assert.throws(() => validateModule({ name: 'Bad Name' }), /name must be/);
  assert.throws(() => validateModule({ name: 'x', surprise: 1 }), /unknown fields/);
  assert.throws(() => validateModule({ name: 'x', settings: ['OTHER_KEY'] }), /must start with X_/);
  assert.throws(() => validateModule({ name: 'x', oauth: { label: 'X' } }), /oauth\.authorizeUrl/);
});

test('startup fails on duplicate commands or missing settings', () => {
  const cmd = { description: 'd', run: async () => '' };
  assert.throws(() => make([{ name: 'a', commands: { go: cmd } }, { name: 'b', commands: { go: cmd } }]), /claimed by a and b/);
  assert.throws(() => make([{ name: 'a', settings: ['A_KEY'] }]), /Missing module settings: A_KEY/);
});

test('a crashing or hanging module does not break the others', async () => {
  const broken = { name: 'broken', tools: async () => { throw new Error('boom'); } };
  const hanging = { name: 'hanging', tools: () => new Promise(() => {}) };
  const good = {
    name: 'good',
    tools: async () => ({
      definitions: [{ name: 'ping', input_schema: { type: 'object' } }],
      execute: async () => ({ content: 'pong' }),
      needsApproval: () => false,
    }),
  };
  const ts = await make([broken, hanging, good]).buildToolset(() => ({}), DM);
  assert.deepEqual(ts.definitions.map(d => d.name), ['good__ping']);
  assert.equal(ts.notes.length, 2);
  assert.deepEqual(await ts.execute('good__ping', {}), { content: 'pong' });
});

test('approval is required unless a module explicitly says false', async () => {
  const defs = [{ name: 'a', input_schema: {} }];
  const mods = [
    { name: 'noflag', tools: async () => ({ definitions: defs, execute: async () => ({}) }) },
    { name: 'truthy', tools: async () => ({ definitions: defs, execute: async () => ({}), needsApproval: () => 'no' }) },
    { name: 'throws', tools: async () => ({ definitions: defs, execute: async () => ({}), needsApproval: () => { throw new Error('x'); } }) },
    { name: 'safe', tools: async () => ({ definitions: defs, execute: async () => ({}), needsApproval: () => false }) },
  ];
  const ts = await make(mods).buildToolset(() => ({}), DM);
  assert.equal(await ts.needsApproval('noflag__a'), true);
  assert.equal(await ts.needsApproval('truthy__a'), true);
  assert.equal(await ts.needsApproval('throws__a'), true);
  assert.equal(await ts.needsApproval('unknown__a'), true);
  assert.equal(await ts.needsApproval('safe__a'), false);
});

test('split and describe fall back safely when a module has none or throws', async () => {
  const defs = [{ name: 'a', input_schema: {} }];
  const mods = [
    { name: 'plain', tools: async () => ({ definitions: defs, execute: async () => ({}) }) },
    {
      name: 'broken',
      tools: async () => ({
        definitions: defs,
        execute: async () => ({}),
        split: () => { throw new Error('x'); },
        describe: async () => { throw new Error('x'); },
      }),
    },
  ];
  const ts = await make(mods).buildToolset(() => ({}), DM);
  for (const name of ['plain__a', 'broken__a']) {
    assert.deepEqual(await ts.split(name, { id: 1 }), [{ id: 1 }]);
    const d = await ts.describe(name, { due_on: '2026-09-17' }, { part: 0, of: 1 });
    assert.equal(d.effect, 'change');
    assert.deepEqual(d.fields, [{ label: 'Due on', value: '2026-09-17' }], 'every parameter is still shown');
  }
});

test('DM-only modules are invisible in spaces', async () => {
  const dmOnly = {
    name: 'asana',
    allowedIn: ['DM'],
    instructions: 'asana stuff',
    commands: { asana: { description: 'd', run: async () => 'ok' } },
    tools: async () => ({ definitions: [{ name: 't', input_schema: {} }], execute: async () => ({}) }),
  };
  const reg = make([dmOnly]);
  assert.equal((await reg.buildToolset(() => ({}), SPACE)).definitions.length, 0);
  assert.equal(reg.instructions(SPACE).length, 0);
  assert.equal(reg.listCommands(SPACE).length, 0);
  assert.equal(reg.findCommand('asana', SPACE).placeAllowed, false);
  assert.equal(reg.findCommand('asana', DM).placeAllowed, true);
});

/* ---------- access ---------- */

const REMY = { email: 'remy@example.com', id: 'users/222' };
const EVE = { email: 'eve@example.com', id: 'users/333' };
const OUTSIDER = { email: 'someone@gmail.com', id: 'users/999' };

test('access rules: emails, chat ids and domains; malformed or missing rules stop startup', () => {
  const rule = parseRule('robin@example.com, users/222, domain:example.org', 'R');
  assert.equal(rule(ROBIN), true);
  assert.equal(rule({ email: 'other@example.com', id: 'users/222' }), true);
  assert.equal(rule({ email: 'x@example.org' }), true);
  assert.equal(rule({ email: 'x@evil-example.org' }), false, 'domain match is exact, not a suffix');
  assert.equal(rule({ email: 'robin@example.com.evil.com' }), false);
  assert.equal(rule(null), false);
  assert.throws(() => parseRule('robin', 'R'), /invalid entries: robin/);
  assert.throws(() => parseRule('', 'R'), /R is empty/);

  const mods = [{ name: 'kudos', roles: ['admin'] }, { name: 'asana' }];
  assert.throws(() => createAccessPolicy({ modules: mods, env: {} }),
    /BUDDY_ACCESS_KUDOS is required[\s\S]*BUDDY_ROLE_KUDOS_ADMIN is required[\s\S]*BUDDY_ACCESS_ASANA is required/);
});

test('a module someone may not use is invisible to them: no tools, commands, help or handlers', async () => {
  const asana = {
    name: 'asana',
    commands: { asana: { description: 'd', run: async () => 'ok' } },
    examples: ['asana example'],
    tools: async () => ({ definitions: [{ name: 't', input_schema: {} }], execute: async () => ({}) }),
    handleMessage: async () => 'handled by asana',
  };
  const kudos = { name: 'kudos', handleMessage: async () => 'handled by kudos' };
  const access = createAccessPolicy({
    modules: [asana, kudos],
    env: { BUDDY_ACCESS_ASANA: 'robin@example.com,remy@example.com', BUDDY_ACCESS_KUDOS: 'domain:example.com' },
  });
  const reg = make([asana, kudos], {}, access);
  const as = user => ({ kind: 'DM', user });

  assert.equal((await reg.buildToolset(() => ({}), as(EVE))).definitions.length, 0);
  assert.equal(reg.findCommand('asana', as(EVE)), null, 'looks exactly like an unknown command');
  assert.equal(reg.listCommands(as(EVE)).length, 0);
  assert.deepEqual(reg.examples(as(EVE)), []);
  assert.deepEqual(await reg.handleMessage(() => ({}), {}, as(EVE)), { module: 'kudos', reply: 'handled by kudos' });

  assert.equal((await reg.buildToolset(() => ({}), as(REMY))).definitions.length, 1);
  assert.deepEqual(await reg.handleMessage(() => ({}), {}, as(REMY)), { module: 'asana', reply: 'handled by asana' });

  assert.equal((await reg.buildToolset(() => ({}), as(OUTSIDER))).definitions.length, 0);
  assert.equal(await reg.handleMessage(() => ({}), {}, as(OUTSIDER)), null);
  assert.equal((await reg.buildToolset(() => ({}), { kind: 'DM' })).definitions.length, 0, 'no user means no access');
});

test('role-restricted commands exist only for people with the role, and roles never exceed module access', () => {
  const kudos = {
    name: 'kudos',
    roles: ['admin'],
    commands: {
      kudos: { description: 'everyone', run: async () => 'mine' },
      'kudos-audit': { description: 'admins', role: 'admin', run: async () => 'audit' },
    },
  };
  const access = createAccessPolicy({
    modules: [kudos],
    env: { BUDDY_ACCESS_KUDOS: 'robin@example.com,eve@example.com', BUDDY_ROLE_KUDOS_ADMIN: 'robin@example.com,remy@example.com' },
  });
  const reg = make([kudos], {}, access);
  const as = user => ({ kind: 'SPACE', user });

  assert.deepEqual(reg.listCommands(as(ROBIN)).map(c => c.name), ['kudos', 'kudos-audit']);
  assert.deepEqual(reg.listCommands(as(EVE)).map(c => c.name), ['kudos']);
  assert.equal(reg.findCommand('kudos-audit', as(EVE)), null);
  assert.equal(access.hasRole('kudos', 'admin', REMY), false, 'admin role without module access grants nothing');
  assert.throws(() => validateModule({ name: 'x', commands: { y: { description: 'd', role: 'boss', run: () => '' } } }), /undeclared role "boss"/);
});

test('message handlers: first taker wins, nulls pass through, failures reply instead of falling through to Claude', async () => {
  const calls = [];
  const pass = { name: 'pass', handleMessage: async () => { calls.push('pass'); return null; } };
  const boom = { name: 'boom', handleMessage: async () => { calls.push('boom'); throw new Error('sheet down'); } };
  const later = { name: 'later', handleMessage: async () => { calls.push('later'); return 'never'; } };

  const r = await make([pass, boom, later]).handleMessage(() => ({}), { text: 'hi' }, DM);
  assert.deepEqual(calls, ['pass', 'boom']);
  assert.equal(r.module, 'boom');
  assert.match(r.reply, /something went wrong with Boom/);
  assert.equal(await make([pass]).handleMessage(() => ({}), { text: 'hi' }, DM), null);
});

test('conversation is a permission: Claude-only modules disappear for people who cannot chat', async () => {
  const assistant = { name: 'assistant', conversation: true, examples: ['Ask me anything'] };
  const asana = { name: 'asana', needsConversation: true, commands: { asana: { description: 'd', run: async () => 'ok' } }, examples: ['asana'] };
  const kudos = { name: 'kudos', examples: ['give kudos'], handleMessage: async () => null };
  const access = createAccessPolicy({
    modules: [assistant, asana, kudos],
    env: {
      BUDDY_ACCESS_ASSISTANT: 'robin@example.com',
      BUDDY_ACCESS_ASANA: 'domain:example.com',
      BUDDY_ACCESS_KUDOS: 'domain:example.com',
    },
  });
  const reg = make([assistant, asana, kudos], {}, access);
  const as = user => ({ kind: 'DM', user });

  assert.equal(reg.canConverse(as(ROBIN)), true);
  assert.deepEqual(reg.examples(as(ROBIN)), ['Ask me anything', 'asana', 'give kudos']);

  assert.equal(reg.canConverse(as(EVE)), false);
  assert.deepEqual(reg.examples(as(EVE)), ['give kudos'], 'asana is hidden even though Eve has asana access');
  assert.equal(reg.findCommand('asana', as(EVE)), null);

  assert.throws(() => validateModule({ name: 'x', conversation: true, needsConversation: true }), /cannot both provide and need/);
  assert.throws(() => validateModule({ name: 'x', conversation: 'yes' }), /conversation must be true/);
});
