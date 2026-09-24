/** The one place that calls the Anthropic API. Kept thin so tests can swap it out. */

const { Anthropic } = require('@anthropic-ai/sdk');

/**
 * When a module defers some of its tools, Claude needs a way to find them. This server-side
 * tool does that: it searches the deferred definitions and loads the ones it needs, so a long
 * tail of rarely-used tools costs nothing until someone asks for one.
 *
 * It must never itself be deferred, and at least one ordinary tool must stay loaded.
 */
const TOOL_SEARCH = { type: 'tool_search_tool_regex_20251119', name: 'tool_search_tool_regex' };

function withSearch(tools) {
  if (!tools || !tools.length) return tools;
  const deferred = tools.some(t => t.defer_loading);
  const loaded = tools.some(t => !t.defer_loading);
  return deferred && loaded ? [TOOL_SEARCH, ...tools] : tools.map(({ defer_loading, ...t }) => t);
}

/**
 * Dropping the oldest tool results once a request gets long. In an Asana loop the results of
 * step one are dead weight by step six, but they are re-sent — and re-paid for — on every call.
 *
 * Off unless CLEAR_TOOL_USES is set, because it changes what Claude can still see: the number is
 * how many recent tool uses stay untouched.
 */
const clearing = keep => ({
  edits: [{
    type: 'clear_tool_uses_20250919',
    trigger: { type: 'input_tokens', value: 30000 },
    keep: { type: 'tool_uses', value: keep },
    clear_at_least: { type: 'input_tokens', value: 5000 },
  }],
});

function createClaude({ apiKey, model, effort, maxTokens = 16000, cacheTtl = '1h', clearToolUses = 0, client }) {
  const anthropic = client || new Anthropic({ apiKey });
  return {
    /**
     * @param opts.model   overrides the default for this request. Chosen from the person's scope,
     *   never mid-conversation: a cache belongs to one model, so switching throws it away.
     * @param opts.effort  likewise — looking something up needs less than a multi-step write.
     */
    create({ system, tools, messages, model: modelFor, effort: effortFor, maxTokens: cap }) {
      const withTools = withSearch(tools);
      return anthropic.messages.create({
        model: modelFor || model,
        max_tokens: cap || maxTokens,
        system,
        ...(withTools && withTools.length ? { tools: withTools } : {}),
        messages,
        // Caches system + tools + history. An hour rather than the default five minutes: chat
        // comes in bursts, and it is the first request after a gap that pays full price.
        cache_control: { type: 'ephemeral', ttl: cacheTtl },
        output_config: { effort: effortFor || effort },
        ...(clearToolUses ? { context_management: clearing(clearToolUses) } : {}),
      });
    },
  };
}

module.exports = { createClaude, Anthropic };
