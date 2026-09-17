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

function createUsage({ store, prices, capUsd, now = () => new Date() }) {
  const col = store.collection('core__usage');
  const empty = () => ({ month: monthKey(now()), inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, usd: 0 });
  const current = doc => (doc && doc.month === monthKey(now()) ? doc : empty());

  return {
    forUser(userId) {
      return {
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
      };
    },
  };
}

module.exports = { createUsage, costUsd, BudgetExceededError };
