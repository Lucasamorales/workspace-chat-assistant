/**
 * Usage events → the numbers a manager asks for.
 *
 * Pure functions over plain event objects: no Google, no Firestore, no clock of their own, so
 * every figure below is testable against a handful of events.
 */

const money = usd => (usd >= 1 ? `$${usd.toFixed(2)}` : `${(usd * 100).toFixed(1)}¢`);
const round = (n, places = 4) => Number(n.toFixed(places));

const EMPTY = () => ({
  requests: 0, calls: 0, toolCalls: 0, usd: 0,
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  failed: 0, refused: 0, declined: 0, expired: 0, ms: 0,
});

function add(into, event) {
  into.requests += 1;
  into.calls += event.calls || 0;
  into.toolCalls += (event.tools || []).length;
  into.usd += event.usd || 0;
  into.inputTokens += event.inputTokens || 0;
  into.outputTokens += event.outputTokens || 0;
  into.cacheReadTokens += event.cacheReadTokens || 0;
  into.cacheWriteTokens += event.cacheWriteTokens || 0;
  into.ms += event.ms || 0;
  if (event.outcome === 'failed') into.failed += 1;
  if (event.outcome === 'refused') into.refused += 1;
  if (event.outcome === 'declined') into.declined += 1;
  if (event.outcome === 'expired') into.expired += 1;
  return into;
}

/** Group by any field of the event, biggest spend first. */
function groupBy(events, key) {
  const groups = new Map();
  for (const event of events) {
    const name = event[key] || 'unknown';
    if (!groups.has(name)) groups.set(name, EMPTY());
    add(groups.get(name), event);
  }
  return [...groups.entries()]
    .map(([name, totals]) => ({ name, ...totals }))
    .sort((a, b) => b.usd - a.usd);
}

/** Every tool that ran, with how often it failed. */
function byTool(events) {
  const tools = new Map();
  for (const event of events) {
    for (const tool of event.tools || []) {
      if (!tools.has(tool.name)) tools.set(tool.name, { name: tool.name, calls: 0, failed: 0 });
      const t = tools.get(tool.name);
      t.calls += 1;
      if (tool.failed) t.failed += 1;
    }
  }
  return [...tools.values()].sort((a, b) => b.calls - a.calls);
}

/**
 * What was spent on requests that produced nothing, plus the cache picture.
 *
 * Cache reads are charged at a tenth of the input price and writes at a quarter more, so a
 * conversation that keeps missing the cache pays for the same history again and again. The
 * hit rate is the share of repeated context that was read from cache rather than re-sent.
 */
function waste(events) {
  const wasted = events.filter(e => ['failed', 'refused', 'declined', 'expired'].includes(e.outcome));
  const cacheRead = events.reduce((n, e) => n + (e.cacheReadTokens || 0), 0);
  const cacheWrite = events.reduce((n, e) => n + (e.cacheWriteTokens || 0), 0);
  const cached = cacheRead + cacheWrite;
  return {
    requests: wasted.length,
    usd: wasted.reduce((n, e) => n + (e.usd || 0), 0),
    byOutcome: groupBy(wasted, 'outcome'),
    cacheRead,
    cacheWrite,
    cacheHitRate: cached ? cacheRead / cached : null,
  };
}

/** The Monday of an event's week, in the reporting time zone, as YYYY-MM-DD. */
function weekOf(iso, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(iso));
  const get = type => Number(parts.find(p => p.type === type).value);
  const day = new Date(Date.UTC(get('year'), get('month') - 1, get('day')));
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7)); // back to Monday
  return day.toISOString().slice(0, 10);
}

/** One row per person per module per week — the Sheet's shape. */
function weeklyRows(events, timeZone, writtenAt) {
  const rows = new Map();
  for (const event of events) {
    const week = weekOf(event.at, timeZone);
    const key = `${week}|${event.userEmail}|${event.module}`;
    if (!rows.has(key)) rows.set(key, { week, person: event.userEmail, module: event.module, ...EMPTY() });
    add(rows.get(key), event);
  }
  return [...rows.values()]
    .sort((a, b) => a.week.localeCompare(b.week) || a.person.localeCompare(b.person) || a.module.localeCompare(b.module))
    .map(r => [
      r.week, r.person, r.module, r.requests, r.toolCalls,
      r.inputTokens, r.outputTokens, r.cacheReadTokens, r.cacheWriteTokens,
      round(r.usd), r.failed, r.declined + r.expired, r.refused, writtenAt,
    ]);
}

const totals = events => events.reduce((acc, e) => add(acc, e), EMPTY());

module.exports = { groupBy, byTool, waste, weeklyRows, weekOf, totals, money, round, EMPTY };
