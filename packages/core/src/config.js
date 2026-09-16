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

module.exports = { loadConfig };
