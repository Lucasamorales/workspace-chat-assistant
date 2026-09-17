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

function setup() {
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
  const modules = [require('@buddy/module-basics'), votesModule(seen)];
  const access = core.createAccessPolicy({
    modules,
    env: {
      BUDDY_ACCESS_BASICS: 'domain:example.com',
      BUDDY_ACCESS_VOTES: 'robin@example.com',
      BUDDY_ROLE_VOTES_ADMIN: 'robin@example.com',
    },
  });
  const handle = createEventHandler({
    registry: core.createRegistry({ modules, env: {}, log: quietLog, access }),
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

test('someone without access to the module goes to Claude, and cannot see or run its commands', async () => {
  const { handle, settle, seen, claudeCount } = setup();
  await handle(voteEvent(EVE));
  await settle();
  assert.equal(seen.length, 0);
  assert.equal(claudeCount(), 1);

  const res = await handle({ ...voteEvent(EVE), message: { ...voteEvent(EVE).message, text: '/votes-audit', argumentText: '/votes-audit', annotations: [] } });
  assert.match(res.text, /I don't know \/votes-audit/);
});
