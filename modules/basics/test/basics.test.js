const test = require('node:test');
const assert = require('node:assert/strict');
const { validateModule } = require('@buddy/core');
const basics = require('../src');

test('module satisfies the contract', () => validateModule(basics));

test('help is a card with examples and buttons; commands are still listed for power users', async () => {
  const core = {
    listCommands: () => [{ name: 'usage', description: 'spend' }, { name: 'asana', usage: '/asana connect', description: 'x' }],
    examples: () => ['What\'s due today in Asana?'],
    quickActions: async () => [{ text: 'Connect Asana', url: 'https://x' }],
  };
  const dm = await basics.commands.help.run({ spaceKind: 'DM', core });
  assert.equal(dm.title, 'Here\'s what I can do');
  assert.match(dm.text, /What's due today in Asana\?/);
  assert.match(dm.text, /\/asana connect/);
  assert.deepEqual(dm.buttons.map(b => b.text), ['Connect Asana', 'Start fresh']);
  const space = await basics.commands.help.run({ spaceKind: 'SPACE', core });
  assert.match(space.text, /only works in a private chat/);
});

test('spend is not reported here: it moved to the costs module, admins only', () => {
  // docs/decisions/0006-costs.md — costs are a management matter, not a leaderboard.
  assert.equal(basics.commands.usage, undefined);
});
