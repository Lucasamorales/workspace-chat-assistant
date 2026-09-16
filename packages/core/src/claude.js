/** The one place that calls the Anthropic API. Kept thin so tests can swap it out. */

const { Anthropic } = require('@anthropic-ai/sdk');

function createClaude({ apiKey, model, effort, maxTokens = 16000, client }) {
  const anthropic = client || new Anthropic({ apiKey });
  return {
    create({ system, tools, messages }) {
      return anthropic.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        ...(tools && tools.length ? { tools } : {}),
        messages,
        cache_control: { type: 'ephemeral' }, // caches system + tools + history across loop steps
        output_config: { effort },
      });
    },
  };
}

module.exports = { createClaude, Anthropic };
