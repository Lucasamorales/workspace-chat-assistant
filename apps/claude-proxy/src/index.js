/**
 * Starts the subscription proxy. Experiment only: see docs/decisions/0010-subscription-proxy.md.
 *
 * Runs on the machine where Claude Code is logged in, and answers only the one person listed in
 * buddy-bot's CLAUDE_PROXY_USERS. Bound to localhost by default; a tunnel is what makes it
 * reachable from Cloud Run, never an open port.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createExperimentLog } = require('./log');
const { resolveClaudeBin, cleanEnv, readLogin } = require('./cli');
const { createRuntime } = require('./runtime');
const { createSessions, DEFAULT_LIMITS } = require('./sessions');
const { createCallbackServer } = require('./callback');
const { createProxyApp } = require('./server');

const env = process.env;
const log = createExperimentLog({ dir: env.PROXY_LOG_DIR || path.join(__dirname, '..', 'logs') });

function fail(message) {
  log.error('cannot start', { why: message });
  process.exit(1);
}

/**
 * The shared secret, from CLAUDE_PROXY_SECRET or a file named by CLAUDE_PROXY_SECRET_FILE. The
 * file is the easier route on Windows: PowerShell 5.1 adds a line ending when it pipes text and
 * writes UTF-16 with `>`, and either would silently make the secret not match buddy-bot's.
 */
function readSecret() {
  if (env.CLAUDE_PROXY_SECRET) return env.CLAUDE_PROXY_SECRET.trim();
  if (!env.CLAUDE_PROXY_SECRET_FILE) return '';
  return fs.readFileSync(env.CLAUDE_PROXY_SECRET_FILE, 'utf8').replace(/^﻿/, '').trim();
}

async function main() {
  const secret = readSecret();
  if (secret.length < 32) fail('Set CLAUDE_PROXY_SECRET or CLAUDE_PROXY_SECRET_FILE: 32 characters or more, the same value buddy-bot uses.');
  if (env.ANTHROPIC_API_KEY) {
    // Not needed to refuse anything — the CLI never sees this environment — but a key sitting here
    // means someone expected API billing somewhere, and that should be looked at.
    log.warn('ANTHROPIC_API_KEY is set in the proxy environment; it is NOT passed to the CLI');
  }

  const bin = resolveClaudeBin(env);
  const version = spawnSync(bin, ['--version'], { encoding: 'utf8', env: cleanEnv(env), shell: false, windowsHide: true });
  if (version.status !== 0) fail(`claude at ${bin} did not run: ${(version.stderr || version.error || '').toString().slice(0, 200)}`);

  // Before accepting anything: which Claude account answers, and is it a subscription at all.
  const login = readLogin({ bin, source: env });
  if (!login.ok) fail(login.why);
  log.info('cli login', { account: login.account, plan: login.plan });

  const numberOr = (value, fallback) => (Number.isFinite(Number(value)) && value !== '' && value !== undefined ? Number(value) : fallback);
  const limits = {
    maxProcesses: numberOr(env.PROXY_MAX_PROCESSES, DEFAULT_LIMITS.maxProcesses),
    spares: env.PROXY_SPARES !== 'off',
  };

  // The sessions and the callback server need each other; the proxy wires them after both exist.
  let sessions;
  const callback = createCallbackServer({ sessions: { onStubCall: (...a) => sessions.onStubCall(...a) }, log: log.child('stub') });
  const callbackUrl = await callback.listen();
  const runtime = createRuntime({ bin, workRoot: env.PROXY_WORK_DIR || path.join(os.tmpdir(), 'buddy-claude-proxy'), callbackUrl, log });
  sessions = createSessions({ spawnSession: runtime.spawnSession, log: log.child('sessions'), limits });

  const host = env.PROXY_HOST || '127.0.0.1';
  const port = numberOr(env.PORT, 8787);
  const app = createProxyApp({ secret, sessions, log: log.child('http') });
  const server = app.listen(port, host, () => {
    log.info('proxy listening', { url: `http://${host}:${port}`, claude: bin, version: version.stdout.trim(), callback: callbackUrl, limits });
  });
  // A turn can take minutes (a long Asana loop); Node's own request timeout must not cut it off.
  server.requestTimeout = 0;
  server.timeout = 0;

  const stop = signal => {
    log.info('shutting down', { signal, ...sessions.stats() });
    sessions.shutdown();
    server.close();
    callback.close();
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch(error => fail(error.message));
