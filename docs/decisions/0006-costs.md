# 0006 — Knowing what Buddy costs, per person and per module

Date: 2026-09-23 · Status: accepted (Robin)

## Context

Buddy tracks one number per person per month: dollars spent on Claude, checked before every call so
nobody can run past the cap. That answers "has anyone run away with it" and nothing else. It cannot
say which modules cost money, which tools are expensive, what a typical request costs, or how much
is spent on requests that produced nothing.

## Decision

Record **one usage event per Claude call**, keep them 90 days, and roll them up two ways: a
`/costs` command for admins, and a weekly append to a Google Sheet.

### What each event holds

Metadata only — never message text, never the question, never the answer. A cost report must not
become a record of who asked about parental leave.

| Field | Why |
|---|---|
| person, timestamp | who and when |
| module | which module's tools the request used (see attribution) |
| tools | each tool called, by name, with success or failure |
| tokens in / out / cache read / cache write | where the money actually goes |
| model, cost | the price of that call |
| trigger | a message, a button, an approval resume |
| outcome | answered · failed · declined · expired · refused by the cap |
| duration | slow requests are usually expensive ones |

### Attribution

A conversation can touch several modules, and every module's instructions sit in the system prompt,
so a share of every request belongs to all of them. Each request is attributed to a **primary
module**: whichever module's tools it actually used, or `assistant` when it used none. Tool counts
sit underneath. "The manual cost £4 this month" therefore means "requests in which Buddy searched
the manual", which is the honest reading and the useful one.

### Costs outside Claude

Embedding characters per reindex are recorded with their cost. Google API calls (Drive, Calendar,
Sheets) are counted but cost nothing. Cloud Run and Firestore are reported as a flat monthly
overhead, not split per person: splitting them would be invention.

### Waste, in things that can be counted

- requests that produced nothing: errors, refusals, approvals cancelled or expired;
- retries: the same person repeating a request within minutes, or clicking "Try again";
- **cache efficiency** — cache reads against cache writes. Long conversations re-send their history;
  when the prompt cache misses, the same text is paid for at full price again. This is the largest
  avoidable cost in a chat assistant and the one nobody notices;
- oversized context: tokens carried in versus the size of the answer;
- budget denials, which mean either the cap is wrong or something is looping.

### Who sees it

**Admins only.** `/costs` is admin-only, and `/usage` is withdrawn from everyone else: costs are a
management matter, not a leaderboard. People still see the cap message if they reach the limit,
because a refusal has to explain itself.

### Where it goes

1. **`/costs`** in a DM — this month by person, by module, by tool, top spenders, cost per request,
   and the waste summary.
2. **A weekly append to a separate Google Sheet**, one row per person per module per week, in the
   column order of the workbook handed over on 2026-09-23 (never reordered, only extended to the
   right). A separate Sheet from Kudos, shared with `buddy-bot` as Editor. Weekly totals are a pivot
   in the Sheet and a summary in `/costs`, not a second tab to keep in step.

The weekly write happens on the first message after a week rolls over, rather than on a schedule:
`buddy-bot` only accepts calls from Google Chat, and opening it to a scheduler would mean a new
invoker and a new public path for a job that can just as well ride an ordinary message. `/costs
sheet` forces it by hand.

### Retention

Per-request events: 90 days, deleted automatically. Monthly and weekly totals: kept.

## Alternatives considered

- **A BigQuery sink.** Every event queryable in SQL. Rejected for now: real setup, real cost, and
  the questions we have today are answered by a command and a Sheet. Easy to add later — the events
  are already structured.
- **Splitting Cloud Run and Firestore per person.** Rejected: any split would be made up.
- **Attributing a share of each request to every module involved.** Rejected as harder to explain
  than the primary-module rule, for numbers nobody would act on differently.

## Consequences

- Firestore holds one small document per Claude call for 90 days. At current volumes that is
  trivial; if Buddy goes company-wide it wants checking.
- Prices come from `USD_PER_MTOK_IN` / `USD_PER_MTOK_OUT` in config. If Anthropic's prices change
  and those lines don't, every report is wrong in the same direction: the figures are ours, not
  Anthropic's invoice, and the account balance remains the source of truth for what is owed.
- `/usage` disappearing for non-admins is a visible change for the pilot, who have it today.
