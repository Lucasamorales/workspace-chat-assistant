# Backlog

Goal: one Google Chat app, **Buddy**, with independent modules (Asana, Kudos, OOO, …) and
permissions per module. Until the merge, the Asana bot runs as a separate app named
**Buddy-Asana**; the existing Apps Script **Buddy** (Kudos + OOO) keeps running unchanged.

Status: `todo` · `doing` · `done` · `blocked`

## Now: Buddy-Asana

| # | Item | Status |
|---|---|---|
| A1 | Point the Chat app **Buddy-Asana** at `buddy-bot`; visibility robin@ + remy@ | done |
| A2 | Run the acceptance checklist (RUNBOOK §5) | doing |
| A3 | Tune `ASANA_READONLY_TOOLS` if reads ask for approval | todo |
| A4 | After A2 passes: `feat:` commit marking the build verified | todo |
| A5 | Remove the old bot: `CONFIRM=yes bash infra/decommission-legacy.sh` | todo |
| A6 | Remy's feedback: one card section per task (title, description, due date, assignee by name), Approve/Cancel each, Approve all/Cancel all; update ≠ "cannot be undone" | deployed |
| A7 | `/asana tools` command listing free vs approval-gated actions | deployed |
| A8 | Friendlier UX: Connect button on the first Asana request + "I've connected, continue"; Reconnect card when the connection stops working; welcome/help/status as button cards; disconnect asks first; Try again on errors and expired approvals; approval card copy with expiry time in the user's time zone; "Checking your Asana…" progress; 1 h connect links | deployed |

## Later

| # | Item | Notes |
|---|---|---|
| U1 | **App Home tab** in the DM: connection status, this month's usage, quick buttons | Enable "Support App Home" in the Chat console; handle `APP_HOME` events |
| U2 | **Proactive connection check**: a daily job that warns users whose Asana connection stopped working, before they need it | Needs the scheduled jobs hook (R6) |
| U3 | Register `/help` and `/asana` under Commands in the Chat console for autocomplete | Console only |

## P0: Security (independent of the merge)

| # | Item | Acceptance |
|---|---|---|
| S1 | Rotate the `leave-bot@your-leave-project` service account key that is hard-coded in `LeaveDates.gs` | New key stored in Script Properties (not code); old key deleted in GCP; local copy scrubbed; leave menu still works |
| S2 | Review who can edit the Leave Dates Apps Script and its Sheet | Only people who should manage leave |
| S3 | Delete and recreate the Chat **webhook** hard-coded in `kudos announcement.gs`; store the new one in Script Properties | Old webhook URL no longer posts |
| S4 | Restrict the Kudos Apps Script **web app** to "Only myself" (its approve link publishes without authentication) | Link fails for anyone else |
| S5 | Remove **Editor** from the default compute service account (part of A5, tracked separately) | `gcloud projects get-iam-policy` shows no Editor for `*-compute@` |

## Operations

| # | Item | Acceptance |
|---|---|---|
| P1 | Push to GitHub regularly (`your-github-org/Buddy`, private) | `git log origin/main..main` is empty after each work session |
| P2 | **GitHub Actions**: `npm ci`, `npm test`, `npm audit --omit=dev` on every push and PR | Red check blocks merging |
| P3 | **Budget alerts** on the GCP billing account + monthly **spend limit** on the Anthropic workspace | Alert emails at 50/90/100 %; backs up the per-user cap |
| P4 | **Error alert**: email when `buddy-bot` logs ERROR (Cloud Logging alert policy) | A failing module is noticed without manual testing |
| P5 | Read-only log access for Claude Code (`gcloud logging read` allowed in settings) | Diagnosing a failure doesn't need logs pasted by hand |

## Docs

| # | Item | Acceptance |
|---|---|---|
| D1 | `SECURITY.md`: per-module access, assistant permission, Kudos (Sheet access, vote policy) | Controls table covers them |
| D2 | RUNBOOK checklist: assistant permission (someone without it gets "here's what I can help with") | Checklist item |
| D3 | Non-technical overview of what Buddy does, for the team | Shared doc |

## Epic 1: Prepare the repo for many modules

| # | Item | Acceptance |
|---|---|---|
| R1 | ✅ **Per-module access + roles**: `BUDDY_ACCESS_<MODULE>` (required) and `BUDDY_ROLE_<MODULE>_<ROLE>` in `infra/config.env`, accepting emails, `users/<id>`, `domain:example.com` | A user without access never sees the module: not in `/help`, commands refused, tools never sent to Claude. Tests prove it |
| R2 | ✅ **Assistant module**: free-form Claude chat is the `assistant` module with its own access rule (`BUDDY_ACCESS_ASSISTANT`); Claude-only modules marked `needsConversation` | People without assistant access get a free "here's what I can help with" card; no Claude cost |
| R3 | ✅ **Direct message handlers**: contract hook `handleMessage(ctx, message)` for exact matches (kudos votes, "who is out") that run before Claude | Ordered, one winner, isolated like other hooks |
| R4 | ✅ **Mentions in context**: pass Chat user mentions (name, email, id) to modules | Kudos can read tagged teammates without parsing text |
| R5 | **Google API access pattern**: modules read/write Sheets and Calendar as `buddy-bot`, with only specific files/calendars shared to it. No keys | Documented in `docs/ADDING_A_MODULE.md` |
| R6 | **Scheduled jobs hook** `onSchedule(ctx)` driven by Cloud Scheduler → authenticated endpoint | Not needed for Kudos/OOO; enables future reminders/digests |
| R7 | **Module template + test helpers** (`@buddy/core/testing`: fake ctx, fake store, fake event) | New module = copy folder, add to config, tests run standalone |
| R8 | `docs/ADDING_A_MODULE.md` | Covers contract, access, settings, storage, tests, deploy |
| R9 | Optional: Google Group membership for access rules (Cloud Identity API) | `ACCESS_KUDOS=group:wholeteam@example.com` works |

## Epic 2: Kudos module

Decisions: [0002-kudos.md](decisions/0002-kudos.md). Source of truth: the Apps Script `kudos.gs` +
`kudos announcement.gs` currently attached to the Kudos Sheet.

**P0 outside the repo (do now):** delete and recreate the Chat webhook hard-coded in
`kudos announcement.gs`, store the new one in Script Properties; restrict the Apps Script web app
(its approve link publishes without authentication).

| # | Item | Acceptance |
|---|---|---|
| K1 | ✅ Vote parsing: human mentions from Chat annotations, per-nominee text slices, stricter value matching (Own it, Think big, Go beyond, Be curious) | Same results as the live script on real messages; known false positives ("down with it") rejected |
| K2 | ✅ Append to `Raw Data`: A–F unchanged (Date, Voter, Value, Nominee, Space, Raw text) + G–H voter/nominee Chat IDs; dates in Argentina time | Existing reports keep working |
| K3 | ✅ Votes only in "Team - Kudos"; DMs rejected with the current message | Test |
| K4 | ✅ Block self-votes; enforce 5 given/month and 3 per nominee/month (leadership voters exempt) | Friendly reply naming the rule; partial votes logged for the allowed nominees |
| K5 | ✅ `/kudos leadership @…` (admin): link leadership emails to Chat IDs; leadership can't win | Stored in module storage; audits exclude by ID, and by exact name for old rows |
| K6 | ✅ `/kudos` (everyone) and `/kudos check` (admin); `/kudos leaderboard` moves to K7 | Buttons on the help card |
| K7 | Monthly / quarterly / yearly audits: same thresholds, ties, trade-in eligibility, £ values and house tone | Output matches Apps Script on July 2026 data |
| K8 | Approval card to Kudos admins: Publish as-is / Edit first (Chat dialog) / Skip; publish once, as Buddy, with real @mentions; record winner in Summary | Only admins can see/click; no web app, no webhook |
| K9 | Scheduled jobs on the 1st (Cloud Scheduler → authenticated `/jobs/kudos/*`) | Quarterly only in Jan/Apr/Jul/Oct, yearly only in Jan |
| K10 | Test against a **copy** of the Sheet in a test space; cutover with Epic 4 | Real Sheet untouched until cutover · **doing** (space "Buddy testing ground") |
| K11 | `/kudos check` also verifies Buddy can **write** to the Sheet | A Viewer share shows ❌ in the check |
| K12 | Headers for columns G–H ("Giver ID", "Receiver ID") in the test Sheet now, the real Sheet at cutover | Headers present |
| K13 | Cutover: share the **real** Sheet with buddy-bot as **Editor**, set `KUDOS_SHEET_ID` and `KUDOS_SPACES` to "Team - Kudos" | `/kudos check` all ✅ in Team - Kudos |

Core work this depends on: R1 (per-module access + roles), R3 (message handlers), R4 (mentions);
R6 (scheduled jobs) and Chat dialogs are built together with K8–K9, their first users.

## Epic 3: OOO module (who's out)

| # | Item | Acceptance |
|---|---|---|
| O0 | Share the `accounts@` calendar with `buddy-bot@your-gcp-project.iam.gserviceaccount.com` ("See all event details"); if Workspace blocks external sharing, get admin approval | Blocks the rest of this epic |
| O1 | Port "who is out" lookups: today, tomorrow, this/next week, this/next month | Same answers as the live script for the same calendar data |
| O2 | Read `accounts@example.com` calendar as `buddy-bot` (calendar shared with "See all event details") | No per-user calendar subscription hack, no keys |
| O3 | Keep de-duplication and ARG time formatting | Test |
| O4 | Friendly error instead of printing raw exception text | Test |
| O5 | DMs and spaces; access everyone @example.com | Via R1 |
| O6 | *Optional:* expose "who is out" as a read-only tool so the assistant can answer naturally | Only for users with both assistant and ooo access |

## Epic 4: Merge and cutover

| # | Item | Acceptance |
|---|---|---|
| C1 | Decide who gets the assistant (free-form Claude): set `BUDDY_ACCESS_ASSISTANT` | Decision recorded in `docs/decisions/` |
| C2 | Deploy with kudos + ooo + asana + assistant, per-module access configured | `deploy.sh` checks pass |
| C3 | Rename Chat app **Buddy-Asana → Buddy**; visibility whole company (code enforces module access) | Asana still limited to its list; verified with a non-listed user |
| C4 | Add new Buddy to every space where the old one lives; remove the old one | Kudos space works end to end |
| C5 | Retire the Apps Script Buddy Chat app (keep the Leave Dates Sheet menu until Epic 5) | Only one "Buddy" in Chat search |
| C6 | Announce to the team: same name, re-open the DM with Buddy | — |

## Epic 5 (later): Leave creation

| # | Item | Acceptance |
|---|---|---|
| L1 | Decide: keep the Sheet menu in Apps Script, or move leave create/cancel into an HR-only Buddy module | Decision recorded |
| L2 | If moved: keyless domain-wide delegation from `buddy-bot`, HR-only access, approval card before creating/cancelling events | Old `leave-bot` key deleted |
