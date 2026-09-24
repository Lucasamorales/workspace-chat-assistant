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

function createClaude({ apiKey, model, effort, maxTokens = 4000, cacheTtl = '1h', client }) {
  const anthropic = client || new Anthropic({ apiKey });
  return {
    create({ system, tools, messages }) {
      const withTools = withSearch(tools);
      return anthropic.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        ...(withTools && withTools.length ? { tools: withTools } : {}),
        messages,
        // Caches system + tools + history. An hour rather than the default five minutes: chat
        // comes in bursts, and it is the first request after a gap that pays full price.
        cache_control: { type: 'ephemeral', ttl: cacheTtl },
        output_config: { effort },
      });
    },
  };
}

module.exports = { createClaude, Anthropic };
