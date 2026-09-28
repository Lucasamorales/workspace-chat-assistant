/**
 * Running the Claude CLI: finding it, what it may see, and what it is allowed to do.
 *
 * Three rules, each one something the spike showed:
 *
 *  - The environment is an allow-list, never inherited. A Claude session's CLAUDE_* variables
 *    would make the CLI a child of that session, and an ANTHROPIC_API_KEY would make it bill the
 *    API — the one thing this experiment exists not to do. (The auth source is also checked on
 *    every run, in sessions.js; this is the first line, not the only one.)
 *  - It runs restricted: no built-in tool except ToolSearch, none of the user's settings files,
 *    only the one MCP server we hand it, in an empty folder, with any permission prompt refused.
 *    Buddy feeds it text other people wrote — Asana tasks, uploaded files — so the CLI must never
 *    be able to act on anything; it can only ask Buddy to, and Buddy keeps its approval cards.
 *  - On Windows it is launched as claude.exe directly, not through npm's .cmd shim, because
 *    running the shim goes through cmd.exe, which reinterprets characters in the arguments.
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// What a process needs to start on Windows and find its own login. Nothing else gets through.
const KEEP_ENV = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'COMSPEC', 'ComSpec',
  'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'APPDATA', 'LOCALAPPDATA',
  'TEMP', 'TMP', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'LANG', 'TZ',
];

// The only variable of that family the proxy sets itself. Any other is refused.
const ALLOWED_EXTRA = new Set(['CLAUDE_CODE_MAX_OUTPUT_TOKENS']);
const FORBIDDEN = /^(ANTHROPIC_|CLAUDE_CODE_|CLAUDECODE$)/i;

function cleanEnv(source = process.env, extra = {}) {
  const env = {};
  for (const key of KEEP_ENV) if (source[key]) env[key] = source[key];
  const merged = { ...env, ...extra };
  // The allow-list already keeps these out; this catches a future change that adds one via `extra`.
  const leaked = Object.keys(merged).filter(k => FORBIDDEN.test(k) && !ALLOWED_EXTRA.has(k));
  if (leaked.length) throw new Error(`refusing to start the CLI with ${leaked.join(', ')} in its environment`);
  return merged;
}

/** The real claude.exe behind npm's shim, or whatever CLAUDE_BIN names. */
function resolveClaudeBin(env = process.env, { exists = fs.existsSync, read = p => fs.readFileSync(p, 'utf8'), where } = {}) {
  if (env.CLAUDE_BIN) return env.CLAUDE_BIN;
  if (process.platform !== 'win32') return 'claude';

  const direct = path.join(env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  if (exists(direct)) return direct;

  // Installed somewhere else: read the shim to find the exe it launches.
  const found = (where || (() => spawnSync('where.exe', ['claude'], { encoding: 'utf8' }).stdout || ''))();
  const shim = found.split(/\r?\n/).map(s => s.trim()).find(s => s.toLowerCase().endsWith('.cmd'));
  if (shim) {
    const match = read(shim).match(/"%dp0%\\(.+?\.exe)"/i);
    if (match) return path.join(path.dirname(shim), match[1]);
  }
  throw new Error('Could not find claude.exe. Install Claude Code, or set CLAUDE_BIN to the full path.');
}

/**
 * @param plan  from translate.planFor: model, effort, and the files a session was given
 */
function buildArgs(plan, files) {
  const args = [
    '-p',
    '--restricted',
    '--strict-mcp-config',
    '--no-session-persistence',
    // Stream JSON both ways: the process stays alive between turns, fed one message at a time.
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    // Per-call usage and stop reasons only arrive complete in the stream events.
    '--include-partial-messages',
    // Anything that would need a person to approve it is refused, never left waiting.
    '--permission-prompts', 'none',
    '--model', plan.model,
    '--system-prompt-file', files.system,
    // ToolSearch is the one built-in allowed, and only when Buddy deferred some of its tools.
    '--tools', plan.toolSearch ? 'ToolSearch' : '',
  ];
  if (plan.effort) args.push('--effort', plan.effort);
  if (files.mcpConfig) args.push('--mcp-config', files.mcpConfig, '--allowedTools', 'mcp__buddy');
  return args;
}

function envFor(plan, source = process.env) {
  return cleanEnv(source, {
    ...(plan.maxTokens ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(plan.maxTokens) } : {}),
    ...(plan.toolSearch ? { ENABLE_TOOL_SEARCH: 'true' } : {}),
    // Held tool calls wait for Buddy, and an approval card can wait fifteen minutes.
    MCP_TOOL_TIMEOUT: String(20 * 60 * 1000),
  });
}

function spawnCli({ bin, plan, files, cwd, source = process.env, spawnImpl = spawn }) {
  return spawnImpl(bin, buildArgs(plan, files), {
    cwd,
    env: envFor(plan, source),
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  });
}

/** Stop the CLI and anything it started (the stub MCP server): taskkill /T on Windows. */
function killTree(child) {
  if (!child || !child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    const r = spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    if (!r.error && r.status === 0) return;
  }
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
}

module.exports = { cleanEnv, resolveClaudeBin, buildArgs, envFor, spawnCli, killTree, KEEP_ENV };
