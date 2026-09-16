# Google Chat ↔ Claude bot — technical brief

**Project:** `your-gcp-project` (example.com)
**Status:** step 1 built, not yet deployed
**Owner:** Remy

---

## 1. What this is

A private Google Chat app that lets the team talk to Claude from inside Chat, and act on
Asana as themselves. It is **not** a wrapper around claude.ai — it calls the Anthropic
Messages API directly from a service we control.

Deliberate scope limit: users get chat + file analysis + Asana. They do **not** get the
Claude platform, browser control, filesystem access, or an unmetered token budget.

## 2. Architecture

```
Google Chat  ──webhook──►  Cloud Run (Node 20, europe-west1)
                                │
                                ├──► Firestore   (thread context, per-user tokens, usage)
                                ├──► Secret Manager (Anthropic API key)
                                └──► api.anthropic.com/v1/messages
                                          └──► Asana MCP (per-user OAuth token)
```

Single stateless container, `--min-instances 0`, source-deployed. No VPC, no database
beyond Firestore, no queue.

## 3. Authentication — three distinct layers

| Layer | Mechanism | Who holds the credential |
|---|---|---|
| Chat → our service | Google-signed JWT, verified with `google-auth-library`; issuer must be `chat@system.gserviceaccount.com`, audience must equal our Cloud Run URL | Google |
| Our service → Anthropic | Single org API key from Secret Manager | Your Company (never exposed to users) |
| Our service → Asana | Per-user OAuth access token, stored in Firestore under `users/{chatUserId}` | Each individual user |

Cloud Run is deployed `--no-allow-unauthenticated` with an explicit `run.invoker` binding
for Chat's service account only. Unauthenticated requests are rejected at the platform
edge before they reach our code, and rejected again in-process if the JWT fails to verify.

## 4. Identity and individuality

Every event carries `event.user.name` (a stable `users/{id}` identifier scoped to our Chat
app). That is the primary key for everything per-person:

- **Asana actions execute as the individual user**, using their own OAuth token. Asana's
  own permission model applies unchanged — someone who can't see a project through Asana's
  UI can't see it through the bot. Audit trail in Asana attributes actions to the real person.
- **Budget is per user**, not pooled. One person cannot burn the team's allowance.
- **Thread context is per thread**, keyed by SHA-1 of the Chat thread name. No cross-thread
  or cross-user context bleed.

Users who have not run `/connect` simply have no Asana tools in their request payload —
the `mcp_servers` block is omitted entirely. Tool access is opt-in per person and provable
by inspecting the outbound request.

## 5. Data — what is stored, where, for how long

| Collection | Contents | Notes |
|---|---|---|
| `threads/{sha1}` | Last N turns of conversation (`MAX_TURNS`, default 20) | Includes any text extracted from uploaded files. **No TTL policy yet — see open items.** |
| `users/{chatUserId}` | Asana OAuth token + expiry; monthly token counts and USD estimate | Token at rest in Firestore, encrypted by Google-managed keys |

Everything sits in `eur3` (European multi-region). Attachments are read into memory,
converted, sent, and discarded — nothing is written to disk or to a bucket.

**Data leaving the perimeter:** message text and file contents go to the Anthropic API.
Asana tool calls are executed by Anthropic's MCP connector against Asana's server, meaning
the user's Asana token is transmitted to Anthropic as part of the request. This is the
documented design of the connector; Anthropic runs the MCP client, we do not. Worth a
conscious sign-off rather than an assumption. Note also that the MCP connector beta is
excluded from Zero Data Retention.

## 6. Attachment handling

Chat delivers uploads either as `UPLOADED_CONTENT` (bytes via `chat.media.download`) or
`DRIVE_FILE` (a Drive reference).

- Only `UPLOADED_CONTENT` is implemented. Drive-sourced files are rejected with a message,
  because honouring them means requesting Drive scopes and per-user Drive consent — a
  materially larger access footprint that shouldn't be added silently.
- `.xlsx/.xls/.csv/.tsv` are parsed server-side with SheetJS and sent as CSV text. The
  Messages API accepts only PDF and image binaries, so a raw spreadsheet would be rejected.
- PDFs and images pass through as base64 document/image blocks.
- Everything is truncated at 200k characters to bound cost.

## 7. Cost control

- Hard monthly USD cap per user, checked **before** the API call, reset by calendar month.
- Rates are configuration (`USD_PER_MTOK_IN` / `USD_PER_MTOK_OUT`) — must be set from the
  current pricing page or the cap computes garbage.
- `MAX_TURNS` bounds context growth; `/reset` lets a user drop it manually.
- `max_tokens: 4000` per response.

## 8. Threat model — what's structurally impossible here

Worth stating plainly, because it's the reason for building this rather than handing out
platform seats:

- **No computer use, no browser control, no local filesystem.** Those are features of the
  desktop app and extensions. They cannot be reached from an API-driven bot; the capability
  isn't in the request payload and no user input can add it.
- **Users never see the Anthropic API key.** It's injected from Secret Manager at runtime.
- **Tool surface is a whitelist.** The model can only call what we put in `mcp_servers`.
  Adding a tool is a deploy, not a user action.
- **Prompt injection is still live, though.** Content in an uploaded spreadsheet or an
  Asana task description can attempt to steer the model. The blast radius is bounded by
  that user's own Asana permissions — which is the argument for per-user tokens over a
  single service token. Don't add a shared high-privilege connector without revisiting this.

## 9. Deliberately not built yet

| Item | Why it's parked |
|---|---|
| Asana OAuth start/callback routes | Step 3. The bot works standalone first. |
| Asana refresh-token exchange | `freshAsanaToken()` throws on expiry by design; a half-built refresh path is worse than a clear error. |
| Firestore TTL on `threads` | Needs a retention decision. Recommend 30 days via a TTL policy on an `updated` field. |
| DLP / redaction before egress | Out of scope for v1; flag if client data is expected in-thread. |
| Drive attachments | Requires Drive scopes — conscious decision needed. |

## 10. Review questions for you

1. Is transmitting per-user Asana tokens to Anthropic's MCP connector acceptable, or do we
   want to run the MCP client ourselves and keep tokens in-perimeter? (The second is more
   work but keeps the token boundary tighter.)
2. Retention period on thread context — 30 days, or shorter?
3. Do we scope the initial rollout to a Google group rather than individual emails?
4. Anything in our client contracts that constrains sending document contents to a
   third-party model API?
