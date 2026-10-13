/**
 * Starting one CLI process for one session: its own folder, its own files, its own secret.
 *
 * Each session gets a folder with an empty working directory (the CLI's cwd — nothing in it to
 * read even if a tool somehow ran), Buddy's system prompt, the tool list, and an MCP config that
 * points the CLI at the stub server with this session's id and a random secret. The folder is
 * removed when the process ends.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnCli, killTree } = require('./cli');
const { createStreamParser } = require('./stream');

const STUB = path.join(__dirname, 'stub-mcp.js');

const RUN_DIR = /^run-(\d+)$/;

const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM'; // exists, just not ours to signal
  }
};

/**
 * A proxy that was killed never ran its cleanup: its CLIs exit with it (their input closes), but
 * their folders stay. So each proxy works in its own `run-<pid>` folder, and on startup clears the
 * folders of runs whose process is gone — never one that is still alive. (The first version swept
 * everything and, with a second proxy running, tried to delete the first one's live sessions.)
 * Only `run-<pid>` folders are ever touched, so a PROXY_WORK_DIR pointed somewhere real loses
 * nothing, and a folder Windows still holds open is skipped rather than fatal.
 */
function prepareWorkRoot(root, { log, pid = process.pid, isAlive = alive } = {}) {
  fs.mkdirSync(root, { recursive: true });
  let cleared = 0;
  for (const name of fs.readdirSync(root)) {
    const match = name.match(RUN_DIR);
    if (!match || Number(match[1]) === pid || isAlive(Number(match[1]))) continue;
    try {
      fs.rmSync(path.join(root, name), { recursive: true, force: true });
      cleared += 1;
    } catch (error) {
      if (log) log.warn('could not clear a previous run\'s folder', { folder: name, why: error.code || error.message });
    }
  }
  if (cleared && log) log.info('cleared folders left by previous runs', { count: cleared });
  const mine = path.join(root, `run-${pid}`);
  fs.mkdirSync(mine, { recursive: true });
  return mine;
}

function createRuntime({ bin, workRoot: root, callbackUrl, source = process.env, spawnImpl, nodePath = process.execPath, log = null }) {
  const workRoot = prepareWorkRoot(root, { log });

  function spawnSession(plan) {
    const id = crypto.randomUUID();
    const secret = crypto.randomBytes(24).toString('hex');
    const dir = path.join(workRoot, id);
    const cwd = path.join(dir, 'cwd');
    fs.mkdirSync(cwd, { recursive: true });

    const files = { system: path.join(dir, 'system.txt'), mcpConfig: null };
    fs.writeFileSync(files.system, plan.system || ' ');
    if (plan.tools.length) {
      const toolsFile = path.join(dir, 'tools.json');
      fs.writeFileSync(toolsFile, JSON.stringify(plan.tools));
      files.mcpConfig = path.join(dir, 'mcp.json');
      fs.writeFileSync(files.mcpConfig, JSON.stringify({
        mcpServers: {
          buddy: {
            type: 'stdio',
            command: nodePath,
            args: [STUB],
            env: { BUDDY_TOOLS_FILE: toolsFile, BUDDY_CALLBACK_URL: callbackUrl, BUDDY_SESSION: id, BUDDY_SESSION_SECRET: secret },
          },
        },
      }));
    }

    const child = spawnCli({ bin, plan, files, cwd, source, spawnImpl });
    const parser = createStreamParser();
    let tail = '';
    const exits = [];
    let exited = false;
    const exit = code => {
      if (exited) return;
      exited = true;
      parser.end();
      fs.rm(dir, { recursive: true, force: true }, () => {});
      for (const fn of exits) fn(code);
    };

    child.stdout.on('data', chunk => parser.feed(String(chunk)));
    child.stderr.on('data', chunk => { tail = (tail + chunk).slice(-2000); });
    // Writing to a process that has just died must not take the proxy down with it.
    child.stdin.on('error', () => {});
    child.on('error', error => { tail += `\n${error.message}`; exit(-1); });
    child.on('close', code => exit(code));

    return {
      id,
      token: secret,
      pid: child.pid,
      parser,
      write: line => { if (!exited) child.stdin.write(line); },
      closeInput: () => { if (!exited) child.stdin.end(); },
      kill: () => killTree(child),
      onExit: fn => exits.push(fn),
      stderrTail: () => tail,
    };
  }

  return { spawnSession };
}

module.exports = { createRuntime, prepareWorkRoot, STUB };
