const test = require('node:test');
const assert = require('node:assert/strict');
const { validateModule } = require('@buddy/core');
const basics = require('../src');

test('module satisfies the contract', () => validateModule(basics));

test('help lists commands and explains where Asana works', async () => {
  const core = { listCommands: () => [{ name: 'usage', description: 'spend' }, { name: 'asana', usage: '/asana connect', description: 'x' }] };
  const dm = await basics.commands.help.run({ spaceKind: 'DM', core });
  assert.match(dm, /\/asana connect/);
  const space = await basics.commands.help.run({ spaceKind: 'SPACE', core });
  assert.match(space, /only works in a direct message/);
});

test('usage formats the monthly spend', async () => {
  const core = { usage: async () => ({ usd: 1.234, capUsd: 15, inputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 0, outputTokens: 3 }) };
  assert.equal(await basics.commands.usage.run({ core }), 'This month: $1.23 of $15 (15 tokens in, 3 out).');
});
