/**
 * Settings are validated once at startup. A bad value stops the service from starting
 * instead of silently misbehaving (the original bot ran for days with MAX_TURNS=20~ → NaN).
 */

function loadConfig(spec, env = process.env) {
  const out = {};
  const problems = [];

  for (const [key, rule] of Object.entries(spec)) {
    const raw = env[key];
    if (raw === undefined || raw === '') {
      if (rule.required) problems.push(`${key} is required`);
      else out[key] = rule.default;
      continue;
    }

    switch (rule.type) {
      case 'number': {
        const n = Number(raw);
        if (!Number.isFinite(n)) problems.push(`${key} must be a number, got "${raw}"`);
        else if (rule.min !== undefined && n < rule.min) problems.push(`${key} must be >= ${rule.min}`);
        else out[key] = n;
        break;
      }
      case 'list':
        out[key] = raw.split(',').map(s => s.trim()).filter(Boolean);
        break;
      case 'url': {
        let url;
        try { url = new URL(raw); } catch { problems.push(`${key} must be a URL, got "${raw}"`); break; }
        if (url.protocol !== 'https:' && !rule.allowHttp) problems.push(`${key} must use https`);
        else if (raw.endsWith('/')) problems.push(`${key} must not end with a slash`);
        else out[key] = raw;
        break;
      }
      case 'enum':
        if (!rule.values.includes(raw)) problems.push(`${key} must be one of ${rule.values.join(', ')}`);
        else out[key] = raw;
        break;
      case 'secret':
        if (rule.minLength && raw.length < rule.minLength) problems.push(`${key} must be at least ${rule.minLength} characters`);
        else out[key] = raw;
        break;
      default:
        out[key] = raw;
    }
  }

  if (problems.length) {
    throw new Error(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
  }
  return Object.freeze(out);
}

/**
 * "manual:claude-haiku-4-5:low" → { manual: { model, effort } }.
 * A blank field keeps the service default, so `manual::low` only changes the effort.
 */
function parseTuning(entries = []) {
  const out = {};
  for (const entry of entries) {
    const [name, model, effort] = String(entry).split(':').map(s => s.trim());
    if (!name) continue;
    out[name] = { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
  }
  return out;
}

/**
 * "claude-haiku-4-5:1:5" → { 'claude-haiku-4-5': { inPerMTok: 1, outPerMTok: 5 }, default }.
 * A model with no entry is priced at the default: an unknown model must look expensive, never free.
 */
function parsePrices(entries = [], defaults) {
  const out = { default: defaults };
  for (const entry of entries) {
    const [model, input, output] = String(entry).split(':').map(s => s.trim());
    if (!model || !input || !output || !Number.isFinite(Number(input)) || !Number.isFinite(Number(output))) {
      throw new Error(`MODEL_PRICES entry "${entry}" must look like model:inPerMTok:outPerMTok`);
    }
    out[model] = { inPerMTok: Number(input), outPerMTok: Number(output) };
  }
  return out;
}

module.exports = { loadConfig, parseTuning, parsePrices };
