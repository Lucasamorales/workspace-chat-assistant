# Buddy

Your company's assistant inside **Google Chat**. People talk to Buddy like a colleague: ask
questions, send files, and work in **Asana** as themselves — with every change shown for
approval before it happens.

Buddy is a small core plus independent **modules**. Each module (Asana, files, …) has its own
code, data, settings and tests, so a change to one can't break another. Kudos and OOO are
next ([backlog](docs/BACKLOG.md)).

> **Status:** pilot, live as the Chat app **Buddy-Asana** for robin@ and remy@. It will be
> renamed **Buddy** when Kudos and OOO move in.

---

## Contents

- [What users can do](#what-users-can-do)
- [How it works](#how-it-works)
- [Repository layout](#repository-layout)
- [Modules](#modules)
- [Security](#security)
- [Local development](#local-development)
- [Deployment](#deployment)
- [Configuration](#configuration)
- [Adding a module](#adding-a-module)
- [Conventions](#conventions)
- [Documentation](#documentation)

---

## What users can do

Everything works with buttons; slash commands are still there for power users.

| | In a private chat with Buddy | In a space (mention `@Buddy`) |
|---|---|---|
| Ask anything | ✅ | ✅ |
| Send a PDF, image, spreadsheet or text file and ask about it | ✅ | ✅ |
| Asana: read, create, update, delete — as yourself | ✅ | ❌ (privacy: replies are visible to everyone) |

### Connecting Asana
The first time a request needs Asana, Buddy replies with a card: **Connect Asana** opens
Asana's consent page, and **I've connected, continue** runs the original request — no
retyping. If a connection stops working later, Buddy shows a **Reconnect** card instead of
an error.

### Approving changes
Anything that could change Asana stops first and shows a card:

```
Review before Buddy makes changes
Nothing will change until you click Approve.

Change 1 of 2 · Create task
  Task title:   Prepare Q4 report
  Due date:     Fri 24 Oct 2026
  Assignee:     You
  [Approve] [Cancel]

Change 2 of 2 · Create task
  …
  [Approve] [Cancel]

[Approve all] [Cancel all]
This request expires at 14:32 (15 minutes). After that, just send your message again.
```

Reads (searching tasks, "what's due today") run without asking. Deletes are marked
*cannot be undone*. Only the person who asked can approve, and each change runs at most once.

### Commands (optional)
| Command | What it does |
|---|---|
| `/help` | Examples and buttons |
| `/asana connect \| status \| tools \| disconnect` | Manage the Asana connection; `tools` lists which actions run freely and which ask first |
| `/usage` | Your Claude spend this month |
| `/status` | Which connections are active |
| `/reset` | Forget the current conversation |

---

## How it works

```
Google Chat ──(signed request)──► buddy-bot  (Cloud Run, private: only Google Chat may call it)
                                     │
                                     ├── Claude (Anthropic API) ── decides what to do
                                     ├── Asana MCP server ──────── Buddy is the MCP client; token never leaves our project except to Asana
                                     ├── Firestore ─────────────── conversations (30 days), usage, approvals, encrypted tokens
                                     └── Cloud KMS ─────────────── encrypts Asana tokens

Browser ──► buddy-oauth (Cloud Run, public: only the "connect your account" pages)
```

1. Google Chat sends each message to **buddy-bot** with a signed token; Cloud Run IAM and the
   app both verify it comes from Google Chat.
2. The bot checks the allowlist, then either runs a command or starts a conversation.
3. Claude gets the tools of every module active for that user and place. Read-only tools run
   immediately. Anything else **pauses the loop** and becomes an approval card; the paused
   state is saved in Firestore, so a click minutes later on another instance resumes it.
4. Replies are posted back through the Chat API.

One Docker image serves both services; the start command is chosen at deploy time.

---

## Repository layout

```
apps/
  chat-gateway/        buddy-bot: Google Chat webhook, cards, approvals, button handling
  oauth-gateway/       buddy-oauth: /auth/<module>/start and /callback, nothing else
packages/
  core/                shared building blocks — the only code modules and apps share
    src/agent-loop.js    Claude tool loop with the approval pause/resume
    src/registry.js      loads modules, isolates failures, builds the toolset
    src/module-contract.js  the interface every module implements
    src/oauth-flows.js   signed single-use connect links with PKCE
    src/sealer.js        KMS encryption bound to module + user
    src/store.js         storage interface (Firestore in prod, memory in tests)
    …                    config validation, logging, usage/budget, threads, Chat client
modules/
  basics/              /help /usage /status /reset
  files/               attachments → content Claude can read
  asana/               Asana via MCP: connect, tools, approval descriptions
infra/                 setup, deploy and decommission scripts; config.env; Cloud Build
docs/                  runbook, security model, backlog, decisions
legacy/bot-rev23/     the original bot, kept read-only for reference
```

---

## Modules

| Module | Where | Who (default) | Needs | Stores |
|---|---|---|---|---|
| **basics** | DMs + spaces | everyone @example.com | — | — |
| **files** | DMs + spaces | everyone @example.com | — | nothing (files are processed in memory) |
| **asana** | DMs only | robin@, remy@ | `ASANA_CLIENT_ID`, `ASANA_CLIENT_SECRET` | `m_asana__tokens` (KMS-encrypted) |
| **kudos** | *planned* ([backlog](docs/BACKLOG.md)) | everyone; admins for audits | | |

### Permissions per module
Two layers, both checked on every event:

1. **`ALLOWED_USERS`** — who may talk to Buddy at all.
2. **`BUDDY_ACCESS_<MODULE>`** — who may use each module. **Required** for every enabled module;
   the service refuses to start without it. Modules can also declare **roles** (e.g. Kudos
   `admin`), configured as `BUDDY_ROLE_<MODULE>_<ROLE>`.

Entries are comma-separated: `robin@example.com`, `users/<chat id>`, or
`domain:example.com`. A module (or role-restricted command) someone can't use is
invisible to them: no commands, no help entries, no tools for Claude, no message handling.

Rules every module follows:

1. **Never import another module.** Everything a module may use arrives in `ctx`.
2. **Own dependencies** in its own `package.json`.
3. **Own data and settings:** storage is scoped to `m_<name>__*`; settings to `<NAME>_*`.
4. **Failures are contained:** every hook runs with a timeout and try/catch; if Asana is down,
   the rest of Buddy keeps working.
5. **Own tests,** runnable on their own: `npm test --workspace @buddy/module-asana`.
6. **Switchable:** enabled modules are listed in `BUDDY_MODULES`.

---

## Security

Full model: [docs/SECURITY.md](docs/SECURITY.md). Highlights:

- **Only Google Chat can reach the bot** (Cloud Run IAM + JWT issuer/audience check). The only
  public service serves the connect pages.
- **Allowlist and per-module access** checked on every event, on top of the Chat app's
  visibility setting. Missing access rules stop the service instead of opening a module up.
- **Connect links** are created for the verified Chat user, signed, single-use, expire after
  1 hour, use PKCE, and the Asana account's email must match the Google account.
- **Asana tokens** are encrypted with Cloud KMS and bound to module + user; they are only ever
  sent to `mcp.asana.com`. The public OAuth service can encrypt tokens but never read them.
- **Human approval** for every non-read-only action, enforced in code — not by the prompt.
- **Least privilege:** dedicated service accounts (`buddy-bot`, `buddy-oauth`, `buddy-build`)
  with access only to what they use.
- **Data retention:** conversations auto-delete after 30 days; approvals, login sessions and
  saved requests after minutes to a day.
- **Deploy safety:** deploys refuse failing tests or uncommitted files and verify access rules.

---

## Local development

Requirements: **Node 22+**, npm, and Docker (optional, to build the image).

```powershell
npm install
npm test
```

`npm test` runs every workspace's tests with Node's built-in runner. Tests use in-memory
storage, a local encryption key and fake Chat/Claude/Asana clients — no cloud access or
API keys needed.

Run one package's tests:

```powershell
npm test --workspace @buddy/core
npm test --workspace @buddy/module-asana
```

Build and start the bot image locally (it refuses to start until every required setting is
present, and lists what's missing):

```powershell
docker build -t buddy:local .
docker run --rm buddy:local
```

---

## Deployment

Target: Google Cloud project `your-gcp-project`, region `europe-west1`.
Step-by-step instructions, the Chat console settings, the acceptance checklist and
troubleshooting are in **[docs/RUNBOOK.md](docs/RUNBOOK.md)**.

In short:

```powershell
# one time: service accounts, KMS key, secrets, image repo, auto-delete policies
& "C:\Program Files\Git\bin\bash.exe" infra/setup.sh

# every release (commit first; the script refuses uncommitted changes)
& "C:\Program Files\Git\bin\bash.exe" infra/deploy.sh
```

`deploy.sh` runs the tests, builds the image with Cloud Build, deploys `buddy-oauth` and
`buddy-bot` with **every** setting, and checks that the bot is private and the old login
trick is rejected.

Use Git Bash (the path above) from PowerShell — plain `bash` on Windows opens WSL, which
doesn't have `gcloud`. In Google Cloud Shell, run `bash infra/deploy.sh` directly.

---

## Configuration

Deployment settings live in [`infra/config.env`](infra/config.env) (no secrets). Secrets live
in Secret Manager and are mounted at deploy time.

| Setting | Where | Purpose |
|---|---|---|
| `ALLOWED_USERS` | config.env | Who may talk to Buddy at all (also set Chat app visibility) |
| `BUDDY_ACCESS_<MODULE>` | config.env | Who may use each module (required per enabled module) |
| `BUDDY_ROLE_<MODULE>_<ROLE>` | config.env | Who holds a module role, e.g. `BUDDY_ROLE_KUDOS_ADMIN` |
| `APP_NAME` | config.env | Name used in messages; match the Chat app name |
| `MODULES` | config.env | Enabled modules, e.g. `basics,files,asana` |
| `MODEL`, `EFFORT` | config.env | Claude model and effort level |
| `MONTHLY_USD_CAP` | config.env | Per-user monthly spend limit |
| `USD_PER_MTOK_IN` / `_OUT` | config.env | Prices used for the spend limit |
| `ASANA_CLIENT_ID` | config.env | Asana **MCP app** client ID (not secret) |
| `anthropic-key` | Secret Manager | Anthropic API key |
| `asana-mcp-client-secret` | Secret Manager | Asana MCP app client secret |
| `buddy-state-secret` | Secret Manager | Signs connect links (generated by `setup.sh`) |

Optional module settings: `ASANA_READONLY_TOOLS` (tools that may skip approval),
`ASANA_REQUIRE_EMAIL_MATCH` (default `true`), `FILES_MAX_BYTES`, `FILES_MAX_TEXT_CHARS`.

Services validate settings at startup and refuse to run with a missing or malformed value.

---

## Adding a module

1. Copy `modules/basics` to `modules/<name>` and rename the package to `@buddy/module-<name>`.
2. Implement the parts of the [module contract](packages/core/src/module-contract.js) you need:

   | Hook | Use it for |
   |---|---|
   | `commands` | Slash commands; replies can be text or a card with buttons; `role` restricts a command |
   | `handleMessage` | Handle a message directly without Claude (e.g. a kudos vote); gets mentions, space and sender |
   | `roles` | Module roles such as `admin`; check with `ctx.hasRole('admin')` |
   | `tools(ctx)` | Actions Claude can take; mark read-only ones with `needsApproval → false` |
   | `split`, `describe` | Break batches into approvable items and describe them in plain language |
   | `readAttachment` | Understand uploaded files |
   | `oauth`, `connected`, `quickActions` | Per-user account connection with buttons |
   | `instructions`, `examples` | Guidance for Claude; examples for the help card |
   | `allowedIn` | `['DM']`, `['SPACE']` or both |
   | `settings` | Required env vars, all prefixed `<NAME>_` |

3. Add tests in `modules/<name>/test/`.
4. Add the package as a dependency of the gateways that load it, add the name to `MODULES` in
   `infra/config.env` together with its `BUDDY_ACCESS_<NAME>` rule (and any role rules), and pass
   any new settings/secrets in `infra/deploy.sh`.
5. `npm test`, commit, deploy.

---

## Conventions

- **Commits:** `feat:`, `fix:`, `chore:`, `wip:`, `docs:`, `devops:`. Use `feat`/`fix`/`devops`
  only once the change is verified working or explicitly approved.
- **Comments** explain *why*, not what.
- **No AI attribution** anywhere in code, docs or commit messages.
- **Terminal:** Windows PowerShell 5.1 by default — no `&&`; use `;` or separate commands.

Details: [CLAUDE.md](CLAUDE.md).

---

## Documentation

| Doc | What's in it |
|---|---|
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | Setup, Asana app, deploy, Chat console, acceptance checklist, operations, troubleshooting |
| [docs/SECURITY.md](docs/SECURITY.md) | Threats, controls, data flows, known limits |
| [docs/BACKLOG.md](docs/BACKLOG.md) | What's next: Kudos, OOO, per-module permissions, App Home |
| [docs/decisions/](docs/decisions/) | Recorded decisions (scope, security, naming) |
| [legacy/bot-rev23/](legacy/bot-rev23/) | The original bot and its docs, for reference |
