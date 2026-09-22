const test = require('node:test');
const assert = require('node:assert/strict');
const { validateModule, createMemoryStore, createGrants, createAccessPolicy } = require('@buddy/core');
const { createAdminModule, PROTECTED } = require('../src/module');

const ROBIN = 'robin@example.com';
const RILEY = 'riley@example.com';
const MODULES = ['basics', 'files', 'asana', 'kudos', 'assistant', 'ooo', 'leave', 'admin'];

function setup({ now = () => Date.parse('2026-09-22T12:00:00Z') } = {}) {
  const store = createMemoryStore();
  const grants = createGrants({ store, now, ttlMs: 0 });
  const mod = createAdminModule({ grants, moduleNames: MODULES });
  const logged = [];
  const ctx = {
    userEmail: ROBIN,
    settings: {},
    log: { info: (msg, data) => logged.push({ msg, data }), warn() {}, error() {} },
  };
  return { mod, ctx, grants, logged, store };
}

const grant = async (mod, ctx, input) => (await mod.tools(ctx)).execute('grant_access', input);
const revoke = async (mod, ctx, input) => (await mod.tools(ctx)).execute('revoke_access', input);

test('module satisfies the contract', () => validateModule(createAdminModule({ grants: {}, moduleNames: MODULES })));

test('granting lets someone use a module, and reach Buddy at all', async () => {
  const { mod, ctx, grants } = setup();
  const { content } = await grant(mod, ctx, { module: 'asana', person: RILEY });

  assert.match(content, /riley@example\.com can now use asana/);
  assert.equal(grants.granted('asana', { email: RILEY }), true);
  assert.equal(grants.mayTalk({ email: RILEY }), true, 'otherwise the grant is invisible to her');
  assert.equal(grants.granted('kudos', { email: RILEY }), false, 'one module only');
});

test('protected modules can never be granted from chat', async () => {
  const { mod, ctx, grants } = setup();
  assert.deepEqual(PROTECTED, ['admin', 'leave', 'assistant']);

  for (const name of PROTECTED) {
    await assert.rejects(grant(mod, ctx, { module: name, person: RILEY }), err => {
      assert.equal(err.expose, true);
      assert.match(err.message, /stays in the config file/);
      return true;
    });
    assert.equal(grants.granted(name, { email: RILEY }), false);
  }
});

test('the protected list is fixed in the source, not something a setting can empty', async () => {
  const { mod, grants } = setup();
  const ctx = { userEmail: ROBIN, settings: { ADMIN_PROTECTED: '', ADMIN_PROTECTED_MODULES: 'none' }, log: { info() {}, warn() {} } };
  await assert.rejects(grant(mod, ctx, { module: 'leave', person: RILEY }), /stays in the config file/);
  assert.equal(grants.granted('leave', { email: RILEY }), false);
  assert.ok(Object.isFrozen(PROTECTED));
});

test('only company addresses, and only modules that exist', async () => {
  const { mod, ctx } = setup();
  await assert.rejects(grant(mod, ctx, { module: 'asana', person: 'someone@gmail.com' }), /example\.com addresses/);
  await assert.rejects(grant(mod, ctx, { module: 'asana', person: 'riley' }), /full work email/);
  await assert.rejects(grant(mod, ctx, { module: 'nonsense', person: RILEY }), /no module called/);
});

test('an expiry is honoured without anyone acting', async () => {
  let clock = Date.parse('2026-09-22T12:00:00Z');
  const store = createMemoryStore();
  const grants = createGrants({ store, now: () => clock, ttlMs: 0 });
  const mod = createAdminModule({ grants, moduleNames: MODULES });
  const ctx = { userEmail: ROBIN, settings: {}, log: { info() {}, warn() {} } };

  await grant(mod, ctx, { module: 'asana', person: RILEY, until: '2026-09-30' });
  assert.equal(grants.granted('asana', { email: RILEY }), true);

  clock = Date.parse('2026-09-30T20:00:00Z'); // still the 30th in Buenos Aires
  await grants.refresh(true);
  assert.equal(grants.granted('asana', { email: RILEY }), true);

  clock = Date.parse('2026-10-01T12:00:00Z');
  await grants.refresh(true);
  assert.equal(grants.granted('asana', { email: RILEY }), false, 'lapsed on its own');
  assert.equal(grants.mayTalk({ email: RILEY }), false);

  await assert.rejects(grant(mod, ctx, { module: 'asana', person: RILEY, until: '2026-01-01' }), /already passed/);
  await assert.rejects(grant(mod, ctx, { module: 'asana', person: RILEY, until: 'next friday' }), /2026-11-30/);
});

test('revoking removes a grant; config access is untouched', async () => {
  const { mod, ctx, grants } = setup();
  await grant(mod, ctx, { module: 'asana', person: RILEY });
  const { content } = await revoke(mod, ctx, { module: 'asana', person: RILEY });
  assert.match(content, /Removed riley@example\.com's asana access/);
  assert.equal(grants.granted('asana', { email: RILEY }), false);
  assert.equal(grants.mayTalk({ email: RILEY }), false, 'nothing else was granted, so Buddy closes again');

  // Somebody who only ever had config access: the policy still allows them afterwards.
  const policy = createAccessPolicy({
    modules: [{ name: 'asana' }],
    env: { BUDDY_ACCESS_ASANA: 'remy@example.com' },
    grants,
  });
  await revoke(mod, ctx, { module: 'asana', person: 'remy@example.com' });
  assert.equal(policy.canUse('asana', { email: 'remy@example.com' }), true, 'the file always wins');
  assert.equal(policy.sourceOf('asana', { email: 'remy@example.com' }), 'config');
});

test('revoking what was never granted says so, instead of pretending', async () => {
  const { mod, ctx } = setup();
  const { content } = await revoke(mod, ctx, { module: 'asana', person: RILEY });
  assert.match(content, /had no asana access granted from chat/);
  assert.match(content, /config file/);
});

test('a grant still leaves other modules closed, and roles are never granted', async () => {
  const { mod, ctx, grants } = setup();
  await grant(mod, ctx, { module: 'kudos', person: RILEY });
  const policy = createAccessPolicy({
    modules: [{ name: 'kudos', roles: ['admin'] }],
    env: { BUDDY_ACCESS_KUDOS: ROBIN, BUDDY_ROLE_KUDOS_ADMIN: `${ROBIN},${RILEY}` },
    grants,
  });
  assert.equal(policy.canUse('kudos', { email: RILEY }), true);
  assert.equal(policy.sourceOf('kudos', { email: RILEY }), 'granted');
  assert.equal(policy.hasRole('kudos', 'admin', { email: RILEY }), false,
    'a chat grant must not carry a configured role with it');
  assert.equal(policy.hasRole('kudos', 'admin', { email: ROBIN }), true);
});

test('every change waits for a click, and the card spells out what happens', async () => {
  const { mod, ctx } = setup();
  const tools = await mod.tools(ctx);
  assert.equal(tools.needsApproval('grant_access', {}), true);
  assert.equal(tools.needsApproval('revoke_access', {}), true);

  const card = await tools.describe('grant_access', { module: 'asana', person: RILEY, until: '2026-11-30' });
  assert.equal(card.effect, 'create');
  assert.deepEqual(card.fields[0], { label: 'Module', value: 'asana' });
  assert.deepEqual(card.fields[2], { label: 'Until', value: '2026-11-30' });
  assert.match(card.fields[3].value, /will be able to talk to Buddy/);

  const removal = await tools.describe('revoke_access', { module: 'asana', person: RILEY });
  assert.equal(removal.effect, 'delete');
  assert.match(removal.fields.at(-1).value, /config file still applies/);
});

test('the card refuses exactly what execution refuses, so nothing shown can fail later', async () => {
  const { mod, ctx } = setup();
  const tools = await mod.tools(ctx);
  await assert.rejects(tools.describe('grant_access', { module: 'leave', person: RILEY }), /stays in the config file/);
  await assert.rejects(tools.describe('grant_access', { module: 'asana', person: 'x@gmail.com' }), /example/);
});

test('protected modules are not even offered to Claude', async () => {
  const { mod, ctx } = setup();
  const [grantTool] = (await mod.tools(ctx)).definitions;
  const offered = grantTool.input_schema.properties.module.enum;
  for (const name of PROTECTED) assert.ok(!offered.includes(name), `${name} must not be offered`);
  assert.ok(offered.includes('asana'));
});

test('changes are logged with who did them', async () => {
  const { mod, ctx, logged } = setup();
  await grant(mod, ctx, { module: 'asana', person: RILEY, until: '2026-11-30' });
  await revoke(mod, ctx, { module: 'asana', person: RILEY });
  assert.deepEqual(logged.map(l => l.msg), ['access granted', 'access revoked']);
  assert.equal(logged[0].data.by, ROBIN);
  assert.equal(logged[0].data.until, '2026-11-30');
  assert.equal(logged[1].data.person, RILEY);
});

test('/access shows what chat granted, and says the file still applies', async () => {
  const { mod, ctx } = setup();
  await grant(mod, ctx, { module: 'asana', person: RILEY, until: '2026-11-30' });

  const all = await mod.commands.access.run(ctx, '');
  assert.match(all.text, /infra\/config\.env/);
  assert.match(all.text, /\*\*asana\*\*/, 'the module with grants gets its own block');
  assert.match(all.text, /• riley@example\.com — until 2026-11-30/);
  assert.match(all.text, /Nobody granted from chat: basics, files, kudos, ooo/, 'the empty ones are one quiet line');
  assert.match(all.text, /Never changeable from chat: admin, leave, assistant/);

  const one = await mod.commands.access.run(ctx, 'asana');
  assert.match(one.text, /riley@/);
  const none = await mod.commands.access.run(ctx, 'kudos');
  assert.match(none.text, /Nobody has been given \*\*kudos\*\* from chat/);
  const locked = await mod.commands.access.run(ctx, 'leave');
  assert.match(locked.text, /config file only/);
});
