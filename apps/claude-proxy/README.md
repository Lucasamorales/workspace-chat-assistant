# claude-proxy — experiment

Answers the part of the Anthropic Messages API that Buddy uses by running the Claude CLI on one
person's subscription. Decision and measurements: `docs/decisions/0010-subscription-proxy.md`.
`develop` branch only.

## Run it (Windows PowerShell)

Where Claude Code is installed and logged in:

```powershell
$env:CLAUDE_PROXY_SECRET_FILE = "$HOME\.buddy\proxy-secret.txt"
node apps/claude-proxy/src/index.js
```

It listens on `http://127.0.0.1:8787`. Stop it with Ctrl+C: that ends every CLI it started.

| Setting | Default | |
|---|---|---|
| `CLAUDE_PROXY_SECRET` or `CLAUDE_PROXY_SECRET_FILE` | *(required)* | The secret `buddy-bot` sends. The file is easier on Windows |
| `PORT`, `PROXY_HOST` | `8787`, `127.0.0.1` | Keep it on localhost; a tunnel reaches it |
| `PROXY_MAX_PROCESSES` | `4` | CLIs alive at once: held calls, idle threads and spares |
| `PROXY_SPARES` | on | `off` to stop starting a warm CLI ahead of the next conversation |
| `PROXY_LOG_DIR` | `apps/claude-proxy/logs` | One JSON-lines file per day |
| `PROXY_WORK_DIR` | `%TEMP%\buddy-claude-proxy` | Per-session folders, removed when a session ends |
| `CLAUDE_BIN` | found automatically | Full path to `claude.exe` if it isn't where npm put it |

## What happens to a request

1. **A tool call is held.** The CLI sees Buddy's tools through a stub MCP server
   (`src/stub-mcp.js`). When the model asks for one, the CLI calls the stub and waits; the proxy
   returns the `tool_use` to Buddy; Buddy runs it and sends the result; the proxy hands it to
   the waiting call and the same process continues.
2. **A thread's next message** goes to the process that answered the last one, if it is alive.
3. **A new conversation** takes a warm spare if one matches, or starts a CLI.
4. **Anything else is replayed** as text into a new CLI, with earlier tool calls marked done.

## What the CLI can do: nothing

It runs `--restricted`, with no built-in tool except `ToolSearch`, only the stub's tools,
every permission prompt refused, in an empty folder, with an allow-listed environment. It never
sees an API key, and a turn is refused unless it reports a subscription login — or if the account
has extra usage switched on. See the decision record for why each of these exists.

## The logs

Every step is a JSON line with a timestamp: `request`, `starting a session` / `using a spare` /
`continuing the thread…` / `resuming a held session` / `replaying…`, `cli ready`, `api call done`
(usage per API call), `cli is waiting on a tool call`, `held call answered`, `subscription
window`, `request answered` (time, usage, window), `session ended` (why, lifetime, turns), and
`guard refused the session` at ERROR. Content is never logged — prompts and tool arguments carry
Asana data. Usage fields are `in`/`out`/`cacheRead`/`cacheWrite`, because Buddy's redactor blanks
anything named like a token.

A quick read of one day:

```powershell
Get-Content apps/claude-proxy/logs/proxy-2026-09-28.jsonl | ConvertFrom-Json | Select-Object at, message, ms, stop
```

## Tests

`node --test` in this folder. `fixtures/fake-claude.js` stands in for the CLI: same arguments,
same stream-json, and it calls the real stub through a real MCP client — only the model is fake.
