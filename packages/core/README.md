# packages/core (`@buddy/core`)

Everything the apps and modules share, and the only thing a module is allowed to depend on.
A module never imports another module, Firestore, KMS or the Chat API directly: it receives a
`ctx` built here, scoped to itself.

| File | What it is |
|---|---|
| `module-contract.js` | The module contract: the only coupling between core and a module, validated at startup |
| `registry.js` | Loads modules and is the only place core calls into them, with timeouts and error isolation |
| `context.js` | Builds the `ctx` a module receives: scoped storage, settings and encryption |
| `access.js`, `grants.js` | Who may use what: rules from configuration, plus access granted from chat |
| `agent-loop.js`, `claude.js` | The Claude tool loop with its human-approval gate, and the one place that calls the Anthropic API |
| `usage.js` | Per-person monthly spend and the budget cap checked before every Claude call |
| `threads.js` | Conversation memory per Chat thread, capped and expiring |
| `store.js` | The storage interface, over Firestore in production and in memory in tests |
| `sealer.js` | Encryption for stored OAuth tokens, bound to the user and module they belong to |
| `oauth-flows.js`, `signed-token.js` | OAuth for modules, and the short-lived signed tokens it uses |
| `chat-client.js`, `chat-verify.js` | Calls to the Chat API, and verification that a request really came from Chat |
| `people.js` | Each person's Chat id and DM, learnt as they write, for scheduled messages |
| `config.js`, `log.js` | Settings validated once at startup, and structured logs with credentials redacted |

How to write a module against this package: [`docs/BUILDING-FOR-BUDDY.md`](../../docs/BUILDING-FOR-BUDDY.md).

Tests are in `test/` and run with `npm test --workspace @buddy/core`.
