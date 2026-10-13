/**
 * The whole proxy against a fake CLI: real HTTP server, real callback channel, real stub MCP
 * server spawned the way the CLI spawns it. Only the model is scripted (fake-claude.js).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createRuntime } = require('../src/runtime');
const { createSessions } = require('../src/sessions');
const { createCallbackServer } = require('../src/callback');
const { createProxyApp } = require('../src/server');

// Kept outside test/: node --test runs every file in there, and this one is not a test.
const FAKE = path.join(__dirname, '..', 'fixtures', 'fake-claude.js');
const SECRET = 's'.repeat(40);

function collectingLog() {
  const lines = [];
  const make = () => ({
    info: (message, fields) => lines.push({ level: 'info', message, ...fields }),
    warn: (message, fields) => lines.push({ level: 'warn', message, ...fields }),
    error: (message, fields) => lines.push({ level: 'error', message, ...fields }),
    child: () => make(),
  });
  return { log: make(), lines, saw: message => lines.some(l => l.message === message) };
}

async function setup({ limits = {} } = {}) {
  const { log, lines, saw } = collectingLog();
  let sessions;
  const callback = createCallbackServer({ sessions: { onStubCall: (...a) => sessions.onStubCall(...a) }, log });
  const callbackUrl = await callback.listen();
  const runtime = createRuntime({
    bin: 'claude',
    workRoot: path.join(os.tmpdir(), `buddy-proxy-test-${process.pid}-${Date.now()}`),
    callbackUrl,
    spawnImpl: (bin, args, opts) => spawn(process.execPath, [FAKE, ...args], opts),
  });
  sessions = createSessions({ spawnSession: runtime.spawnSession, log, limits: { spares: false, ...limits } });
  const server = createProxyApp({ secret: SECRET, sessions, log }).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}/v1/messages`;

  const post = async (body, key = SECRET) => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const close = async () => {
    sessions.shutdown();
    server.close();
    await callback.close();
  };
  return { post, close, lines, saw, sessions };
}

const TOOLS = [{ name: 'update_tasks', description: 'Update tasks. Changes real data.', input_schema: { type: 'object' } }];
const request = (messages, { system = 'You are Buddy.', tools = TOOLS, owner = 'owner-robin' } = {}) => ({
  model: 'claude-sonnet-5', max_tokens: 16000, system: [{ type: 'text', text: system }], tools, messages,
  cache_control: { type: 'ephemeral', ttl: '1h' }, output_config: { effort: 'medium' },
  ...(owner ? { metadata: { user_id: owner } } : {}),
});
const user = text => ({ role: 'user', content: [{ type: 'text', text }] });

test('a tool call is held open while Buddy runs it, and the same process carries on', async () => {
  const p = await setup();
  try {
    const first = await p.post(request([user('please rename task 123')]));
    assert.equal(first.status, 200);
    assert.equal(first.body.stop_reason, 'tool_use');
    const call = first.body.content.find(b => b.type === 'tool_use');
    assert.equal(call.name, 'update_tasks', 'Buddy gets its own tool name back, prefix off');
    assert.deepEqual(call.input, { tasks: [{ gid: '123', name: 'Hello' }] });
    assert.equal(first.body.usage.buddy_subscription.five_hour_utilization, 0.25);
    assert.equal(p.sessions.stats().heldCalls, 1);

    // Buddy ran the tool (after its approval card) and sends the result as its next request.
    const second = await p.post(request([
      user('please rename task 123'),
      { role: 'assistant', content: first.body.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: 'Renamed to Hello.' }] },
    ]));
    assert.equal(second.status, 200);
    assert.equal(second.body.stop_reason, 'end_turn');
    assert.equal(second.body.content[0].text, 'done: Renamed to Hello.');
    assert.ok(p.saw('resuming a held session'));
    assert.ok(!p.saw('replaying: no live session holds these tool calls'), 'the hot path, not the fallback');
    assert.ok(p.saw('held call answered'));
  } finally {
    await p.close();
  }
});

test('a declined change reaches the model as a refusal, and nothing claims it happened', async () => {
  const p = await setup();
  try {
    const first = await p.post(request([user('rename it')]));
    const call = first.body.content.find(b => b.type === 'tool_use');
    const second = await p.post(request([
      user('rename it'),
      { role: 'assistant', content: first.body.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: 'The user declined this action.', is_error: true }] },
    ]));
    assert.equal(second.body.content[0].text, 'failed: The user declined this action.');
  } finally {
    await p.close();
  }
});

test('the next message in a thread continues in the process that answered the last one', async () => {
  const p = await setup();
  try {
    const first = await p.post(request([user('hello')]));
    assert.equal(first.body.content[0].text, 'echo: hello');
    const second = await p.post(request([user('hello'), { role: 'assistant', content: 'echo: hello' }, user('again')]));
    assert.equal(second.body.content[0].text, 'echo: again', 'only the new message was sent: the process has the rest');
    assert.ok(p.saw('continuing the thread in its own process'));
  } finally {
    await p.close();
  }
});

test('with no live process, history is replayed as text and earlier tool calls are marked done', async () => {
  const p = await setup();
  try {
    const res = await p.post(request([
      user('rename it'),
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_gone', name: 'update_tasks', input: { gid: '1' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_gone', content: 'Renamed.' }] },
    ]));
    assert.equal(res.status, 200);
    assert.match(res.body.content[0].text, /This already happened/, 'the new process was told, in words');
    assert.ok(p.saw('replaying: no live session holds these tool calls'));
  } finally {
    await p.close();
  }
});

test('ToolSearch runs inside the CLI and never reaches Buddy; its call still counts', async () => {
  const p = await setup();
  try {
    const res = await p.post(request([user('search first please')], {
      tools: [...TOOLS, { name: 'get_portfolios', input_schema: { type: 'object' }, defer_loading: true }],
    }));
    assert.deepEqual(res.body.content, [{ type: 'text', text: 'found it' }]);
    assert.equal(res.body.usage.buddy_subscription.api_calls, 2);
    assert.equal(res.body.usage.buddy_subscription.internal_tool_calls, 1);
    assert.equal(res.body.usage.input_tokens, 200, 'usage covers both API calls of the turn');
  } finally {
    await p.close();
  }
});

// The line the experiment must never cross.
test('a CLI logged in with an API key is refused, never answered', async () => {
  const p = await setup();
  try {
    const res = await p.post(request([user('hello')], { system: 'You are Buddy. FAKE_AUTH=ANTHROPIC_API_KEY' }));
    assert.equal(res.status, 403);
    assert.equal(res.body.error.type, 'permission_error');
    assert.match(res.body.error.message, /never answers through API billing/);
    assert.ok(p.lines.some(l => l.message === 'guard refused the session' && l.level === 'error'));
  } finally {
    await p.close();
  }
});

// The gap the first real run found: the window is reported just after the reply, so a proxy that
// answered straight away would have answered before it knew this reply was billed as overage.
test('a reply billed as overage is refused, even the very first one', async () => {
  const p = await setup();
  try {
    const res = await p.post(request([user('hello')], { system: 'You are Buddy. FAKE_OVERAGE_IN_USE' }));
    assert.equal(res.status, 403);
    assert.match(res.body.error.message, /billing overage/);
    assert.ok(!p.saw('request answered'), 'nothing reached Buddy before the check');
  } finally {
    await p.close();
  }
});

// Structural rather than a race: with extra usage off, no reply can be billed per use at all.
test('an account with extra usage switched on is refused before anything is answered', async () => {
  const p = await setup();
  try {
    const res = await p.post(request([user('hello')], { system: 'You are Buddy. FAKE_EXTRA_USAGE_ON' }));
    assert.equal(res.status, 403);
    assert.match(res.body.error.message, /extra usage is switched on/);
  } finally {
    await p.close();
  }
});

test('the first reply waits for the window; later ones in the same process do not', async () => {
  const p = await setup({ limits: { windowWaitMs: 5000 } });
  try {
    const first = await p.post(request([user('please rename task 123')]));
    assert.equal(first.body.usage.buddy_subscription.five_hour_utilization, 0.25, 'known on the first reply');
    const call = first.body.content.find(b => b.type === 'tool_use');
    const started = Date.now();
    const second = await p.post(request([
      user('please rename task 123'),
      { role: 'assistant', content: first.body.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: 'Renamed.' }] },
    ]));
    assert.ok(Date.now() - started < 2500, 'no waiting for a report the CLI only sends once');
    assert.equal(second.body.usage.buddy_subscription.five_hour_utilization, 0.25, 'carries the last one known');
    assert.ok(!p.saw('no subscription window reported for this reply; answering on the last one known'));
  } finally {
    await p.close();
  }
});

test('the proxy answers nobody without its secret, and does not stream', async () => {
  const p = await setup();
  try {
    const wrong = await p.post(request([user('hello')]), 'w'.repeat(40));
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error.type, 'authentication_error');
    const streamed = await p.post({ ...request([user('hello')]), stream: true });
    assert.equal(streamed.status, 400);
  } finally {
    await p.close();
  }
});

test('a spare process is started ahead of time, and the next new conversation takes it', async () => {
  const p = await setup({ limits: { spares: true } });
  try {
    await p.post(request([user('hello')]));
    assert.ok(p.saw('spare started'));
    await p.post(request([user('a different conversation')]));
    assert.ok(p.saw('using a spare'), 'no cold start for the second conversation');
  } finally {
    await p.close();
  }
});

/* ---------- two accounts, same permissions: never one process ---------- */

// Buddy's prompt does not name the asker, so two accounts with the same permissions send the
// same prompt and tools. Without the owner in the key, B could continue in A's process.
test('a second account never continues in the first account\'s process, even with the same prompt', async () => {
  const p = await setup();
  try {
    const a = await p.post(request([user('hello')], { owner: 'owner-a' }));
    assert.equal(a.body.content[0].text, 'echo: hello');
    // B's history happens to match A's exchange word for word.
    const b = await p.post(request([user('hello'), { role: 'assistant', content: 'echo: hello' }, user('what did I ask?')], { owner: 'owner-b' }));
    assert.equal(b.status, 200);
    assert.ok(!p.saw('continuing the thread in its own process'), 'B started its own process');
    assert.match(b.body.content[0].text, /conversation_so_far/, 'B was answered from its own history, replayed');
  } finally {
    await p.close();
  }
});

test('a warm spare is only ever taken by the person it was started for', async () => {
  const p = await setup({ limits: { spares: true } });
  try {
    await p.post(request([user('hello')], { owner: 'owner-a' }));
    await p.post(request([user('something else')], { owner: 'owner-b' }));
    assert.ok(!p.saw('using a spare'), 'A\'s spare stayed A\'s');
    await p.post(request([user('another thing')], { owner: 'owner-a' }));
    assert.ok(p.saw('using a spare'), 'and A did get it');
  } finally {
    await p.close();
  }
});

test('tool results naming someone else\'s held call are refused, and the call stays held', async () => {
  const p = await setup();
  try {
    const first = await p.post(request([user('please rename task 123')], { owner: 'owner-a' }));
    const call = first.body.content.find(b => b.type === 'tool_use');
    const stolen = await p.post(request([
      user('please rename task 123'),
      { role: 'assistant', content: first.body.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: 'Renamed.' }] },
    ], { owner: 'owner-b' }));
    assert.equal(stolen.status, 403);
    assert.match(stolen.body.error.message, /belongs to someone else/);
    assert.equal(p.sessions.stats().heldCalls, 1, 'A\'s call is untouched');
  } finally {
    await p.close();
  }
});

test('a request that does not say whose it is gets no session at all', async () => {
  const p = await setup();
  try {
    const res = await p.post(request([user('hello')], { owner: null }));
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /never shared between people/);
    assert.equal(p.sessions.stats().live, 0);
  } finally {
    await p.close();
  }
});
