const test = require('node:test');
const assert = require('node:assert/strict');
const { createRegistry, validateModule } = require('../src');

const quietLog = { info() {}, warn() {}, error() {}, child() { return quietLog; } };
const make = (modules, env = {}) => createRegistry({ modules, env, log: quietLog, timeouts: { hook: 50, tool: 50 } });

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
  const ts = await make([broken, hanging, good]).buildToolset(() => ({}), 'DM');
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
  const ts = await make(mods).buildToolset(() => ({}), 'DM');
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
  const ts = await make(mods).buildToolset(() => ({}), 'DM');
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
  assert.equal((await reg.buildToolset(() => ({}), 'SPACE')).definitions.length, 0);
  assert.equal(reg.instructions('SPACE').length, 0);
  assert.equal(reg.listCommands('SPACE').length, 0);
  assert.equal(reg.findCommand('asana').allowedIn('SPACE'), false);
  assert.equal(reg.findCommand('asana').allowedIn('DM'), true);
});
