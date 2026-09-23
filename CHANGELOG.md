# Changelog

All notable changes to Buddy. Newest first. Dates are when the change was committed;
"deployed" notes say when it reached the live Chat app.

Format: **Added** (new features) · **Changed** (existing behaviour or wording) ·
**Fixed** (bugs) · **Security** · **Infrastructure** · **Docs** · **Deployed** (what reached the
live Chat app, and what is still unverified against reality).

---

## 2026-09-23

### Added
- **`costs` module.** Every Claude request now writes one usage event — person, module, tools,
  tokens in/out/cache, cost, trigger, outcome, duration — kept 90 days. `/costs` reports this
  month by person, module and tool, with what was spent on requests that produced nothing and the
  cache hit rate; `/costs week`, `/costs waste`, `/costs tools`, `/costs sheet`, `/costs check`.
  A finished week is appended to a separate Google Sheet on the first message after the week turns
  over, once. Metadata only: no message text is recorded, and costs are never offered to Claude as
  a tool. Admins only.
- **Spend outside Claude is recorded too.** Indexing the manual reports the characters it embedded
  and what they cost, shown in `/costs` under "Outside Claude". It is kept apart from conversations
  so "cost per request" stays a figure about chat, and it is never charged to anyone's cap —
  indexing a policy is infrastructure, not someone's conversation.

### Fixed
- **A request that failed before Claude answered recorded nothing**, so failures were invisible in
  `/costs` — exactly the thing the waste report exists for. Anything that did not simply answer is
  now recorded, even when it cost nothing.
- **"No Weekly tab" was the wrong diagnosis** for an uploaded `.xlsx`: a spreadsheet uploaded to
  Drive stays an Excel file, which the Sheets API refuses with the same 400 as a missing tab.
  `/costs check` now tells the two apart and quotes Google's own message.

### Changed
- **`/usage` is gone.** Spend is admin business now (`/costs`); people still see the cap message
  when they reach their limit.
- The store gained a narrow `list({field, from, limit})` range read, used by the cost reports.

### Docs
- **Cost tracking planned** (`0006-costs.md`, backlog Epic 8): one usage event per Claude call —
  person, module, tools, tokens, model, cost, trigger, outcome, duration — kept 90 days, with a
  `/costs` command for admins and a weekly append to a separate Google Sheet. Metadata only, never
  message text. Admin-only, so `/usage` goes away for everyone else.

---

## 2026-09-22

### Deployed
- All nine modules are live: `basics`, `assistant`, `files`, `asana`, `kudos`, `ooo`, `leave`,
  `admin` and `manual`. The manual's 40 documents are indexed and answerable.
  Still unverified against reality: `manual` answers (M6), `leave` on a real calendar (RUNBOOK §5e),
  a real access grant (G12). `kudos` still writes to the test Sheet, `files` is still pilot-only.

### Changed
- **Module replies can be formatted.** Card text is escaped first — so a Drive title, an Asana
  task name or a line from a policy can never become markup — and only then are `**bold**`,
  backticked `code` and `[text](https://link)` turned into HTML. Links must be http(s) and free of
  quotes, so a URL cannot break out of its attribute. Modules used raw `<b>` before, which showed
  up literally on cards.
- **`/access` and the manual's reindex report read properly.** `/access` gives a block only to
  modules that actually have grants and folds the rest into one line; the reindex summary leads
  with the counts and groups skipped files by reason, capped at five names each, instead of one
  run-on paragraph of forty names.

### Fixed
- **A long policy could still overrun a reindex slice.** The clock was only checked between
  documents, so one long document at the end of the queue blew through the twenty seconds a Chat
  command gets. Progress is now saved **within** a document, a part at a time, and every slice does
  at least one part before looking at the clock — so Continue can never spin without indexing
  anything. Firestore also no longer rejects a write when an optional field (a Drive file with no
  link, say) is missing.
- **Every document indexed as "empty".** Making the reindex resumable dropped each file's type
  from the saved queue, and without it there is no way to export a Doc — so Drive returned nothing
  and all 40 policies were recorded as empty. The tests missed it because the fake Drive looked
  text up by file id, ignoring the type; it now behaves like the real one, and removing the fix
  fails six tests.
- **`/manual reindex` timed out on a real manual.** A Chat command has twenty seconds; forty
  documents take minutes, so the first real run failed with a generic error. Indexing now runs in
  slices — about twelve seconds each — saving progress and offering a **Continue** button, with
  chunks stored per document rather than in one block. The live index only changes when a run
  finishes, so questions keep being answered from the previous version while a new one is built.
- **The manual module couldn't read Drive.** On Cloud Run a service account's token is scoped to
  `cloud-platform`, which the Drive API refuses — and a 403 was being reported as "share the folder
  with me", which was misleading since the folder *was* shared. Buddy now mints itself a
  `drive.readonly` token (IAM Credentials, no key), and a 403 quotes Google's own wording so a
  scope problem can't masquerade as a sharing problem again.

### Added
- **`manual` module — the team member manual, answerable in chat.** Buddy reads the manual's Drive
  folder, indexes it (Docs, Slides and Sheets; PDFs are named as skipped), and answers questions
  from those documents only, in its own voice, citing each one with a link. Retrieval is its own:
  Vertex AI embeddings as `buddy-bot` with no API key, chunks in Firestore, cosine search in
  memory, at most two passages per document and a similarity floor so a weak match returns nothing
  rather than a confident wrong quote. `/manual` shows what has been read, `/manual reindex`
  (admins) re-reads only what changed after a policy update, `/manual check` proves Drive access.
  Open to the whole domain. Replaces the Internal-RAG widget and Chrome extension; decision record
  `0005-manual-rag.md`.

### Docs
- **`docs/BUILDING-FOR-BUDDY.md`.** Rules to paste into an AI assistant when building something
  outside this repo (usually Apps Script) that we will later fold in as a module, plus a handover
  checklist. Written from what the Kudos and leave ports actually cost: inlined keys, logic tangled
  into the UI, over-wide deletes, duplicate writes, failures reported as success.

### Added
- **`admin` module.** Admins give colleagues access to modules from a DM — "give riley@ access to
  Asana, until 30 November" — instead of editing `infra/config.env` and deploying. `/access` shows
  what has been granted, per module. Config stays the floor: grants only widen it, and revoking
  only removes grants, so nothing said in chat can take away access the file allows. `admin`,
  `leave` and `assistant` can never be granted (a constant in the source, and not even offered to
  Claude), every change needs an approval click, only `@example.com` addresses are
  accepted, roles are never granted, and each change is logged with who made it. Granting also
  lets that person talk to Buddy, which the card says. Access is re-read once per event, so a
  change takes effect in seconds rather than at the next deploy.
- Remy is an admin as well as Robin (`BUDDY_ACCESS_ADMIN`).

---

## 2026-09-21

### Fixed
- **`ooo` found nobody out.** Real events on the calendar are titled "Ian OOO", not "Ian (OOO)",
  and the filter required the parentheses the Apps Script writes — so every genuine absence was
  thrown away. It now matches OOO as a word however it is written, and strips it (with any
  separator) when showing the name. Checked against the live bot's answer for the same week.
- **`/ooo check` failed on something the module never uses.** It began by fetching the calendar's
  name and time zone, which needs the `calendar.readonly` scope, while the delegation grants
  `calendar.events` — so Google returned 403 and the check reported "no access" although reading
  events worked. The check now proves what the module actually does (reading events); calendar
  details are a bonus that can never fail it. Failures also quote Google's own message.

### Changed
- **`ooo` reads by acting as one fixed account.** Workspace only allows outside addresses
  free/busy on a calendar, which has no names, so sharing could not work. `ooo` now reads
  `accounts@` as `OOO_READ_AS`, using the delegation `buddy-bot` already holds. Guardrails:
  the account comes from settings alone (validated, never from a user or Claude), the read-only
  scope is asked for first and any fallback to the writable one is logged with the fix, and the
  reader is a frozen object with only `list` and `describe` — no write method exists, every
  request is a GET to the one configured calendar, and each read is logged. Recorded as an
  amendment to `0003-ooo.md`.

### Added
- **`leave` module.** Books and cancels out-of-office by chat, built for the accounts team to
  record the whole team's leave. "Book Remy out 12–16 October" shows an approval card with the
  exact dates, hours and team invite, and only then writes. Creates the same two events as the Apps Script — the person's own `outOfOffice` block
  that auto-declines meetings, plus a transparent invite to `wholeteam@` — with per-person shifts
  (UK and three ARG) for half-days. Fixes the old script's cancel window (it reached two days past
  the range and deleted leave nobody asked to cancel), double bookings, and deletes that failed
  silently. Security: no key anywhere (`buddy-bot` has Google sign each assertion), the
  `calendar.events` scope only, the calendar is always the Chat-verified sender's unless the asker
  holds `leave.admin`, and every write is approved and logged.
  Booking for a colleague uses **their** name and shift, not the booker's, and both are remembered
  per person, so the accounts team types them once. A half-day for someone whose hours aren't known
  asks instead of guessing. The team invite can be skipped, as the Sheet dialog allowed.
- **`ooo` module (not enabled yet).** `/ooo` answers who's out today, tomorrow, this or next week,
  this or next month, from the `accounts@` calendar, plus a `who_is_out` tool so the assistant can
  answer naturally. Read-only (`calendar.readonly`), open to the whole domain, no Claude needed.
  Keeps the Apps Script's behaviour — Monday-to-Sunday weeks, ARG times, one line per absence — and
  fixes what it got wrong: all-day leave shows its real last day, personal block and team invite
  count as one absence, and "today" is the day the team is living in rather than UTC's. Missing
  calendar access explains what to share instead of failing obscurely; `/ooo check` proves it.
  Enable by adding `ooo` to `MODULES` once the calendar is shared.

### Infrastructure
- `setup.sh` enables the Calendar, IAM Credentials, Drive and Vertex AI APIs, needed by `ooo`,
  `leave` and `manual`.
- `setup.sh` also grants `buddy-bot` Service Account Token Creator on itself and Vertex AI User,
  so a fresh project works without the manual gcloud steps we ran by hand.
- `ooo` and `leave` added to `MODULES`, to the gateway's dependencies and to the Docker build.

### Docs
- **Out of office planned as two modules**, `ooo` (read-only "who's out", unblocked by a calendar
  share) and `leave` (books and cancels, the only code touching the delegation). Decision record
  `0003-ooo.md`: `buddy-bot` gets domain-wide delegation
  with no key file (it signs its own tokens), the `calendar.events` scope only, impersonating just
  the Chat-verified sender unless they hold `ooo.admin`, with every write behind an approval click.
  Remy's Apps Script is kept for reference in `legacy/ooo-appsscript/` with its private key removed;
  that key allowed impersonating anyone in the domain and needs rotating.
- Backlog: Epic 3 is the `ooo` module, Epic 5 the `leave` module, each with its own prerequisites.
  `ooo` reads the `accounts@` OOO calendar; `leave` invites `wholeteam@` when it books.

### Changed
- **Files is pilot-only.** Reading uploaded files is limited to Robin and Remy
  (`BUDDY_ACCESS_FILES`) until it has been tested properly, instead of the whole domain.
  Basics stays open to everyone at example.com.

---

## 2026-09-17

### Added
- **Tone of voice and look.** Buddy talks in Toni's tone of voice (all Toni-isms, used sparingly;
  approvals, limits and errors always stated plainly). Pixel-art Buddy appears in card headers
  (thinking on review cards, happy on success, neutral on notices) and brand orange
  (`#F47A2A`) on main buttons. Asana connect pages use the retro widget style.
  Images come from the original Buddy widget (`Internal-RAG`) and are served by `buddy-oauth`.
  No behaviour changes.
- **`/kudos check` write test.** Confirms Buddy can add rows to the Kudos Sheet, not just read it.
- **Assistant module.** Chatting freely with Claude is its own permission
  (`BUDDY_ACCESS_ASSISTANT`). People without it still get modules that don't need Claude
  (Kudos, commands) and receive a free "here's what I can help you with" card instead of a
  Claude reply. Asana and files are hidden from people who can't chat.
- **Kudos module (in testing).** Votes in the Kudos space are logged to the Kudos Google Sheet
  without Claude: tagged teammates, four company values, stricter value matching than the Apps
  Script. Policy enforced at vote time: no self-votes, 5 per month, 3 per person per month
  (leadership voters exempt), months in Argentina time. Sheet columns A–F unchanged, Chat ids
  in G–H. Commands: `/kudos`, and admin-only `/kudos check` and `/kudos leadership`.
- **Per-module access and roles.** Every module needs `BUDDY_ACCESS_<MODULE>`; modules can declare
  roles (`BUDDY_ROLE_<MODULE>_<ROLE>`). Missing rules stop startup. Modules someone can't use
  are invisible to them.
- **Direct message handlers.** Modules can answer messages without Claude and receive Chat
  mentions, space and sender.

### Fixed
- **No double "done" after approvals.** Buddy no longer posts a separate "Sure thing, finishing up…"
  message, and Claude doesn't repeat the results the approval card already shows: it only adds
  something new (a link, a next step, another approval), otherwise one short line. The card header
  switches from "Just finishing up…" to "Done" when Buddy has finished, so it never looks like it's
  still working. A second approval card that comes up afterwards is posted as its own message.
  Approvals, buttons and Asana actions are unchanged.
- Kudos: "above & beyond" and "above n beyond" count as Go beyond.
- Kudos: Sheet access problems (Viewer share, missing Sheet or tab, Google busy) now explain what
  to do instead of "something went wrong".

### Infrastructure
- `buddy-oauth` serves Buddy's images at `/assets/<file>` (listed files only).
- `deploy.sh` passes every `BUDDY_ACCESS_*`, `BUDDY_ROLE_*` and enabled-module setting from
  `infra/config.env` automatically.
- Kudos deployed against a **test copy** of the Kudos Sheet, votes allowed in the
  "Buddy testing ground" space.
- Sheets API enabled in `setup.sh`.

### Docs
- Backlog: security (webhook, web app, compute account), operations (CI, budget and error alerts),
  Kudos cutover, OOO calendar sharing.
- Decision record `0002-kudos.md`; module READMEs for Kudos and assistant.

---

## 2026-09-16

### Added
- **Button-first experience.** Asana connect card on the first Asana request with
  "I've connected, continue" (re-runs the original message); Reconnect card when a connection
  stops working; welcome, help and status as button cards; disconnect asks first; Try again on
  errors and expired approvals; expiry time shown in the user's time zone; progress message while
  Asana is checked; connect links last 1 hour.
- **Per-item approvals.** Batch Asana changes are split into one card section per task with
  readable fields (names instead of ids), Approve/Cancel each, Approve all/Cancel all.
  Updates are no longer labelled "cannot be undone".
- **`/asana tools`.** Lists which Asana actions run freely and which ask for approval.
- **Buddy rebuilt from scratch** (replacing the original `legacy-chat-bot`): modular core,
  `basics`, `files` and `asana` modules; `buddy-bot` (private, Google Chat only) and
  `buddy-oauth` (public, connect pages only) on Cloud Run.

### Security
- Fixed the original bot's connect-link account hijack: links are created for the verified Chat
  user, signed, single-use, with PKCE and an Asana email match.
- Asana tokens encrypted with Cloud KMS, bound to module and user; only ever sent to
  `mcp.asana.com`. Buddy runs its own MCP client.
- Every non-read-only Asana action needs the requester's click; approvals are single-use.
- Dedicated least-privilege service accounts; bot not publicly invocable.

### Infrastructure
- `infra/setup.sh`, `infra/deploy.sh` (refuses failing tests or uncommitted changes, verifies
  access rules), `infra/decommission-legacy.sh`.
- Firestore auto-delete: conversations 30 days, approvals 15 min, login sessions 1 h,
  saved requests and events 1 day.

### Docs
- README, RUNBOOK, SECURITY, BACKLOG, decision record `0001-scope-and-security.md`,
  repo working rules (`CLAUDE.md`). Original bot kept in `legacy/bot-rev23/`.
