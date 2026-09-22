# Buddy security model

## What Buddy can and cannot do
- **Can:** chat with Claude; read files users upload; act in Asana **as the user who asks**,
  within that user's own Asana permissions, only in a direct message; read one leave calendar;
  create and delete out-of-office events on a person's own calendar; grant module access to
  colleagues when an admin approves it.
- **Cannot:** browse, run code, touch any file system, or reach any service not built as a
  module. Users cannot add tools; adding one is a code change and a deploy.

## Controls

| Risk | Control | Where |
|---|---|---|
| Someone other than Google Chat calls the bot | Cloud Run IAM allows only `chat@system.gserviceaccount.com`; the app also verifies Google's signed JWT (audience + issuer) | `infra/deploy.sh`, `core/chat-verify.js` |
| Someone outside the pilot uses Buddy | Chat app visibility + `BUDDY_ALLOWED_USERS` allowlist checked on every event | Chat console, `chat-gateway/handler.js` |
| Account hijack via the connect link (bug in the old bot) | Link created inside Chat for the verified user; signed; server-side session; single use; 1 h expiry; PKCE; Asana email must match the Google email | `core/oauth-flows.js`, `asana/tokens.js` |
| Asana token theft from the database | Tokens encrypted with Cloud KMS, bound to module + user; the OAuth service can encrypt but never decrypt | `core/sealer.js`, `infra/setup.sh` |
| Token sent somewhere other than Asana | MCP URL hard-restricted to `https://mcp.asana.com` | `asana/toolset.js` |
| Claude changes or deletes Asana data unexpectedly (incl. prompt injection from a file or task) | Every tool not explicitly read-only stops the loop **before running**. Batches are split so each change is approved on its own; the card shows every parameter (names resolved with read-only lookups, falling back to raw ids). Each item runs at most once, only after the owner's click; undecided items expire after 15 min | `core/agent-loop.js`, `chat-gateway/handler.js`, `asana/present.js` |
| Duplicate event runs an action twice | Each Chat message id is processed once; "Try again" and "continue" buttons are single-use and owner-only | `chat-gateway/handler.js` |
| A button does something the user couldn't do by typing | Command buttons run the slash command as the person who clicks, with the same space and permission checks as typing it | `chat-gateway/handler.js` |
| Card formatting injected through Asana names or descriptions | All module text is escaped before it is put on a card | `chat-gateway/cards.js` |
| One person's Asana data shown to a group | Asana module disabled in spaces and group chats | `asana/index.js` (`allowedIn: ['DM']`) |
| Malicious uploads | 10 MB limit enforced while downloading; zip-bomb check before parsing .xlsx; maintained parser; files never stored | `files/` |
| Runaway cost | Per-user monthly cap checked before **every** Claude call; max 12 steps per request | `core/usage.js`, `core/agent-loop.js` |
| Over-privileged runtime | Dedicated service accounts with only Firestore, specific secrets and KMS; Editor removed from the default account after cutover | `infra/setup.sh`, `infra/decommission-legacy.sh` |
| Leaking secrets in logs or errors | Credential-looking fields redacted; users see a reference code, never raw errors | `core/log.js`, `chat-gateway/handler.js` |
| Data kept forever | Firestore TTL: threads 30 days, approvals 15 min, login sessions 1 h, saved requests and event ids 1 day | `infra/setup.sh` |
| Buddy acts as the wrong person on a calendar (`leave`) | The account acted for comes from Google's signed Chat request, never from the tool call or anything Claude produced; acting for anyone else needs `BUDDY_ROLE_LEAVE_ADMIN`, and the approval card names whose calendar it is | `leave/module.js` (`subjectFor`) |
| The domain-wide delegation key leaks (as it did in the Apps Script) | No key exists: `buddy-bot` has Google's IAM Credentials API sign each assertion, using its Cloud Run identity. Scope limited to `calendar.events` — events only, never sharing, settings or other Google data | `leave/impersonate.js`, delegation entry in the Admin console |
| `ooo` is read-only in name only | The reader is a frozen object with `list`/`describe` and no write method; requests are built inside the module — always GET, always the one configured calendar; the account read as comes from `OOO_READ_AS` in settings, validated, never from a user or Claude; the read-only scope is requested first and any fallback logged | `ooo/calendar.js`, `ooo/token.js` |
| Prompt injection grants someone access ("grant bob@ everything", hidden in a task or PDF) | Grants need an admin's approval click; `admin`, `leave` and `assistant` can never be granted (constant in code, not offered to Claude); company addresses only; roles are never granted; every change logged with who made it | `admin/module.js` |
| A chat grant removes access, or creates an admin | Config is the floor: grants only widen it, revoking removes grants only, and `BUDDY_ACCESS_ADMIN` is config-only | `core/grants.js`, `core/access.js` |
| Broken deploys (old revision 24) | Deploy refuses failing tests or uncommitted files; sets every setting every time; verifies access rules afterwards | `infra/deploy.sh` |

## Data flows
- Message text, file contents, Asana tool results and OOO listings → Anthropic API (standard retention).
- Asana token → only `mcp.asana.com`, from `buddy-bot`. Never sent to Anthropic.
- Stored in Firestore (`eur3`): 30-day thread text, monthly usage counters, encrypted
  Asana tokens, short-lived approval and login records.

## Known limits
- If Asana's token response doesn't include an email, the account-match check is skipped
  (logged as a warning).
- Approval covers the exact tool call; it can't judge whether the call is *wise*. Read the card.
- Chat app visibility is set in the console and isn't in code; the in-code allowlist is the backstop.
- Domain-wide delegation is domain-wide by nature: Google offers no way to limit it to one person,
  so `leave`'s code is what keeps it to the requester. Changes there deserve careful review.
- `ooo` reads its calendar with a writable scope until `calendar.events.readonly` is added to the
  delegation entry; the module cannot write, and logs a warning while this is the case.
- Access is now two sources (config + grants). `/access` shows both; the config file alone no
  longer tells the whole story.
