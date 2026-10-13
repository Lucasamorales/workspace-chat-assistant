const test = require('node:test');
const assert = require('node:assert/strict');
const { planFor, turnKind, replayText, responseFor, exchangeKey, sameArgs, fromCli } = require('../src/translate');
const { createStreamParser } = require('../src/stream');
const { cleanEnv, buildArgs, envFor, resolveClaudeBin } = require('../src/cli');
const { createExperimentLog, usageFields } = require('../src/log');

/* ---------- what Buddy sends ---------- */

const BODY = {
  model: 'claude-sonnet-5',
  max_tokens: 16000,
  system: [{ type: 'text', text: 'You are Buddy.' }, { type: 'text', text: 'Today is 2026-09-28.' }],
  tools: [
    { type: 'tool_search_tool_regex_20251119', name: 'tool_search_tool_regex' },
    { name: 'asana__search_tasks', description: 'Search', input_schema: { type: 'object' } },
    { name: 'asana__get_portfolios', input_schema: { type: 'object' }, defer_loading: true },
  ],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  cache_control: { type: 'ephemeral', ttl: '1h' },
  output_config: { effort: 'medium' },
  metadata: { user_id: 'owner-robin' },
};

test('a request becomes a CLI plan: Buddy tools only, the API tool search dropped, deferral noticed', () => {
  const plan = planFor(BODY);
  assert.equal(plan.system, 'You are Buddy.\n\nToday is 2026-09-28.');
  assert.deepEqual(plan.tools.map(t => t.name), ['asana__search_tasks', 'asana__get_portfolios']);
  assert.equal(plan.tools[1].description, 'asana__get_portfolios', 'a tool with no description still gets one');
  assert.equal(plan.toolSearch, true, 'something was deferred, so the CLI gets its own ToolSearch');
  assert.equal(plan.effort, 'medium');
  assert.deepEqual(plan.ignored, ['cache_control'], 'what has no CLI equivalent is named, not silently lost');
});

test('the owner is part of the key, and a request without one is refused', () => {
  const other = structuredClone(BODY);
  other.metadata.user_id = 'owner-second';
  assert.notEqual(planFor(other).configHash, planFor(BODY).configHash, 'same permissions, different person, different process');
  const { metadata, ...anonymous } = BODY;
  assert.throws(() => planFor(anonymous), /never shared between people/);
});

test('the same configuration always hashes the same, and a different day does not', () => {
  assert.equal(planFor(BODY).configHash, planFor(structuredClone(BODY)).configHash);
  const tomorrow = structuredClone(BODY);
  tomorrow.system[1].text = 'Today is 2026-09-29.';
  assert.notEqual(planFor(tomorrow).configHash, planFor(BODY).configHash);
});

test('tool results are told apart from a new message', () => {
  const results = turnKind([
    { role: 'user', content: 'rename it' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'asana__update_tasks', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'ok' }] }] },
  ]);
  assert.equal(results.kind, 'tool_results');
  assert.deepEqual(results.results, [{ id: 't1', content: 'ok', isError: false }]);

  const fresh = turnKind([{ role: 'user', content: 'hello' }]);
  assert.equal(fresh.kind, 'new');
  assert.deepEqual(fresh.current, [{ type: 'text', text: 'hello' }]);
  assert.throws(() => turnKind([{ role: 'assistant', content: 'x' }]), /last message must be from the user/);
});

// The spike's dangerous result: injected history was ignored and a rename was repeated.
test('replayed history says, in words, that earlier tool calls already happened', () => {
  const text = replayText([
    { role: 'user', content: 'rename 123' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'asana__update_tasks', input: { gid: '123' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Renamed.' }] },
  ]);
  assert.match(text, /never repeat one/);
  assert.match(text, /You called asana__update_tasks with \{"gid":"123"\}\. This already happened\./);
  assert.match(text, /That call returned: Renamed\./);
  assert.equal(replayText([]), '', 'a first message carries no preamble');
});

test('the response looks like the API: prefix off, text kept, subscription window attached', () => {
  const out = responseFor({
    message: {
      id: 'm1', model: 'claude-sonnet-5', stopReason: 'tool_use',
      blocks: [{ type: 'thinking' }, { type: 'text', text: 'On it.' }, { type: 'tool_use', id: 't1', name: 'mcp__buddy__asana__search_tasks', input: { q: 'x' } }],
    },
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    rateLimit: { isUsingOverage: false, unifiedWindows: { five_hour: { utilization: 0.3, resetsAt: 1 }, seven_day: { utilization: 0.1 } } },
    apiCalls: 1,
    internalCalls: 0,
  });
  assert.deepEqual(out.content, [{ type: 'text', text: 'On it.' }, { type: 'tool_use', id: 't1', name: 'asana__search_tasks', input: { q: 'x' } }]);
  assert.equal(out.stop_reason, 'tool_use');
  assert.equal(out.usage.buddy_subscription.five_hour_utilization, 0.3);
  assert.equal(out.usage.buddy_subscription.using_overage, false);
});

test('only the proxy\'s own tools are Buddy\'s; ToolSearch is not', () => {
  assert.equal(fromCli('mcp__buddy__asana__x'), 'asana__x');
  assert.equal(fromCli('ToolSearch'), null);
  assert.equal(fromCli('mcp__other__x'), null);
});

test('tool arguments match whatever order their keys arrive in', () => {
  assert.equal(sameArgs({ a: 1, b: { c: [1, 2], d: 2 } }, { b: { d: 2, c: [1, 2] }, a: 1 }), true);
  assert.equal(sameArgs({ a: 1 }, { a: 2 }), false);
  assert.equal(exchangeKey(' hi ', 'there\n'), exchangeKey('hi', 'there'), 'Buddy trims what it stores');
});

/* ---------- the CLI's stream ---------- */

test('a message is rebuilt from stream events, tool JSON reassembled, usage from the final delta', () => {
  const parser = createStreamParser();
  const got = [];
  parser.on('message', m => got.push(m));
  const ev = event => JSON.stringify({ type: 'stream_event', event });
  const lines = [
    ev({ type: 'message_start', message: { id: 'm1', model: 'x', usage: { input_tokens: 459, output_tokens: 1 } } }),
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
    ev({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'mcp__buddy__a' } }),
    ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"ta' } }),
    ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'sks":[1]}' } }),
    ev({ type: 'content_block_stop', index: 1 }),
    ev({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 44 } }),
    ev({ type: 'message_stop' }),
  ];
  // Split mid-line on purpose: stdout chunks do not respect line boundaries.
  const all = `${lines.join('\n')}\n`;
  parser.feed(all.slice(0, 100));
  parser.feed(all.slice(100));
  assert.equal(got.length, 1);
  assert.deepEqual(got[0].blocks[1], { type: 'tool_use', id: 't1', name: 'mcp__buddy__a', input: { tasks: [1] } });
  assert.equal(got[0].stopReason, 'tool_use');
  assert.equal(got[0].usage.output_tokens, 44, 'the snapshot said 1; the final delta is the truth');
  assert.equal(got[0].usage.input_tokens, 459);
});

test('init, the subscription window and results are surfaced; junk is noise, never fatal', () => {
  const parser = createStreamParser();
  const seen = [];
  for (const e of ['init', 'rate_limit', 'result', 'noise']) parser.on(e, v => seen.push([e, v]));
  parser.feed([
    JSON.stringify({ type: 'system', subtype: 'init', apiKeySource: 'none' }),
    JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { isUsingOverage: false } }),
    'not json at all',
    JSON.stringify({ type: 'result', subtype: 'success' }),
  ].join('\n'));
  parser.end();
  assert.deepEqual(seen.map(s => s[0]), ['init', 'rate_limit', 'noise', 'result']);
});

/* ---------- what the CLI may see and do ---------- */

test('the CLI never inherits a Claude session, and never an API key', () => {
  const source = {
    PATH: 'C:\\bin', APPDATA: 'C:\\Users\\x\\AppData\\Roaming',
    ANTHROPIC_API_KEY: 'sk-live', ANTHROPIC_BASE_URL: 'http://relay', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's', CLAUDE_CODE_MESSAGING_TOKEN: 't',
  };
  const env = cleanEnv(source);
  assert.deepEqual(Object.keys(env).sort(), ['APPDATA', 'PATH']);
  assert.throws(() => cleanEnv(source, { ANTHROPIC_API_KEY: 'sk' }), /refusing to start the CLI with ANTHROPIC_API_KEY/);
  assert.throws(() => cleanEnv(source, { CLAUDE_CODE_OAUTH_TOKEN: 'x' }), /refusing/);
  assert.doesNotThrow(() => cleanEnv(source, { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '16000' }), 'the one setting the proxy owns');
});

test('the CLI runs restricted: no tools of its own, nothing that can wait for a person, no bypass', () => {
  const plan = { model: 'claude-sonnet-5', effort: 'medium', toolSearch: false };
  const args = buildArgs(plan, { system: 'sys.txt', mcpConfig: 'mcp.json' });
  for (const flag of ['--restricted', '--strict-mcp-config', '--no-session-persistence', '--permission-prompts']) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf('--tools') + 1], '', 'no built-in tools');
  assert.equal(args[args.indexOf('--permission-prompts') + 1], 'none');
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__buddy', 'only the stub\'s tools');
  assert.ok(!args.some(a => /dangerously/.test(a)), 'the reference repo\'s bypass flag is never used');
  assert.equal(buildArgs({ ...plan, toolSearch: true }, { system: 's' }).includes('ToolSearch'), true);
  assert.equal(buildArgs(plan, { system: 's' }).includes('--mcp-config'), false, 'no tools, no MCP server');
});

test('the environment carries the limits a held call needs, and tool search only when asked for', () => {
  const env = envFor({ maxTokens: 16000, toolSearch: true }, { PATH: 'x' });
  assert.equal(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '16000');
  assert.equal(env.ENABLE_TOOL_SEARCH, 'true');
  assert.ok(Number(env.MCP_TOOL_TIMEOUT) >= 15 * 60 * 1000, 'an approval card can take fifteen minutes');
  assert.equal(envFor({ toolSearch: false }, {}).ENABLE_TOOL_SEARCH, undefined);
});

test('claude.exe is found behind the npm shim without going through cmd.exe', () => {
  assert.equal(resolveClaudeBin({ CLAUDE_BIN: 'C:\\x\\claude.exe' }), 'C:\\x\\claude.exe');
  if (process.platform === 'win32') {
    const found = resolveClaudeBin({ APPDATA: 'C:\\nowhere' }, {
      exists: () => false,
      where: () => 'C:\\npm\\claude\r\nC:\\npm\\claude.cmd\r\n',
      read: () => '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
    });
    assert.equal(found, 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe');
  }
});

/* ---------- the experiment log ---------- */

test('usage is logged under names the redactor leaves alone', () => {
  const lines = [];
  const original = process.stdout.write;
  process.stdout.write = line => { lines.push(line); return true; };
  try {
    createExperimentLog().info('x', { usage: usageFields({ input_tokens: 5, output_tokens: 7 }), authSource: 'none' });
  } finally {
    process.stdout.write = original;
  }
  const entry = JSON.parse(lines[0]);
  assert.deepEqual(entry.usage, { in: 5, out: 7, cacheRead: 0, cacheWrite: 0 });
  assert.equal(entry.authSource, 'none');
  assert.ok(entry.at, 'every line is timestamped: there is no Cloud Logging on a PC');
});

/* ---------- the work folder ---------- */

const fs = require('fs');
const os = require('os');
const pathLib = require('path');
const { prepareWorkRoot } = require('../src/runtime');

// The bug a second proxy instance found: the first version swept every session folder, live ones too.
test('startup clears only the folders of runs that are gone, never a live one or anything else', () => {
  const root = fs.mkdtempSync(pathLib.join(os.tmpdir(), 'buddy-proxy-root-'));
  for (const name of ['run-111', 'run-222', 'keep-me']) fs.mkdirSync(pathLib.join(root, name, 'session'), { recursive: true });
  const mine = prepareWorkRoot(root, { pid: 999, isAlive: pid => pid === 222 });
  assert.equal(mine, pathLib.join(root, 'run-999'));
  assert.deepEqual(fs.readdirSync(root).sort(), ['keep-me', 'run-222', 'run-999'], 'the dead run went; the live one and a stranger stayed');
  fs.rmSync(root, { recursive: true, force: true });
});

/* ---------- the login, checked before anything is accepted ---------- */

const { checkLogin } = require('../src/cli');

test('only a claude.ai login is a subscription; anything else stops the proxy starting', () => {
  assert.deepEqual(checkLogin({ loggedIn: true, authMethod: 'claude.ai', email: 'robin@example.com', subscriptionType: 'max' }),
    { ok: true, account: 'robin@example.com', plan: 'max' });
  assert.match(checkLogin({ loggedIn: false, authMethod: 'none' }).why, /not logged in/);
  assert.match(checkLogin({ loggedIn: true, authMethod: 'api_key' }).why, /not a Claude subscription/);
  assert.match(checkLogin({ loggedIn: true, authMethod: 'console' }).why, /not a Claude subscription/);
  assert.equal(checkLogin(null).ok, false);
});
