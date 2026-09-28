/**
 * Experiment logs: every step a turn takes, as JSON lines, to stdout and to a daily file.
 *
 * The file is the point. This runs on a PC, not on Cloud Run, so there is no Cloud Logging to
 * go back to afterwards, and the experiment is only worth what it records.
 *
 * What is logged is shape and timing — names, counts, milliseconds, token totals — never
 * content: prompts and tool arguments carry Asana data. Credentials are redacted by key name,
 * which is why no field here is called anything like "tokens" or "apiKey": Buddy's redactor
 * would blank it. Usage is logged as `in` / `out` / `cacheRead` / `cacheWrite`.
 */

const fs = require('fs');
const path = require('path');
const { redact } = require('@buddy/core');

function createExperimentLog({ dir = null, component = 'claude-proxy', now = () => new Date(), stdout = true } = {}) {
  if (dir) fs.mkdirSync(dir, { recursive: true });

  const make = name => {
    const write = (severity, message, fields) => {
      const at = now();
      const line = JSON.stringify({ at: at.toISOString(), severity, component: name, message, ...redact(fields || {}) });
      if (stdout) process.stdout.write(`${line}\n`);
      // Appended asynchronously: a slow disk must never hold up a reply.
      if (dir) fs.appendFile(path.join(dir, `proxy-${at.toISOString().slice(0, 10)}.jsonl`), `${line}\n`, () => {});
    };
    return {
      info: (message, fields) => write('INFO', message, fields),
      warn: (message, fields) => write('WARNING', message, fields),
      error: (message, fields) => write('ERROR', message, fields),
      child: sub => make(`${name}:${sub}`),
    };
  };
  return make(component);
}

/** A usage object in the shape the logs use, so the redactor leaves it alone. */
const usageFields = u => ({
  in: u.input_tokens || 0,
  out: u.output_tokens || 0,
  cacheRead: u.cache_read_input_tokens || 0,
  cacheWrite: u.cache_creation_input_tokens || 0,
});

module.exports = { createExperimentLog, usageFields };
