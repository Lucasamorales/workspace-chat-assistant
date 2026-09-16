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
| A6 | Remy's feedback: one card section per task (title, description, due date, assignee by name), Approve/Cancel each, Approve all/Cancel all; update ≠ "cannot be undone" | built, awaiting deploy |
| A7 | `/asana tools` command listing free vs approval-gated actions | built, awaiting deploy |

## P0: Security (independent of the merge)

| # | Item | Acceptance |
|---|---|---|
| S1 | Rotate the `leave-bot@your-leave-project` service account key that is hard-coded in `LeaveDates.gs` | New key stored in Script Properties (not code); old key deleted in GCP; local copy scrubbed; leave menu still works |
| S2 | Review who can edit the Leave Dates Apps Script and its Sheet | Only people who should manage leave |

## Epic 1: Prepare the repo for many modules

| # | Item | Acceptance |
|---|---|---|
| R1 | **Per-module access**: `ACCESS_<MODULE>` in `infra/config.env` accepting emails, `domain:example.com`, later groups | A user without access never sees the module: not in `/help`, commands refused, tools never sent to Claude. Tests prove it |
| R2 | **Assistant module**: move free-form Claude chat out of core into `modules/assistant` with its own access rule | People without assistant access get a short help reply; no Claude cost |
| R3 | **Direct message handlers**: contract hook `handleMessage(ctx, message)` for exact matches (kudos votes, "who is out") that run before Claude | Ordered, one winner, isolated like other hooks |
| R4 | **Mentions in context**: pass Chat user mentions (name, email, id) to modules | Kudos can read tagged teammates without parsing text |
| R5 | **Google API access pattern**: modules read/write Sheets and Calendar as `buddy-bot`, with only specific files/calendars shared to it. No keys | Documented in `docs/ADDING_A_MODULE.md` |
| R6 | **Scheduled jobs hook** `onSchedule(ctx)` driven by Cloud Scheduler → authenticated endpoint | Not needed for Kudos/OOO; enables future reminders/digests |
| R7 | **Module template + test helpers** (`@buddy/core/testing`: fake ctx, fake store, fake event) | New module = copy folder, add to config, tests run standalone |
| R8 | `docs/ADDING_A_MODULE.md` | Covers contract, access, settings, storage, tests, deploy |
| R9 | Optional: Google Group membership for access rules (Cloud Identity API) | `ACCESS_KUDOS=group:wholeteam@example.com` works |

## Epic 2: Kudos module

Source of truth: `Leave Dates Automation/KudosBotCode.gs` (live), not `Kudos automation/Code.gs` (older).

| # | Item | Acceptance |
|---|---|---|
| K1 | Port vote parsing: human mentions, per-nominee text slices, value regex (Own it, Think big, Go beyond, Be curious) | Same results as the live script on a shared set of test messages |
| K2 | Write to Sheet `YOUR_KUDOS_SHEET_ID`, tab `Raw Data`, columns A–F unchanged | Existing reports keep working |
| K3 | Share the Sheet with `buddy-bot@your-gcp-project.iam.gserviceaccount.com` (Editor) | Buddy can append; no other Drive access |
| K4 | Spaces only; DMs rejected with the current message | Test |
| K5 | *Proposed:* block self-votes | Decision needed |
| K6 | *Proposed:* only accept votes in the official Kudos space(s) (`KUDOS_SPACES`) | Decision needed; space ids listed |
| K7 | *Proposed:* add voter and nominee email as columns G–H | Decision needed; A–F untouched |
| K8 | Access: everyone @example.com | Via R1 |

## Epic 3: OOO module (who's out)

| # | Item | Acceptance |
|---|---|---|
| O1 | Port "who is out" lookups: today, tomorrow, this/next week, this/next month | Same answers as the live script for the same calendar data |
| O2 | Read `accounts@example.com` calendar as `buddy-bot` (calendar shared with "See all event details") | No per-user calendar subscription hack, no keys |
| O3 | Keep de-duplication and ARG time formatting | Test |
| O4 | Friendly error instead of printing raw exception text | Test |
| O5 | DMs and spaces; access everyone @example.com | Via R1 |
| O6 | *Optional:* expose "who is out" as a read-only tool so the assistant can answer naturally | Only for users with both assistant and ooo access |

## Epic 4: Merge and cutover

| # | Item | Acceptance |
|---|---|---|
| C1 | Decide who gets the assistant (free-form Claude) | Decision recorded in `docs/decisions/` |
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
