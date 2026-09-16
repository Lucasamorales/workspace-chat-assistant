# Buddy security model

## What Buddy can and cannot do
- **Can:** chat with Claude; read files users upload; act in Asana **as the user who asks**,
  within that user's own Asana permissions, only in a direct message.
- **Cannot:** browse, run code, touch any file system, or reach any service not built as a
  module. Users cannot add tools; adding one is a code change and a deploy.

## Controls

| Risk | Control | Where |
|---|---|---|
| Someone other than Google Chat calls the bot | Cloud Run IAM allows only `chat@system.gserviceaccount.com`; the app also verifies Google's signed JWT (audience + issuer) | `infra/deploy.sh`, `core/chat-verify.js` |
| Someone outside the pilot uses Buddy | Chat app visibility + `BUDDY_ALLOWED_USERS` allowlist checked on every event | Chat console, `chat-gateway/handler.js` |
| Account hijack via the connect link (bug in the old bot) | Link created inside Chat for the verified user; signed; server-side session; single use; 10 min expiry; PKCE; Asana email must match the Google email | `core/oauth-flows.js`, `asana/tokens.js` |
| Asana token theft from the database | Tokens encrypted with Cloud KMS, bound to module + user; the OAuth service can encrypt but never decrypt | `core/sealer.js`, `infra/setup.sh` |
| Token sent somewhere other than Asana | MCP URL hard-restricted to `https://mcp.asana.com` | `asana/toolset.js` |
| Claude changes or deletes Asana data unexpectedly (incl. prompt injection from a file or task) | Every tool not explicitly read-only stops the loop **before running**; the user sees exactly what will be sent and must click Approve. Approvals are single-use, owner-only, expire in 15 min | `core/agent-loop.js`, `chat-gateway/cards.js` |
| Duplicate event runs an action twice | Each Chat message id is processed once | `chat-gateway/handler.js` |
| One person's Asana data shown to a group | Asana module disabled in spaces and group chats | `asana/index.js` (`allowedIn: ['DM']`) |
| Malicious uploads | 10 MB limit enforced while downloading; zip-bomb check before parsing .xlsx; maintained parser; files never stored | `files/` |
| Runaway cost | Per-user monthly cap checked before **every** Claude call; max 12 steps per request | `core/usage.js`, `core/agent-loop.js` |
| Over-privileged runtime | Dedicated service accounts with only Firestore, specific secrets and KMS; Editor removed from the default account after cutover | `infra/setup.sh`, `infra/decommission-legacy.sh` |
| Leaking secrets in logs or errors | Credential-looking fields redacted; users see a reference code, never raw errors | `core/log.js`, `chat-gateway/handler.js` |
| Data kept forever | Firestore TTL: threads 30 days, approvals 15 min, login sessions 10 min, event ids 1 day | `infra/setup.sh` |
| Broken deploys (old revision 24) | Deploy refuses failing tests or uncommitted files; sets every setting every time; verifies access rules afterwards | `infra/deploy.sh` |

## Data flows
- Message text, file contents and Asana tool results → Anthropic API (standard retention).
- Asana token → only `mcp.asana.com`, from `buddy-bot`. Never sent to Anthropic.
- Stored in Firestore (`eur3`): 30-day thread text, monthly usage counters, encrypted
  Asana tokens, short-lived approval and login records.

## Known limits
- If Asana's token response doesn't include an email, the account-match check is skipped
  (logged as a warning).
- Approval covers the exact tool call; it can't judge whether the call is *wise*. Read the card.
- Chat app visibility is set in the console and isn't in code; the in-code allowlist is the backstop.
