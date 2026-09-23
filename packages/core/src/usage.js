/** Per-user monthly spend tracking and the hard budget cap (checked before every Claude call). */

const CACHE_WRITE_MULTIPLIER = 1.25;
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

function costUsd(usage, prices) {
  const input = usage.input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const output = usage.output_tokens || 0;
  return (
    input * prices.inPerMTok
    + cacheWrite * prices.inPerMTok * CACHE_WRITE_MULTIPLIER
    + cacheRead * prices.inPerMTok * CACHE_READ_MULTIPLIER
    + output * prices.outPerMTok
  ) / 1e6;
}

const EVENT_TTL_DAYS = 90;
const randomId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function createUsage({ store, prices, capUsd, now = () => new Date(), eventTtlDays = EVENT_TTL_DAYS }) {
  const col = store.collection('core__usage');
  const events = store.collection('core__usage_events');
  const empty = () => ({ month: monthKey(now()), inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, usd: 0 });
  const current = doc => (doc && doc.month === monthKey(now()) ? doc : empty());

  const forUser = userId => ({
    async get() { return { ...current(await col.get(userId)), capUsd }; },
    async check() {
      if (current(await col.get(userId)).usd >= capUsd) throw new BudgetExceededError(capUsd, now());
    },
    async record(usage) {
      await col.update(userId, doc => {
        const u = current(doc);
        return {
          month: u.month,
          inputTokens: u.inputTokens + (usage.input_tokens || 0),
          outputTokens: u.outputTokens + (usage.output_tokens || 0),
          cacheReadTokens: u.cacheReadTokens + (usage.cache_read_input_tokens || 0),
          cacheWriteTokens: u.cacheWriteTokens + (usage.cache_creation_input_tokens || 0),
          usd: u.usd + costUsd(usage, prices),
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
    meter({ userId, userEmail, trigger = 'message', model = null }) {
      const budget = forUser(userId);
      const startedAt = now().getTime();
      const totals = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, usd: 0 };
      const tools = [];

      return {
        get totals() { return { ...totals }; },
        get tools() { return [...tools]; },

        check: () => budget.check(),

        async record(usage) {
          totals.calls += 1;
          totals.inputTokens += usage.input_tokens || 0;
          totals.outputTokens += usage.output_tokens || 0;
          totals.cacheReadTokens += usage.cache_read_input_tokens || 0;
          totals.cacheWriteTokens += usage.cache_creation_input_tokens || 0;
          totals.usd += costUsd(usage, prices);
          await budget.record(usage);
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
          if (!totals.calls && !tools.length) return null;
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
            model,
            calls: totals.calls,
            ...totals,
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
