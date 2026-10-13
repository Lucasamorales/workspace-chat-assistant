/**
 * Between the Anthropic Messages API, which Buddy speaks, and the CLI.
 *
 * Buddy's tools reach the CLI through one MCP server named `buddy`, so the CLI sees
 * `asana__search_tasks` as `mcp__buddy__asana__search_tasks`. The prefix goes on here and comes
 * off here; nothing else knows about it.
 *
 * Some of what Buddy sends has no CLI equivalent and is deliberately ignored — cache_control
 * (the CLI caches on its own, and the spike showed it carries across processes),
 * context_management (the CLI compacts on its own), the server-side tool-search tool (the CLI's
 * own ToolSearch takes its place). They are listed in the log for every request, so it is always
 * visible what was dropped.
 */

const crypto = require('crypto');

const PREFIX = 'mcp__buddy__';
const toCli = name => `${PREFIX}${name}`;
const fromCli = name => (typeof name === 'string' && name.startsWith(PREFIX) ? name.slice(PREFIX.length) : null);

const HANDLED = new Set(['model', 'max_tokens', 'system', 'tools', 'messages', 'output_config', 'metadata']);
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

const systemText = system => (Array.isArray(system)
  ? system.filter(b => b && b.type === 'text').map(b => b.text).join('\n\n')
  : String(system || ''));

/**
 * What a session is configured with: everything that has to be fixed when the CLI starts — and
 * whose it is.
 *
 * The owner is part of the key on purpose. Buddy's prompt does not name the person asking, so
 * two accounts with the same permissions produce the same prompt and tools; keyed on those
 * alone, one person's next message could continue in the process holding someone else's
 * conversation. `metadata.user_id` is the API's own field for this, and Buddy sends it as an
 * opaque hash. A request without one is refused rather than risk a shared process.
 */
function planFor(body) {
  const owner = body.metadata && typeof body.metadata.user_id === 'string' ? body.metadata.user_id : '';
  if (!owner) {
    throw Object.assign(new Error('metadata.user_id is required, so conversations are never shared between people.'), { status: 400, type: 'invalid_request_error' });
  }
  const all = Array.isArray(body.tools) ? body.tools : [];
  // Server tools (the API's tool search) have a `type`; Buddy's own tools do not.
  const tools = all.filter(t => !t.type).map(t => ({
    name: t.name,
    description: t.description || t.name,
    inputSchema: t.input_schema || { type: 'object' },
  }));
  const plan = {
    owner,
    model: body.model,
    effort: body.output_config && body.output_config.effort,
    maxTokens: body.max_tokens,
    system: systemText(body.system),
    tools,
    toolSearch: all.some(t => t.defer_loading),
    ignored: Object.keys(body).filter(k => !HANDLED.has(k)),
  };
  plan.configHash = hash({ o: owner, m: plan.model, e: plan.effort, x: plan.maxTokens, s: plan.system, t: plan.tools, q: plan.toolSearch });
  return plan;
}

const textOf = content => (typeof content === 'string'
  ? content
  : (content || []).filter(b => b && b.type === 'text').map(b => b.text).join('\n'));

const asBlocks = content => (typeof content === 'string' ? [{ type: 'text', text: content }] : (content || []));

/**
 * What kind of turn a request is.
 *   tool_results  Buddy is answering tool calls it was given — continue a held session
 *   new           a fresh user message, possibly with earlier conversation before it
 */
function turnKind(messages = []) {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') throw Object.assign(new Error('The last message must be from the user.'), { status: 400, type: 'invalid_request_error' });
  const results = asBlocks(last.content).filter(b => b.type === 'tool_result');
  if (results.length) {
    return {
      kind: 'tool_results',
      results: results.map(r => ({ id: r.tool_use_id, content: resultText(r.content), isError: Boolean(r.is_error) })),
    };
  }
  return { kind: 'new', current: asBlocks(last.content), prior: messages.slice(0, -1) };
}

/** A tool result as the plain text the stub hands back to the CLI. */
function resultText(content) {
  if (typeof content === 'string') return content;
  return (content || []).map(b => (b.type === 'text' ? b.text : `[${b.type} omitted]`)).join('\n');
}

/**
 * Earlier conversation, as text, for a process that was not there for it.
 *
 * The spike's one dangerous result: history injected as structured turns was ignored, and the
 * model repeated a rename it had already made. So earlier tool calls are spelled out as done,
 * with an explicit instruction not to repeat them. (A repeated write would still meet Buddy's
 * approval card, never go through silently — but it should not be asked for at all.)
 */
function replayText(prior) {
  if (!prior.length) return '';
  const lines = [];
  for (const m of prior) {
    for (const b of asBlocks(m.content)) {
      if (b.type === 'text' && b.text.trim()) lines.push(`${m.role === 'user' ? 'User' : 'You'}: ${b.text}`);
      if (b.type === 'tool_use') lines.push(`You called ${b.name} with ${JSON.stringify(b.input)}. This already happened.`);
      if (b.type === 'tool_result') lines.push(`That call returned${b.is_error ? ' an error' : ''}: ${resultText(b.content)}`);
      if (b.type === 'image' || b.type === 'document') lines.push(`[${m.role === 'user' ? 'User' : 'You'} shared a ${b.type}]`);
    }
  }
  return [
    '<conversation_so_far>',
    'Everything below has already happened. Tool calls listed here were completed; never repeat one',
    'unless the user asks again.',
    '',
    ...lines,
    '</conversation_so_far>',
  ].join('\n');
}

/** One line of stream-json input: a user message for the CLI. */
const userLine = blocks => `${JSON.stringify({ type: 'user', message: { role: 'user', content: blocks } })}\n`;

const zeroUsage = () => ({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
function addUsage(into, u = {}) {
  for (const k of Object.keys(zeroUsage())) into[k] += Number(u[k]) || 0;
  return into;
}

/**
 * The Anthropic-shaped response for one turn.
 *
 * `usage.buddy_subscription` is the one addition: where the subscription window stands after
 * this turn. Buddy reads it for /costs; the SDK passes unknown fields through untouched.
 */
function responseFor({ message, usage, rateLimit, apiCalls, internalCalls }) {
  const content = [];
  for (const b of message.blocks) {
    if (b.type === 'text' && b.text) content.push({ type: 'text', text: b.text });
    const name = b.type === 'tool_use' ? fromCli(b.name) : null;
    if (name) content.push({ type: 'tool_use', id: b.id, name, input: b.input || {} });
  }
  const windows = (rateLimit && rateLimit.unifiedWindows) || {};
  return {
    id: message.id,
    type: 'message',
    role: 'assistant',
    model: message.model,
    content,
    stop_reason: content.some(b => b.type === 'tool_use') ? 'tool_use' : (message.stopReason || 'end_turn'),
    stop_sequence: null,
    usage: {
      ...usage,
      buddy_subscription: {
        five_hour_utilization: windows.five_hour ? windows.five_hour.utilization : null,
        five_hour_resets_at: windows.five_hour ? windows.five_hour.resetsAt : null,
        seven_day_utilization: windows.seven_day ? windows.seven_day.utilization : null,
        using_overage: rateLimit ? Boolean(rateLimit.isUsingOverage) : null,
        api_calls: apiCalls,
        internal_tool_calls: internalCalls,
      },
    },
  };
}

/**
 * Identifies one finished exchange, so the next message in the same thread can reuse its process.
 * Trimmed on both sides because Buddy trims the reply it stores; any other difference simply
 * means no match, and the thread falls back to a replay.
 */
const exchangeKey = (userText, replyText) => hash(`${String(userText).trim()}\u0000${String(replyText).trim()}`);

/** Stable comparison for tool arguments: the same call can arrive with keys in another order. */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
}
const sameArgs = (a, b) => JSON.stringify(stable(a || {})) === JSON.stringify(stable(b || {}));

module.exports = {
  PREFIX, toCli, fromCli, planFor, turnKind, replayText, userLine, textOf, asBlocks,
  zeroUsage, addUsage, responseFor, exchangeKey, sameArgs, resultText,
};
