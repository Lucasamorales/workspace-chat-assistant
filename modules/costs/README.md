# costs

What Buddy is spending, by person, module and tool. **Admins only**, and **metadata only** — what
people asked and what Buddy answered are never recorded, so this can say "Robin spent $2.10 on the
manual" and can never say what he asked it.

Decision: `docs/decisions/0006-costs.md`.

## Using it

| | |
|---|---|
| `/costs` | This month: total, by person, by module, waste, cache |
| `/costs week` | The last seven days |
| `/costs waste` | What was paid for requests that produced nothing, and the cache picture |
| `/costs tools` | Every tool that ran this month, with failures |
| `/costs sheet` | Write any finished week to the Sheet now |
| `/costs check` | Is the Sheet reachable, how many events are kept |

## Where the numbers come from

Every Claude request writes one event: person, module, the tools it ran, tokens in / out /
cache-read / cache-write, cost, what triggered it (a message, a button, an approval), how it ended
(answered · failed · refused · declined · expired · connect) and how long it took. Events are kept
**90 days** and delete themselves; the monthly per-person totals that enforce the cap are kept
regardless.

**Attribution is deliberately coarse.** A request belongs to the module whose tools it used, or to
`assistant` when it used none. Every module's instructions sit in the system prompt, so a share of
every request belongs to all of them — "the manual cost $4" means "requests in which Buddy searched
the manual", which is the honest reading and the useful one.

## The weekly Sheet

One row per person per module per week, appended to the Sheet in `COSTS_SHEET_ID`. The column
order is the contract: **never reorder, only add to the right**, or old rows stop lining up.

The write happens on the first message after a week turns over — `buddy-bot` only accepts calls
from Google Chat, and opening it to a scheduler would mean a new invoker and a new public path for
a job that can ride an ordinary message. A finished week is written once; the week in progress is
never written. `/costs sheet` forces it.

A Sheet failure is logged and never shown: whoever happened to send the message that triggered the
rollup should not see an error about a spreadsheet they didn't ask for.

## The number worth watching

**Cache hit rate.** Long conversations re-send their history; cache reads cost a tenth of the input
price, so when the cache misses you pay full price for the same text again. It is usually the
largest avoidable cost in a chat assistant and nobody notices it without a report. Below 50%,
`/costs` says so in as many words.

## Settings

| Setting | Default | |
|---|---|---|
| `COSTS_SHEET_ID` | *(unset)* | The Sheet to append to. Without it everything else still works |
| `COSTS_SHEET_TAB` | `Weekly` | Tab name |
| `COSTS_TIMEZONE` | `America/Argentina/Buenos_Aires` | Which day a week starts on, and where a month begins |

The Sheet must be shared as **Editor** with `buddy-bot@your-gcp-project.iam.gserviceaccount.com`.

## Deliberate omissions

- **No tool for Claude.** Costs are read with a command only, so no conversation can be steered
  into reporting on someone.
- **`/usage` is gone** for everyone. People still see the cap message when they reach the limit,
  because a refusal has to explain itself.
- **Cloud Run and Firestore are not split per person.** Any split would be invented; they are a
  flat overhead of a few pounds a month.
