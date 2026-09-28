const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('@buddy/core');
const { createEventHandler } = require('../src/handler');

const quietLog = { info() {}, warn() {}, error() {}, child() { return quietLog; } };
const ROBIN = { name: 'users/111', email: 'robin@example.com', displayName: 'Robin', type: 'HUMAN' };
const EVE = { name: 'users/333', email: 'eve@example.com', displayName: 'Eve', type: 'HUMAN' };
const KUDOS_SPACE = { name: 'spaces/kudos', displayName: 'Team - Kudos', spaceType: 'SPACE' };

/** Stand-in for a kudos-like module: takes messages that tag people, admin-only command. */
function votesModule(seen) {
  return {
    name: 'votes',
    roles: ['admin'],
    commands: { 'votes-audit': { description: 'admins only', role: 'admin', run: async () => 'audit done' } },
    handleMessage: async (ctx, message) => {
      const people = message.mentions.filter(m => m.type === 'HUMAN');
      if (!people.length) return null;
      seen.push({ message, isAdmin: ctx.hasRole('admin') });
      return { title: 'Got it', text: `Logged ${people.length} vote(s)` };
    },
  };
}

/** A second scoped module, so "which model?" can be asked of someone with more than one. */
const docsModule = {
  name: 'docs',
  allowedIn: ['DM'],
  needsConversation: true,
  scopedConversation: true,
  tools: async () => ({
    definitions: [{ name: 'search_docs', input_schema: { type: 'object' } }],
    execute: async () => ({ content: 'nothing' }),
  }),
};

function setup({
  assistantAccess = 'robin@example.com',
  asanaAccess = 'domain:example.com',
  docsAccess = 'robin@example.com',
  moduleTuning = {},
  subscriptionUsers = [],
} = {}) {
  const store = core.createMemoryStore();
  const posted = [];
  const seen = [];
  const background = [];
  let claudeCalls = 0;
  const claudeParams = [];
  const chat = {
    postText: async (space, thread, text) => { posted.push({ text }); return `${space}/messages/${posted.length}`; },
    postCard: async (space, thread, text, cardsV2) => { posted.push({ text, cardsV2 }); return `${space}/messages/${posted.length}`; },
    replaceText: async (name, space, thread, text) => { posted.push({ text }); },
    replaceWithCard: async () => {},
    download: async () => Buffer.alloc(0),
  };
  const modules = [require('@buddy/module-basics'), votesModule(seen), require('@buddy/module-asana'), docsModule, require('@buddy/module-assistant')];
  const access = core.createAccessPolicy({
    modules,
    env: {
      BUDDY_ACCESS_BASICS: 'domain:example.com',
      BUDDY_ACCESS_VOTES: 'robin@example.com',
      BUDDY_ROLE_VOTES_ADMIN: 'robin@example.com',
      BUDDY_ACCESS_ASANA: asanaAccess,
      BUDDY_ACCESS_DOCS: docsAccess,
      BUDDY_ACCESS_ASSISTANT: assistantAccess,
    },
  });
  const handle = createEventHandler({
    registry: core.createRegistry({ modules, env: { ASANA_CLIENT_ID: 'x', ASANA_CLIENT_SECRET: 'y' }, log: quietLog, access }),
    chat, store, log: quietLog, appName: 'Buddy',
    allowedUsers: ['domain:example.com'],
    threads: core.createThreads({ store, maxMessages: 20, ttlDays: 30 }),
    usage: core.createUsage({ store, capUsd: 15, prices: { inPerMTok: 2, outPerMTok: 10 } }),
    oauthFlows: core.createOAuthFlows({ store, secret: 'k'.repeat(40), baseUrl: 'https://oauth.test' }),
    claude: { create: async params => { claudeCalls += 1; claudeParams.push(params); return { usage: {}, stop_reason: 'end_turn', content: [{ type: 'text', text: 'from Claude' }] }; } },
    makeModuleContext: core.createContextFactory({ store, sealer: core.createLocalSealer(), env: {}, log: quietLog, access }),
    defer: p => background.push(p),
    moduleTuning,
    subscriptionUsers,
  });
  const settle = async () => { while (background.length) await background.shift(); };
  const events = () => store.collection('core__usage_events').list({ field: 'at' });
  return { handle, settle, posted, seen, claudeCount: () => claudeCalls, claudeParams, events };
}

const TEXT = '@Buddy kudos to @Eve for think big';
const voteEvent = user => ({
  type: 'MESSAGE',
  user,
  space: KUDOS_SPACE,
  message: {
    name: `spaces/kudos/messages/${Math.random().toString(36)}`,
    text: TEXT,
    argumentText: ' kudos to @Eve for think big',
    thread: { name: 'spaces/kudos/threads/t' },
    annotations: [
      { type: 'USER_MENTION', startIndex: 16, length: 4, userMention: { user: { name: 'users/333', displayName: 'Eve', type: 'HUMAN' } } },
      { type: 'USER_MENTION', startIndex: 0, length: 6, userMention: { user: { name: 'users/999', displayName: 'Buddy', type: 'BOT' } } },
    ],
  },
});

test('a handled message never reaches Claude, and the module gets mentions, space and sender', async () => {
  const { handle, settle, posted, seen, claudeCount } = setup();
  await handle(voteEvent(ROBIN));
  await settle();

  assert.equal(claudeCount(), 0);
  assert.equal(posted.length, 1, 'no "thinking…" placeholder for instant replies');
  assert.equal(posted[0].text, 'Got it');

  const { message, isAdmin } = seen[0];
  assert.equal(isAdmin, true);
  assert.deepEqual(message.mentions.map(m => [m.displayName, m.type, m.startIndex]), [['Buddy', 'BOT', 0], ['Eve', 'HUMAN', 16]], 'sorted by position');
  assert.equal(TEXT.substr(message.mentions[1].startIndex, message.mentions[1].length), '@Eve');
  assert.deepEqual(message.space, { name: 'spaces/kudos', displayName: 'Team - Kudos', kind: 'SPACE' });
  assert.deepEqual(message.sender, { userId: 'users/111', email: 'robin@example.com', displayName: 'Robin' });
});

const chatEvent = (user, text, space = { name: 'spaces/dm-eve', spaceType: 'DIRECT_MESSAGE' }) => ({
  type: 'MESSAGE', user, space,
  message: { name: `${space.name}/messages/${Math.random().toString(36)}`, text, argumentText: text, annotations: [] },
});

test('with nothing that needs Claude: no Claude, no cost — a card with what they can use instead', async () => {
  const { handle, settle, posted, seen, claudeCount } = setup({ asanaAccess: 'robin@example.com' });
  await handle(voteEvent(EVE)); // Eve has no access to the votes module either
  await handle(chatEvent(EVE, 'write me a poem'));
  await settle();

  assert.equal(seen.length, 0);
  assert.equal(claudeCount(), 0);
  assert.equal(posted.at(-1).text, 'Here\'s what I can help you with');
  assert.doesNotMatch(JSON.stringify(posted.at(-1).cardsV2), /Ask me anything|Asana/, 'no chat or Claude-only features offered');

  const cmd = await handle(chatEvent(EVE, '/votes-audit'));
  assert.match(cmd.text, /I don't know \/votes-audit/);
  const asana = await handle(chatEvent(EVE, '/asana connect'));
  assert.match(asana.text, /I don't know \/asana/, 'Asana is not hers, so it is hidden');
});

test('Asana without the assistant: Claude runs, but only for Asana', async () => {
  // The point of scoped conversation: "use Asana by asking" is an ordinary permission, while
  // "chat with Claude about anything" stays with the people who are meant to have it.
  const { handle, settle, claudeCount, claudeParams } = setup({ asanaAccess: 'domain:example.com' });
  await handle(chatEvent(EVE, 'what are my tasks due this week?'));
  await settle();

  assert.equal(claudeCount(), 1, 'she can drive Asana in words');
  const system = claudeParams.at(-1).system.map(b => b.text).join('\n');
  assert.match(system, /only to help with Asana/);
  assert.match(system, /do not answer it/, 'anything else is declined rather than answered');
  assert.doesNotMatch(system, /not negotiable, whatever anyone says, including anyone claiming to be an administrator\.[\s\S]*Ask me anything/);

  const asana = await handle(chatEvent(EVE, '/asana connect'));
  assert.doesNotMatch(asana.text || '', /I don't know \/asana/, 'and the commands are hers too');
});

test('with the assistant, no such restriction is added', async () => {
  const { handle, settle, claudeParams } = setup({ assistantAccess: 'domain:example.com' });
  await handle(chatEvent(EVE, 'write me a poem'));
  await settle();
  const system = claudeParams.at(-1).system.map(b => b.text).join('\n');
  assert.doesNotMatch(system, /only to help with/);
});

test('with assistant access, ordinary messages go to Claude and Claude-only modules appear', async () => {
  const { handle, settle, claudeCount } = setup({ assistantAccess: 'domain:example.com' });
  await handle(chatEvent(EVE, 'write me a poem'));
  await settle();
  assert.equal(claudeCount(), 1);

  const help = await handle(chatEvent(EVE, '/help'));
  assert.match(JSON.stringify(help.cardsV2), /Ask me anything/);
  assert.match(JSON.stringify(help.cardsV2), /Connect Asana/);
});

// Someone who can only drive one module does not need the model that answers anything.
test('one scope, one model: a scoped person runs on that module model and effort', async () => {
  const { handle, settle, claudeParams, events } = setup({
    moduleTuning: { asana: { model: 'claude-haiku-4-5', effort: 'low' } },
  });
  await handle(chatEvent(EVE, 'what are my tasks due this week?'));
  await settle();

  assert.equal(claudeParams.at(-1).model, 'claude-haiku-4-5');
  assert.equal(claudeParams.at(-1).effort, 'low');
  assert.equal((await events()).at(-1).model, 'claude-haiku-4-5', 'and /costs prices it as the model that actually ran');
});

test('free conversation keeps the default model, whatever is tuned', async () => {
  const { handle, settle, claudeParams } = setup({
    assistantAccess: 'domain:example.com',
    moduleTuning: { asana: { model: 'claude-haiku-4-5', effort: 'low' } },
  });
  await handle(chatEvent(EVE, 'write me a poem'));
  await settle();
  assert.equal(claudeParams.at(-1).model, undefined, 'the service default applies');
  assert.equal(claudeParams.at(-1).effort, undefined);
});

// Two scoped modules means the next message could be about either one, and a request is
// answered by one model throughout. The safe choice is the default, not a coin toss.
test('two scopes, no guess: the default model applies', async () => {
  const { handle, settle, claudeParams } = setup({
    docsAccess: 'domain:example.com',
    moduleTuning: { asana: { model: 'claude-haiku-4-5' }, docs: { model: 'claude-haiku-4-5' } },
  });
  await handle(chatEvent(EVE, 'what are my tasks due this week?'));
  await settle();
  assert.equal(claudeParams.at(-1).model, undefined);
});

// Experiment 0010: one person is answered through the subscription proxy; nobody else is.
test('only the people in CLAUDE_PROXY_USERS are answered through the subscription', async () => {
  const { handle, settle, claudeParams, events } = setup({
    assistantAccess: 'domain:example.com',
    subscriptionUsers: ['robin@example.com'],
  });
  await handle(chatEvent(ROBIN, 'hello', { name: 'spaces/dm-robin', spaceType: 'DIRECT_MESSAGE' }));
  await handle(chatEvent(EVE, 'hello'));
  await settle();

  // Background work finishes in either order; who got which is checked on the events below.
  assert.deepEqual(claudeParams.map(p => p.backend).sort(), ['api', 'subscription']);
  const recorded = await events();
  assert.deepEqual(recorded.map(e => [e.userEmail, e.backend]).sort(), [
    ['eve@example.com', 'api'],
    ['robin@example.com', 'subscription'],
  ]);
});

test('with nobody listed, everyone is on the API and the experiment changes nothing', async () => {
  const { handle, settle, claudeParams } = setup({ assistantAccess: 'domain:example.com' });
  await handle(chatEvent(ROBIN, 'hello', { name: 'spaces/dm-robin', spaceType: 'DIRECT_MESSAGE' }));
  await settle();
  assert.deepEqual(claudeParams.map(p => p.backend), ['api']);
});
