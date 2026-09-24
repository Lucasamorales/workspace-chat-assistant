const test = require('node:test');
const assert = require('node:assert');
const { parseTuning, parsePrices } = require('../src/config');

test('tuning: a module gets its own model and effort', () => {
  assert.deepStrictEqual(parseTuning(['manual:claude-haiku-4-5:low']), {
    manual: { model: 'claude-haiku-4-5', effort: 'low' },
  });
});

test('tuning: a blank field keeps the service default', () => {
  assert.deepStrictEqual(parseTuning(['manual::low', 'asana:claude-haiku-4-5']), {
    manual: { effort: 'low' },
    asana: { model: 'claude-haiku-4-5' },
  });
});

test('tuning: nothing configured tunes nothing', () => {
  assert.deepStrictEqual(parseTuning(), {});
  assert.deepStrictEqual(parseTuning([]), {});
});

test('prices: a configured model is priced from the file', () => {
  const prices = parsePrices(['claude-haiku-4-5:1:5'], { inPerMTok: 2, outPerMTok: 10 });
  assert.deepStrictEqual(prices['claude-haiku-4-5'], { inPerMTok: 1, outPerMTok: 5 });
  assert.deepStrictEqual(prices.default, { inPerMTok: 2, outPerMTok: 10 });
});

// An unpriced model must show up as expensive, not free, or a typo hides real spend.
test('prices: an unknown model falls back to the default, never zero', () => {
  const prices = parsePrices(['claude-haiku-4-5:1:5'], { inPerMTok: 2, outPerMTok: 10 });
  assert.strictEqual(prices['some-new-model'], undefined);
  assert.strictEqual(prices.default.inPerMTok, 2);
});

test('prices: a malformed entry stops the service starting', () => {
  const defaults = { inPerMTok: 2, outPerMTok: 10 };
  assert.throws(() => parsePrices(['claude-haiku-4-5:cheap:5'], defaults), /MODEL_PRICES/);
  assert.throws(() => parsePrices(['claude-haiku-4-5:1'], defaults), /MODEL_PRICES/);
});
