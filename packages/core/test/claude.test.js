const test = require('node:test');
const assert = require('node:assert/strict');
const { createClaude } = require('../src/claude');

/** Captures the request that would have gone to Anthropic. */
function fake() {
  const sent = [];
  const claude = createClaude({
    model: 'claude-sonnet-5',
    effort: 'medium',
    client: { messages: { create: async params => { sent.push(params); return { usage: {}, content: [] }; } } },
  });
  return { claude, sent };
}

test('the request caches the stable prefix for an hour, not five minutes', async () => {
  // Chat comes in bursts; it is the first request after a gap that pays full price.
  const { claude, sent } = fake();
  await claude.create({ system: 'voice', tools: [{ name: 'a' }], messages: [{ role: 'user', content: 'hi' }] });
  assert.deepEqual(sent[0].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.equal(sent[0].model, 'claude-sonnet-5');
  assert.equal(sent[0].max_tokens, 4000, 'a ceiling on output: it costs five times the input price');
});

test('deferring tools brings in the search tool, so nothing becomes unreachable', async () => {
  const { claude, sent } = fake();
  await claude.create({
    system: 's',
    tools: [{ name: 'search_tasks' }, { name: 'duplicate_portfolio', defer_loading: true }],
    messages: [],
  });

  const [first, ...rest] = sent[0].tools;
  assert.equal(first.type, 'tool_search_tool_regex_20251119', 'the search tool leads, and is never deferred itself');
  assert.deepEqual(rest.map(t => t.name), ['search_tasks', 'duplicate_portfolio']);
  assert.equal(rest[1].defer_loading, true);
});

test('with nothing deferred, no search tool is added', async () => {
  const { claude, sent } = fake();
  await claude.create({ system: 's', tools: [{ name: 'a' }, { name: 'b' }], messages: [] });
  assert.deepEqual(sent[0].tools.map(t => t.name), ['a', 'b']);
});

test('deferring every tool is refused by the API, so the flags are dropped instead', async () => {
  // "All tools have defer_loading set" is a 400. A module that defers everything gets its
  // tools sent normally rather than a failed request.
  const { claude, sent } = fake();
  await claude.create({ system: 's', tools: [{ name: 'a', defer_loading: true }], messages: [] });
  assert.deepEqual(sent[0].tools, [{ name: 'a' }]);
  assert.ok(!sent[0].tools.some(t => t.type), 'and no search tool, since nothing is deferred any more');
});

test('no tools at all means no tools field, not an empty one', async () => {
  const { claude, sent } = fake();
  await claude.create({ system: 's', tools: [], messages: [] });
  assert.equal('tools' in sent[0], false);
});

test('context editing is off unless asked for, and asks to keep the recent tool results', async () => {
  const sent = [];
  const client = { messages: { create: async params => { sent.push(params); return { usage: {} }; } } };

  const off = createClaude({ model: 'claude-sonnet-5', effort: 'medium', client });
  await off.create({ system: 's', messages: [] });
  assert.equal(sent[0].context_management, undefined);

  const on = createClaude({ model: 'claude-sonnet-5', effort: 'medium', clearToolUses: 3, client });
  await on.create({ system: 's', messages: [] });
  const [edit] = sent[1].context_management.edits;
  assert.equal(edit.type, 'clear_tool_uses_20250919');
  assert.equal(edit.keep.value, 3);
});
