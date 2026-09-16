# Buddy

Your company's assistant inside Google Chat. Talk to Buddy in a DM, or `@Buddy` in a space.
Buddy is a small core plus independent **modules** (Asana, files, …). A change to one
module must never break another.

Status: **built and tested locally, not deployed yet.** The live bot is still Remy's
`legacy-chat-bot`; its code is kept read-only in `legacy/bot-rev23/`.

- How to set up, deploy and verify: [docs/RUNBOOK.md](docs/RUNBOOK.md)
- Security model: [docs/SECURITY.md](docs/SECURITY.md)
- Decisions: [docs/decisions/](docs/decisions/)
- Tests: `npm install && npm test`

## Layout

```
apps/                     deployables (Cloud Run services) — thin, no business logic
  chat-gateway/           buddy-bot:   Google Chat webhook. IAM-locked to Chat only.
  oauth-gateway/          buddy-oauth: public; serves only /auth/<module>/start|callback
packages/
  core/                   the only shared code: config, logging, storage, encryption,
                          Chat replies, Claude client, module contract + registry
modules/
  basics/                 /help /usage /reset, welcome message
  files/                  attachments: PDF, images, spreadsheets, text
  asana/                  Asana via MCP: /connect /disconnect /status + tools
infra/                    deploy + IAM + Firestore TTL scripts (every setting, every deploy)
docs/                     RUNBOOK, SECURITY, decisions/
legacy/bot-rev23/        the original code and docs, untouched
```

## Module isolation rules

1. **Modules never import each other.** They import only `@buddy/core`.
2. **Each module owns its dependencies** (its own `package.json`). Upgrading an Asana
   library cannot change the files module.
3. **Each module owns its data**: Firestore under `modules/<name>/…`, its own secrets,
   its own settings prefix (`ASANA_*`). Core never reads a module's data.
4. **Each module is switchable**: `BUDDY_MODULES=basics,files,asana`. Removing a name
   removes the module entirely — commands, tools, routes.
5. **Failures are contained**: the registry calls every module hook inside a timeout
   and try/catch. If Asana is down, Buddy says so and everything else keeps working.
6. **Each module has its own tests**, and they run without the others installed.
7. **The contract is the only coupling** — see `packages/core/src/module-contract.js`.
   Changing the contract is a core change and needs every module's tests to pass.

Today all modules ship in one container (cheapest). Because of the rules above, any
module can later be moved to its own Cloud Run service without rewriting it.

## Adding a module

Copy `modules/basics`, rename, implement the contract, add it to `BUDDY_MODULES`.
No changes to core or to other modules.
