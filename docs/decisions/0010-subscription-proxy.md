# 0010 — Experiment: answering one person's Buddy on a Claude subscription

Date: 2026-09-28 · Status: **experiment**, `develop` branch only · Owner: Robin

## Context

Buddy pays per token through the API. Robin wanted to know whether the same Buddy — every
module, tool, guardrail and approval card — could run instead on the Claude Code subscription he
already pays for, for himself only, without a server that runs all the time.

The starting point was [`claude-max-api-proxy`](https://github.com/wende/claude-max-api-proxy),
which wraps the Claude CLI and puts an OpenAI-compatible API in front of it. Reading it showed
what could be borrowed and what could not:

| From the reference | Here |
|---|---|
| Run `claude --print` with `stream-json`, find `claude.exe` behind npm's `.cmd` shim, kill the whole process tree | **Taken** — reimplemented, not copied |
| OpenAI-compatible API | **Replaced** by the Anthropic Messages API Buddy already speaks, so Buddy only changes a base URL |
| The whole conversation flattened into one prompt; no caller-defined tools | **Replaced** — Buddy's value is its tools |
| `--dangerously-skip-permissions` | **Inverted** — the CLI can act on nothing |

## What the spike found (Robin's machine, CLI 2.1.283)

| Question | Answer |
|---|---|
| Native `tool_use` for our own tools? | Yes, through a stub MCP server |
| Refused tools never run? | Yes — denied automatically, the stub was never called |
| Can a tool call be held open? | Yes — the CLI waits inside the call and carries on when answered |
| Caching across processes? | Yes — a fresh process read all 7,040 tokens the last one wrote |
| Tool search? | Yes — the CLI's own `ToolSearch` loads deferred tools on demand |
| Subscription only? | `apiKeySource: none` and `isUsingOverage: false` on every run |
| History as injected turns? | **No** — ignored; the model repeated a rename it had already made |

## Decision

A proxy (`apps/claude-proxy`) runs where Claude Code is logged in and answers `POST
/v1/messages`. `buddy-bot` sends the requests of the people in `CLAUDE_PROXY_USERS` there,
through a tunnel; everyone else stays on the API. Nothing else in Buddy changes: modules, access,
scoped conversation and approval cards all run in `buddy-bot` exactly as before.

**Held sessions are the hot path.** Buddy's tools reach the CLI through a stub MCP server that
runs none of them. When the model asks for one, the CLI calls the stub and waits; the proxy
answers Buddy at once with the `tool_use`; Buddy runs the tool (behind its approval card when it
writes) and sends the result; the proxy recognises the tool-use ids and hands the result to the
waiting call, and the same process continues. History stays the process's own.

The fallbacks, each logged as one: a thread's next message continues in the process that
answered the last; a warm spare takes a new conversation; and when nothing alive knows a
conversation, it is replayed as text, with earlier tool calls spelled out as already done.

## The guarantees

**No API billing, ever — and no fallback to the API.** Four layers:

1. The CLI is launched with an allow-listed environment. No `ANTHROPIC_*` or Claude-session
   variable can reach it; the proxy refuses to start one that would carry any.
2. Every turn is refused unless the CLI reports a subscription login (`apiKeySource: none`).
3. The proxy refuses to run at all while the account has extra usage (pay-as-you-go) switched on.
   The CLI reports its window once per process, so catching overage in the act would be a race;
   with extra usage off, no reply can be billed per use.
4. `buddy-bot`'s proxy client never retries and never falls back. A request meant for the
   subscription that cannot be answered there fails, and the message says why.

**The CLI can act on nothing.** `--restricted`, `--tools ""` (or only `ToolSearch`),
`--strict-mcp-config`, `--permission-prompts none`, an empty working folder. Buddy feeds it text
other people wrote; the worst a prompt injection achieves is a tool call that comes back to Buddy,
where approval cards still gate every write — the same as on the API.

**Only the people listed, by construction.** `CLAUDE_PROXY_USERS` is a config rule like
`BUDDY_ACCESS_*`, and a test proves nobody else reaches the proxy. Empty means the experiment is
off. Every permission — allowed users, module access, roles, scoped conversation, grants,
approval cards — is still decided in `buddy-bot` per person; the proxy only ever receives the
tools and prompt that person was already allowed.

**Two people never share a process.** Buddy's prompt does not name the asker, so two accounts
with the same permissions send the same prompt and tools — and keyed on those alone, one could
continue in the process holding the other's conversation (found when a second account was
proposed). Every request now carries its owner as the API's `metadata.user_id`, an opaque hash of
the Chat user id, never an email; spares, thread continuations and held calls are per owner, a
request without one is refused, and tool results naming someone else's held call are refused
without touching it. The test for it fails with the owner taken out of the key.

**The model is told who is really asking.** The CLI adds its own context to every request,
whatever the system prompt — *"The user's email address is …"*, the email of the Claude account it
is logged into, and an environment block with the machine's folder path, date and model. There is
no switch to stop it. So with the proxy's CLI on one Claude account, every person on the proxy was
taken for that account's owner (found on the move to a second PC and a second Claude account).
`buddy-bot` now tells the model, for subscription requests only, who is really asking, and that
any other email or account in its context belongs to the machine. Checked on the real CLI: logged
in as one account and asked by another, the model named the asker; with the line removed, it named
the machine's account. The display name comes from Google Chat, so it is flattened to one short
line first. (The earlier claim that `--restricted` kept everything personal out was true of
settings and tools, not of this.)

**The proxy answers nobody without the shared secret**, compared in constant time; it binds to
localhost, and the loopback channel the stub uses is on a separate random port the tunnel never
reaches, with a per-session secret.

## Measured

Real CLI, Haiku 4.5, through the proxy:

| Turn | Time |
|---|---|
| Plain answer, cold start | 1.8–2.2s |
| Answer from a warm spare | 1.1s (the CLI ready in 21ms instead of ~700ms) |
| To a tool call | 2.3s |
| Continuing from a held call | 0.9–1.1s |
| Next message, same process | 1.2s |

Through Buddy's real handler, with an approval card: the model asked for a read-only tool and one
needing approval in one message; Buddy ran the first and carded the second; both held calls
resolved on approval; one note saved; $0 recorded, API-equivalent price and window kept.

## Consequences

- `/costs` shows subscription use apart from the API: requests, share of the five-hour and weekly
  windows, and what the API would have charged.
- Prompt caching, context compaction and tool search are the CLI's, not Buddy's settings.
- It shares Robin's window with his own Claude Code use.
- PC off, or proxy stopped: his messages fail, clearly. Nobody else is affected.
- Spares only start when there is room under `PROXY_MAX_PROCESSES` (default 4); lingering idle
  threads and held calls can starve them.

## Still to prove

- A real approval that waits minutes (the CLI's MCP timeout is set to 20).
- The whole path from Google Chat through Cloud Run and the tunnel.
- A week of real use against the API baseline: tool-call success, latency, window per request.
