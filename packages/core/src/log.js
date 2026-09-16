/**
 * Structured JSON logs (Cloud Logging reads `severity` and `message`).
 * Anything that looks like a credential is redacted before it is written.
 */

const SENSITIVE_KEY = /token|secret|authorization|password|api[-_]?key|verifier|cookie|^code$|^sealed$/i;

function redact(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (value instanceof Error) return { message: value.message, stack: value.stack };
  if (Array.isArray(value)) return value.map(v => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

function createLogger(component, sink = line => process.stdout.write(line + '\n')) {
  const write = (severity, message, fields) => {
    sink(JSON.stringify({ severity, component, message, ...redact(fields || {}) }));
  };
  return {
    info: (message, fields) => write('INFO', message, fields),
    warn: (message, fields) => write('WARNING', message, fields),
    error: (message, fields) => write('ERROR', message, fields),
    child: name => createLogger(`${component}:${name}`, sink),
  };
}

module.exports = { createLogger, redact };
