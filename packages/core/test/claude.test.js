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
  // A ceiling against a runaway answer, not a budget: headroom that is never written costs
  // nothing, and too little of it makes a large tool call impossible to write at all.
  assert.equal(sent[0].max_tokens, 16000);
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

/* ---------- the subscription proxy experiment (0010) ---------- */

function twoBackends({ proxyFails = null } = {}) {
  const api = [];
  const viaProxy = [];
  const claude = createClaude({
    model: 'claude-sonnet-5',
    effort: 'medium',
    client: { messages: { create: async params => { api.push(params); return { usage: {}, content: [] }; } } },
    proxyClient: {
      messages: {
        create: async params => {
          viaProxy.push(params);
          if (proxyFails) throw proxyFails;
          return { usage: { buddy_subscription: { five_hour_utilization: 0.3 } }, content: [] };
        },
      },
    },
  });
  return { claude, api, viaProxy };
}

test('a subscription request goes to the proxy, and everyone else still goes to the API', async () => {
  const { claude, api, viaProxy } = twoBackends();
  await claude.create({ system: 's', messages: [], backend: 'subscription', owner: '111' });
  await claude.create({ system: 's', messages: [] });
  assert.equal(viaProxy.length, 1);
  assert.equal(api.length, 1, 'the default is the API');
  assert.deepEqual(viaProxy[0].cache_control, { type: 'ephemeral', ttl: '1h' }, 'the proxy gets exactly what the API would');
});

// The rule Robin set for the experiment: using the API instead would defeat its purpose.
test('when the proxy fails, nothing falls back to the API — the error says so', async () => {
  const refused = Object.assign(new Error('403 {"type":"error"}'), {
    status: 403, error: { type: 'error', error: { type: 'permission_error', message: 'Refused: extra usage is switched on.' } },
  });
  const { claude, api } = twoBackends({ proxyFails: refused });
  await assert.rejects(claude.create({ system: 's', messages: [], backend: 'subscription', owner: '111' }), err => {
    assert.equal(err.expose, true, 'shown to the person, not swallowed');
    assert.equal(err.message, "The subscription proxy couldn't answer: Refused: extra usage is switched on.");
    return true;
  });
  assert.equal(api.length, 0, 'the API was never called');

  const offline = twoBackends({ proxyFails: new Error('fetch failed') });
  await assert.rejects(offline.claude.create({ system: 's', messages: [], backend: 'subscription', owner: '111' }), /not reachable/);
  assert.equal(offline.api.length, 0);
});

test('a subscription request with no proxy configured fails rather than using the API', async () => {
  const { claude, sent } = fake();
  await assert.rejects(claude.create({ system: 's', messages: [], backend: 'subscription', owner: '111' }), /not configured/);
  assert.equal(sent.length, 0);
});

test('the proxy is told whose request it is — as an opaque id, never an email — and the API is not', async () => {
  const { claude, api, viaProxy } = twoBackends();
  await claude.create({ system: 's', messages: [], backend: 'subscription', owner: '111' });
  await claude.create({ system: 's', messages: [], backend: 'subscription', owner: '222' });
  await claude.create({ system: 's', messages: [] });
  const [a, b] = viaProxy.map(p => p.metadata.user_id);
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, b, 'two people, two owners');
  assert.equal(api[0].metadata, undefined, 'API requests are unchanged');
  await assert.rejects(claude.create({ system: 's', messages: [], backend: 'subscription' }), /needs its owner/);
});
