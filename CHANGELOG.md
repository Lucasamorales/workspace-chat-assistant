# Changelog

All notable changes to Buddy. Newest first. Dates are when the change was committed;
"deployed" notes say when it reached the live Chat app.

Format: **Added** (new features) · **Changed** (existing behaviour or wording) ·
**Fixed** (bugs) · **Security** · **Infrastructure** · **Docs** · **Deployed** (what reached the
live Chat app, and what is still unverified against reality).

---

## 2026-09-28

### Changed
- **Admins and everyone with the assistant run on Opus 5.5; Asana users run on Sonnet 5.** The
  default model is now Opus, at the same medium effort, and Asana's own setting is Sonnet, so
  alexandra and jordan stay on Sonnet. Opus is twice Sonnet's price: Riley's API requests cost
  twice as much against her $15 allowance, and on the subscription proxy Opus uses the window
  faster. The default prices (`USD_PER_MTOK_IN/OUT`) are now Opus's, so an unlisted model still
  looks expensive, and Sonnet has its own entry in `MODEL_PRICES`.
- **A person scoped to several modules gets the strongest model any of them needs**, at that
  module's effort; a module with no setting counts as the default. The first rule only tuned
  someone with exactly *one* scoped module — and because the manual is open to everyone, every
  Asana user also has it, so Asana's setting reached nobody. With Opus as the default, the old
  rule would have put the Asana testers on Opus; this one puts them on Sonnet as intended.

### Fixed
- **A dated model id was priced at the default.** Replies can name their model with a date on
  the end (`claude-haiku-4-5-20251001`), and the price lookup only matched exact names. With Opus
  as the default price, a dated Sonnet reply would have shown in `/costs` at twice its cost; it now
  takes the price of the name it starts with.

## 2026-09-28 — experiment, `develop` only

### Added
- **The proxy checks its Claude login before it starts**, and logs which account and plan it
  will answer on. Anything but a `claude.ai` subscription login — an API key, a Console login, none
  — stops it starting, with the command that fixes it; every turn is still checked as well.

### Docs
- **`docs/SUBSCRIPTION-PROXY-SETUP.md`**: moving the experiment to a new PC and making it
  permanent — which Claude account it runs on and how to change it, a new shared secret, the proxy
  as a scheduled task that survives reboots, a named Cloudflare tunnel whose address never changes,
  and connecting Buddy and deploying.

### Added
- **Buddy on a Claude subscription, for one person** (`apps/claude-proxy`, decision
  `0010-subscription-proxy.md`). A proxy on the PC where Claude Code is logged in answers the
  Anthropic Messages API by running the Claude CLI. `buddy-bot` sends the people in
  `CLAUDE_PROXY_USERS` there through a tunnel; everyone else stays on the API. Modules, access,
  scoped conversation and approval cards are unchanged — they all run in `buddy-bot`.
- **Held sessions**: when the model asks for one of Buddy's tools, the CLI waits inside the call
  while Buddy runs it — behind its approval card when it writes — and the same process carries on,
  so history is never replayed. A thread's next message continues in the same process; a warm
  spare answers a new conversation in 1.1s instead of 2.1s.
- **Experiment logs** on the PC, one JSON line per step, content never recorded.
- **`/costs` shows subscription use apart**: requests, share of the five-hour and weekly windows,
  and what the API would have charged. Subscription replies cost $0 and never touch the cap.

### Security
- **No API billing and no fallback to the API.** The CLI gets an allow-listed environment and
  never sees an API key; every turn is refused unless it reports a subscription login; the proxy
  refuses to run while the account has extra usage switched on; `buddy-bot` never retries the
  proxy or falls back to the API. Each check has a test that fails without it.
- **Two accounts never share a proxy process.** Buddy's prompt doesn't name the asker, so two
  accounts with the same permissions looked identical to the proxy, and one could have continued
  in the process holding the other's conversation. Requests now carry an opaque owner id
  (`metadata.user_id`, a hash, never an email); spares, continuations and held calls are per
  person, and a request without an owner is refused.
- **The CLI can act on nothing**: restricted, no built-in tools except ToolSearch, only the stub's
  tools, every permission prompt refused, an empty working folder. The reference repo ran it with
  `--dangerously-skip-permissions`; with Buddy's untrusted input, that would let a line in an Asana
  task run commands on the PC.

### Infrastructure
- `deploy.sh` passes `CLAUDE_PROXY_USERS` and `CLAUDE_PROXY_URL`, and mounts `claude-proxy-secret`,
  only when someone is listed. The Dockerfile lists the new workspace so the lockfile matches; the
  proxy itself never runs in the image.

## 2026-09-24

### Changed
- **Asana-only people run on Haiku 4.5.** They are the heaviest users and the ones the saving is
  meant for: alexandra and jordan were 74% of the first day of spend. Haiku is half price in
  and out, so their requests drop from ~12 cents to roughly 3 once the tool curation lands too.
  Effort stays at medium — Asana plans multi-step writes to real client projects, and a mistake
  there is wrong data, not a worse sentence. Robin, Remy and Riley are unaffected: they have the
  assistant, so they get free-form conversation and therefore the default model. **Run the Asana
  eval before trusting this** (`docs/EVAL.md`); reverting is one line.

### Fixed
- **Cache writes were priced at the five-minute rate while we buy the one-hour one.** Anthropic
  charges 2x the input price to write a cache that lives an hour, against 1.25x for five minutes;
  we switched to an hour this morning and kept charging 1.25x. `/costs` was under-reporting the
  first request of every burst — the expensive one — by 60%, and the monthly cap was that much too
  generous. The rate now follows `CACHE_TTL`, per model.

### Changed
- **"Approve all" counts up while it works.** Twenty Asana changes take half a minute, and the
  card used to sit unchanged until every one had finished — a click that looked like nothing
  happened. It is now redrawn as the batch goes, at most once every few seconds so each redraw is
  not a Chat API call per Asana call, and a redraw that fails is logged rather than stopping the
  work.

### Fixed
- **Asana could get stuck in a "just ask me to carry on" loop.** This morning's 4,000-token
  output ceiling was too low to write a large batch tool call — updating one field on 54 tasks
  needs about 7,000 — so the call was truncated every time, at the same place, and the reply
  invited a retry that reproduced it exactly. `max_tokens` is a ceiling, not a budget: unwritten
  headroom costs nothing, so the lower limit saved nothing and only narrowed what was possible.
  Back to 16,000. The loop now tells a truncated **answer** apart from a truncated **tool call**
  and asks for a smaller batch rather than offering to carry on, and Asana is told to change at
  most 20 things per call.

### Changed
- **Riley can test Buddy end to end.** Added to `ALLOWED_USERS` and to Asana, the assistant,
  files, kudos (with the kudos admin role) and the manual admin role; basics, ooo and the manual
  she already had by domain. Deliberately **not** added to `admin`, `costs` or `leave`: granting
  other people access, reading the whole company's spend and writing to colleagues' calendars are
  not needed to test the rest, and leave has still never run against a real calendar.

### Added
- **A cheaper model for people who only use one module.** Someone whose Buddy is just the manual
  does not need the model that answers anything: `MODULE_TUNING` sets a model and an effort level
  per module, and it is chosen from the person's **scope**, not from the tool a request turns out
  to need. That matters twice over — the model cannot change mid-conversation, which would throw
  away the prompt cache, and the saving lands on the company at large rather than on admins.
  Prices are now per model (`MODEL_PRICES`), so `/costs` keeps telling the truth once a second
  model is in play, and it gains a **By model** line when more than one has run.
- **Repeat questions to the manual are free.** Eighty people will ask "how many holidays do I
  get?" and deserve the same answer; only the first now costs anything. The cache is keyed on the
  question's embedding — the vector retrieval needs anyway — so the same question in different
  words, or in Spanish, still hits, and publishing a new index retires every answer written from
  the old one. What is stored is a **hash of the question, its vector and the answer**: never the
  question text, never who asked. A miss, or any error at all, goes to Claude exactly as before.
- **`afterAnswer`**, a module hook: modules whose tools ran are told what the request answered,
  in the background, after the person has their reply. It is how the manual learns; a module that
  throws in it cannot turn an answered request into a failed one.
- **An eval** (`docs/EVAL.md`, `evals/manual.md`): twenty questions, asked before and after any
  change to model or effort, scored pass/partial/fail. A change ships only if nothing got worse.
  The known-good answers still need filling in by someone who knows the manual.
- **Context editing** (`CLEAR_TOOL_USES`), which drops the oldest tool results inside a long
  Asana loop instead of re-sending them every step. **Off by default** — it changes what Claude
  can still see mid-request, so it goes through the eval first.

### Changed
- **Module instructions cut from 5,500 characters to 1,772** across asana, manual, leave, ooo,
  kudos and admin. Sent on every request, by every person; the words were doing no work.
- **The manual is now a scoped module**, so someone can ask about policy without being given
  free-form Claude — the same split Asana already had (`0007-scoped-conversation.md`).

### Fixed
- **The Asana tool curation was not curating.** The "everyday" patterns were loose fragments, so
  against the real tool names they deferred three tools out of 39 — `/^get_/` alone kept 17, and
  `/me|current_user/` matched `add_comment`. Every pattern is now anchored to a whole tool name
  (13 of 39 loaded, checked against the live `/asana tools` output), the code loads everything if fewer than four match and warns if it keeps
  more than 60%, and the tests use Asana's real tool names and assert the ratio. They previously
  used seven invented names picked so the filter looked like it worked. Estimated effect on a first Asana
  request: ~8.5¢ → ~2.8¢. It also keeps Asana's own preview/confirm tools out of the loaded set,
  which would otherwise put a second approval step in front of Buddy's card.
- **The cost settings were never reaching Cloud Run.** `deploy.sh` passes a fixed list of
  variables, and `MAX_OUTPUT_TOKENS`, `MAX_HISTORY_CHARS`, `CACHE_TTL` and
  `MONTHLY_USD_CAP_SCOPED` were not on it: editing them in `infra/config.env` changed nothing,
  and the service ran on its built-in defaults. The defaults happened to match, so no behaviour
  was wrong — but the knobs were not connected to anything.

### Changed
- **"Who's out?" is answered without Claude.** The most-asked question at company scale has one
  right answer and a fixed shape, so `ooo` now answers it directly — in the words people actually
  use, English or Spanish, no commands needed. A question about the leave *policy* still goes to
  the manual, anything unrecognised still goes to Claude, and a calendar failure falls through
  rather than failing the message. That request now costs nothing.
- **An hour of prompt cache instead of five minutes**, a **4,000-token ceiling on replies** and
  **history capped by size, not just message count** (8,000 characters; twenty messages is nothing
  in a terse thread and a lot in a chatty one). All three are settings. Decision record
  `0009-cost-reduction.md`. _The output ceiling was reverted the same day — see Fixed above._

### Changed
- **Asana no longer sends ~100 tool definitions on every request.** Asana's MCP server offers about
  a hundred tools, each with a description and a JSON schema — tens of thousands of tokens before
  anyone types a word, which is where the money was going (Remy measured ~12¢ on a first request).
  The everyday tools are loaded; the rest are **deferred** and Claude looks them up with the
  tool-search tool when a request needs one, so nothing became impossible — `/asana tools` says how
  many are a lookup away. `ASANA_TOOLS` names the list exactly when the built-in match isn't right,
  and if a list matches nothing, everything is loaded: a cheaper Asana that cannot do its job is not
  cheaper. Decision record `0008-tool-payload.md`.

---

## 2026-09-23

### Added
- **Using a module by asking, without free-form Claude.** A module can now declare
  `scopedConversation`: it drives Claude **for itself alone**. Someone with `asana` can say
  "create a task for Remy due Friday" and get it, while Claude declines anything else and has only
  that module's tools — so "use Asana in words" is an ordinary permission instead of handing out a
  general-purpose chatbot. Scoped people get a smaller allowance (`MONTHLY_USD_CAP_SCOPED`, $5),
  since `assistant` used to be the de facto spend control. `asana` is the first; `files` and
  `manual` deliberately still need the assistant. Decision record `0007-scoped-conversation.md`.
  Consequence: **`asana` can now be granted from chat**, with no config edit and no deploy.

### Changed
- Alexandra and Jordan added to `ALLOWED_USERS`, `BUDDY_ACCESS_ASSISTANT` and
  `BUDDY_ACCESS_ASANA` for the Asana UAT. They also need the Chat app shared with them in the
  console, which is set by hand.

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
