/** Per-user monthly spend tracking and the hard budget cap (checked before every Claude call). */

/**
 * Writing to the cache costs more than plain input, and how much more depends on how long the
 * cache is asked to live: a five-minute write is 1.25x the input price, an hour is 2x. We ask for
 * an hour (CACHE_TTL), so charging 1.25 would under-report every first request by 60%.
 * Reads are a tenth either way.
 */
const CACHE_WRITE_MULTIPLIER = { '5m': 1.25, '1h': 2 };
const CACHE_READ_MULTIPLIER = 0.1;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

class BudgetExceededError extends Error {
  constructor(capUsd, now = new Date()) {
    const reset = MONTHS[(now.getUTCMonth() + 1) % 12];
    super(`You've used this month's allowance ($${capUsd}). I'm back on 1 ${reset}. Thanks for keeping me busy!`);
    this.expose = true;
  }
}

function monthKey(now = new Date()) {
  return now.toISOString().slice(0, 7);
}

/**
 * @param prices  either one {inPerMTok, outPerMTok} pair, or a map of model → pair with a
 *   `default` entry. A model with no entry falls back to the default rather than costing zero:
 *   an unpriced model must show up as expensive, not free.
 */
function pricesFor(prices, model) {
  if (!prices || typeof prices.inPerMTok === 'number') return prices;
  if (prices[model]) return prices[model];
  // Replies can name their model with a date on the end ("claude-haiku-4-5-20251001"); the
  // price belongs to the name it starts with. Longest match wins, so a "claude-opus-5-5" entry is
  // never shadowed by a shorter "claude-opus-5" one.
  const name = String(model || '');
  const match = Object.keys(prices)
    .filter(key => key !== 'default' && name.startsWith(`${key}-`))
    .sort((a, b) => b.length - a.length)[0];
  return (match && prices[match]) || prices.default || { inPerMTok: 0, outPerMTok: 0 };
}

function costUsd(usage, prices, model, cacheTtl = '1h') {
  const input = usage.input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const output = usage.output_tokens || 0;
  const rate = pricesFor(prices, model);
  const writeRate = CACHE_WRITE_MULTIPLIER[cacheTtl] || CACHE_WRITE_MULTIPLIER['1h'];
  return (
    input * rate.inPerMTok
    + cacheWrite * rate.inPerMTok * writeRate
    + cacheRead * rate.inPerMTok * CACHE_READ_MULTIPLIER
    + output * rate.outPerMTok
  ) / 1e6;
}

const EVENT_TTL_DAYS = 90;
const randomId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function createUsage({ store, prices, capUsd, cacheTtl = '1h', now = () => new Date(), eventTtlDays = EVENT_TTL_DAYS }) {
  const col = store.collection('core__usage');
  const events = store.collection('core__usage_events');
  const empty = () => ({ month: monthKey(now()), inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, usd: 0 });
  const current = doc => (doc && doc.month === monthKey(now()) ? doc : empty());

  /**
   * @param cap  the allowance to enforce. Someone who can only drive one module through Claude
   *   gets a smaller one than someone who can chat about anything: see MONTHLY_USD_CAP_SCOPED.
   */
  const forUser = (userId, cap = capUsd) => ({
    async get() { return { ...current(await col.get(userId)), capUsd: cap }; },
    async check() {
      if (current(await col.get(userId)).usd >= cap) throw new BudgetExceededError(cap, now());
    },
    async record(usage, model) {
      await col.update(userId, doc => {
        const u = current(doc);
        return {
          month: u.month,
          inputTokens: u.inputTokens + (usage.input_tokens || 0),
          outputTokens: u.outputTokens + (usage.output_tokens || 0),
          cacheReadTokens: u.cacheReadTokens + (usage.cache_read_input_tokens || 0),
          cacheWriteTokens: u.cacheWriteTokens + (usage.cache_creation_input_tokens || 0),
          usd: u.usd + costUsd(usage, prices, model, cacheTtl),
        };
      });
    },
  });

  return {
    forUser,

    /**
     * One request's worth of metering. It is the budget the agent loop uses — so the cap still
     * stops a runaway before any call — and it collects what that request cost, which tools it
     * used and how it ended, for one event written at the end.
     *
     * Metadata only: what was asked and what came back are never recorded.
     */
    /**
     * @param backend  'subscription' for the proxy experiment (0010-subscription-proxy.md). Those
     *   requests cost nothing in dollars and never touch the monthly cap — the cap is API money.
     *   What they do use is the subscription's window, so that is recorded instead, with the
     *   API price they would have had, for the comparison the experiment is for.
     */
    meter({ userId, userEmail, trigger = 'message', model = null, capUsd: cap = capUsd, backend = 'api' }) {
      const budget = forUser(userId, cap);
      const startedAt = now().getTime();
      const onSubscription = backend === 'subscription';
      let usedModel = model;
      const totals = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, usd: 0 };
      let apiEquivalentUsd = 0;
      let window = null;
      const tools = [];

      return {
        get totals() { return { ...totals }; },
        get tools() { return [...tools]; },

        check: () => (onSubscription ? Promise.resolve() : budget.check()),

        async record(usage, ranOn = model) {
          if (ranOn) usedModel = ranOn;
          totals.calls += 1;
          totals.inputTokens += usage.input_tokens || 0;
          totals.outputTokens += usage.output_tokens || 0;
          totals.cacheReadTokens += usage.cache_read_input_tokens || 0;
          totals.cacheWriteTokens += usage.cache_creation_input_tokens || 0;
          const priced = costUsd(usage, prices, usedModel, cacheTtl);
          if (onSubscription) {
            apiEquivalentUsd += priced;
            if (usage.buddy_subscription) window = usage.buddy_subscription;
            return;
          }
          totals.usd += priced;
          await budget.record(usage, usedModel);
        },

        /** Every tool the request ran, in order, with whether it worked. */
        toolUsed(name, { failed = false } = {}) {
          tools.push({ name: String(name), ...(failed ? { failed: true } : {}) });
        },

        /**
         * @param outcome  answered · failed · declined · expired · capped · connect
         * The module credited is the one whose tools ran; a request that used none is the
         * assistant's. Attribution is deliberately coarse — see docs/decisions/0006-costs.md.
         */
        async finish({ outcome = 'answered', module = null } = {}) {
          // A request that failed before Claude answered cost nothing, but it is exactly what
          // the waste report is for: record anything that did not simply answer.
          if (!totals.calls && !tools.length && outcome === 'answered') return null;
          const at = now();
          const used = [...new Set(tools.map(t => t.name.split('__')[0]))];
          const event = {
            at: at.toISOString(),
            month: monthKey(at),
            userId,
            userEmail: String(userEmail || '').toLowerCase(),
            module: module || used[0] || 'assistant',
            modulesUsed: used,
            tools,
            trigger,
            outcome,
            model: usedModel,
            calls: totals.calls,
            ...totals,
            backend,
            ...(onSubscription ? {
              apiEquivalentUsd,
              subscription: window ? {
                fiveHour: window.five_hour_utilization ?? null,
                sevenDay: window.seven_day_utilization ?? null,
                resetsAt: window.five_hour_resets_at ?? null,
                usingOverage: window.using_overage ?? null,
              } : null,
            } : {}),
            ms: at.getTime() - startedAt,
            expireAt: new Date(at.getTime() + eventTtlDays * 24 * 3600 * 1000),
          };
          await events.set(`${at.toISOString()}-${randomId()}`, event);
          return event;
        },
      };
    },

    /**
     * Money spent outside Claude — embedding a manual, say. Recorded so `/costs` can show it,
     * but deliberately NOT charged against anyone's monthly cap: the cap is there to stop one
     * person's conversations running away, and indexing a policy is infrastructure, not chat.
     */
    async spend({ userId = '', userEmail = '', module, kind, units = 0, usd = 0, note = null }) {
      const at = now();
      const event = {
        at: at.toISOString(),
        month: monthKey(at),
        userId,
        userEmail: String(userEmail || '').toLowerCase(),
        module,
        kind,
        units,
        usd,
        ...(note ? { note } : {}),
        outcome: 'spend',
        calls: 0,
        tools: [],
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        ms: 0,
        expireAt: new Date(at.getTime() + eventTtlDays * 24 * 3600 * 1000),
      };
      await events.set(`${at.toISOString()}-${randomId()}`, event);
      return event;
    },

    /** Everything recorded since an ISO timestamp, oldest first. For /costs and the weekly Sheet. */
    events: (sinceIso = null) => events.list({ field: 'at', from: sinceIso }),
  };
}

module.exports = { createUsage, costUsd, BudgetExceededError, EVENT_TTL_DAYS };
