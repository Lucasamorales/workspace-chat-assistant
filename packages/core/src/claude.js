/** The one place that calls the Anthropic API. Kept thin so tests can swap it out. */

const crypto = require('crypto');
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

const expose = message => Object.assign(new Error(message), { expose: true });

/**
 * Who a subscription request is for, as the proxy sees it: opaque, stable per person, not their
 * email. The proxy keys its processes on it so two people's conversations never share one.
 */
const ownerKey = owner => crypto.createHash('sha256').update(`buddy-user:${owner}`).digest('hex').slice(0, 32);

/**
 * @param proxy  experiment (docs/decisions/0010-subscription-proxy.md): `{ url, secret }` for the
 *   subscription proxy. Requests with `backend: 'subscription'` go there, answered by the Claude
 *   CLI on one person's subscription. There is deliberately no fallback to the API: a request
 *   meant for the subscription that cannot be answered there fails, and says why.
 */
function createClaude({ apiKey, model, effort, maxTokens = 16000, cacheTtl = '1h', clearToolUses = 0, client, proxy = null, proxyClient = null, log = null }) {
  const anthropic = client || new Anthropic({ apiKey });
  // Never retried: a retried turn could land on a proxy session that has already moved on.
  const subscription = proxyClient || (proxy && proxy.url
    ? new Anthropic({ apiKey: proxy.secret, baseURL: proxy.url, maxRetries: 0 })
    : null);

  async function viaSubscription(params) {
    if (!subscription) throw expose('The subscription proxy is not configured for this service.');
    const started = Date.now();
    try {
      const res = await subscription.messages.create(params);
      const sub = (res.usage && res.usage.buddy_subscription) || {};
      if (log) {
        log.info('subscription reply', {
          ms: Date.now() - started, stop: res.stop_reason, model: res.model,
          fiveHour: sub.five_hour_utilization, sevenDay: sub.seven_day_utilization, apiCalls: sub.api_calls,
        });
      }
      return res;
    } catch (error) {
      const status = error && error.status;
      // The SDK keeps the parsed body; its own message is the status plus that body as raw JSON.
      const said = (error && error.error && error.error.error && error.error.error.message) || (error && error.message) || 'it failed';
      if (log) log.warn('subscription proxy failed', { ms: Date.now() - started, status, why: String(said).slice(0, 300) });
      // Said plainly to the one person on the proxy: nothing falls back to API billing.
      const why = status ? said : 'the proxy is not reachable — is it running, and is the tunnel up?';
      throw expose(`The subscription proxy couldn't answer: ${why}`);
    }
  }

  return {
    /**
     * @param opts.model   overrides the default for this request. Chosen from the person's scope,
     *   never mid-conversation: a cache belongs to one model, so switching throws it away.
     * @param opts.effort  likewise — looking something up needs less than a multi-step write.
     * @param opts.backend 'subscription' for the one person on the proxy experiment; else the API.
     * @param opts.owner   who the request is for — required on the subscription, never sent to the API.
     */
    create({ system, tools, messages, model: modelFor, effort: effortFor, maxTokens: cap, backend = 'api', owner = null }) {
      const withTools = withSearch(tools);
      const params = {
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
      };
      if (backend !== 'subscription') return anthropic.messages.create(params);
      if (!owner) return Promise.reject(new Error('a subscription request needs its owner, so the proxy never mixes two people'));
      return viaSubscription({ ...params, metadata: { user_id: ownerKey(owner) } });
    },
  };
}

module.exports = { createClaude, Anthropic };
