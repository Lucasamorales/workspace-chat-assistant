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
  assert.equal(dm.title, 'What Buddy can do');
  assert.match(dm.text, /What's due today in Asana\?/);
  assert.match(dm.text, /\/asana connect/);
  assert.deepEqual(dm.buttons.map(b => b.text), ['Connect Asana', 'My usage', 'Start fresh']);
  const space = await basics.commands.help.run({ spaceKind: 'SPACE', core });
  assert.match(space.text, /only works in a private chat/);
});

test('usage formats the monthly spend', async () => {
  const core = { usage: async () => ({ usd: 1.234, capUsd: 15, inputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 0, outputTokens: 3 }) };
  assert.equal(await basics.commands.usage.run({ core }), 'This month: $1.23 of $15 (15 tokens in, 3 out).');
});
