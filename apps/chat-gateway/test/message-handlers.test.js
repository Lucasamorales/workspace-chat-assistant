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

function setup({ assistantAccess = 'robin@example.com' } = {}) {
  const store = core.createMemoryStore();
  const posted = [];
  const seen = [];
  const background = [];
  let claudeCalls = 0;
  const chat = {
    postText: async (space, thread, text) => { posted.push({ text }); return `${space}/messages/${posted.length}`; },
    postCard: async (space, thread, text, cardsV2) => { posted.push({ text, cardsV2 }); return `${space}/messages/${posted.length}`; },
    replaceText: async (name, space, thread, text) => { posted.push({ text }); },
    replaceWithCard: async () => {},
    download: async () => Buffer.alloc(0),
  };
  const modules = [require('@buddy/module-basics'), votesModule(seen), require('@buddy/module-asana'), require('@buddy/module-assistant')];
  const access = core.createAccessPolicy({
    modules,
    env: {
      BUDDY_ACCESS_BASICS: 'domain:example.com',
      BUDDY_ACCESS_VOTES: 'robin@example.com',
      BUDDY_ROLE_VOTES_ADMIN: 'robin@example.com',
      BUDDY_ACCESS_ASANA: 'domain:example.com',
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
    claude: { create: async () => { claudeCalls += 1; return { usage: {}, stop_reason: 'end_turn', content: [{ type: 'text', text: 'from Claude' }] }; } },
    makeModuleContext: core.createContextFactory({ store, sealer: core.createLocalSealer(), env: {}, log: quietLog, access }),
    defer: p => background.push(p),
  });
  const settle = async () => { while (background.length) await background.shift(); };
  return { handle, settle, posted, seen, claudeCount: () => claudeCalls };
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

test('without assistant access: no Claude, no cost — a card with what they can use instead', async () => {
  const { handle, settle, posted, seen, claudeCount } = setup();
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
  assert.match(asana.text, /I don't know \/asana/, 'Asana needs Claude, so it is hidden without assistant access');
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
