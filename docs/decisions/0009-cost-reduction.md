# 0009 — Making Buddy cheap enough for the whole company

Date: 2026-09-24 · Status: accepted (Robin) · Builds on: `0006-costs.md`, `0008-tool-payload.md`

## Context

Buddy is a pilot today and about to be everyone's. A request costs roughly 2.5–3¢ uncached and
0.8¢ cached: ~11,000 tokens before anyone types, made of the voice guide, every available module's
instructions, the tool definitions and up to twenty messages of history.

At eighty people asking four questions a day that is $55–175 a month — not alarming, but it scales
with adoption, and the same changes that reduce it mostly make Buddy faster.

## Decision

Ten changes, in this order, cheapest risk first. Precision is protected by an eval, not by hope:
a set of real questions with known-good answers, run before and after anything that touches model,
effort or retrieval.

### Free — no capability lost

1. **One-hour prompt cache** instead of five minutes. Writes cost 25% more, reads stay at a tenth;
   chat is bursty, so this attacks the expensive first request of each burst.
2. **A ceiling on output.** 16,000 tokens per reply was a safety valve, not a need. Output is five
   times the input price, so a runaway answer is the single most expensive accident available.
3. **History measured in characters, not messages.** Twenty messages is nothing in a terse thread
   and a lot in a chatty one; a size budget is the honest unit.
4. **Answer the common question without Claude.** "Who's out today?" is a fixed intent with a
   fixed answer: the `ooo` module can answer it directly, in words, for nothing. People do not
   type commands, so the match is on natural language, and anything unrecognised still goes to
   Claude. This is the largest single saving at company scale.
5. **Shorter module instructions.** Seven modules × ~800 characters on every request. Editing them
   to half that changes no behaviour and is permanent.

### Cheap — small, measurable trade-offs

6. **Effort per module.** Most requests are not reasoning problems. Asana's multi-step writes keep
   more; looking something up in the manual needs less.
7. **Model per module.** Haiku 4.5 ($1/$5) where retrieval does the work — the manual, "who's
   out". Sonnet 5 stays where mistakes write to real data: Asana, leave. Three things follow from
   this, and all three are part of the work rather than afterthoughts:

   - **The model follows the person's scope, not the tool they end up using.** Which tool a request
     needs is only known once Claude has answered, and changing model mid-conversation throws away
     the cache every time. So someone scoped to the manual gets Haiku for the whole conversation;
     someone with the assistant gets Sonnet throughout. The saving therefore lands on **scoped
     people — the company at large — and not on admins**, which is the right way round.
   - **Prompt caches are per model**, so two models mean two caches. The rule above keeps that from
     hurting: a scoped person only ever uses one, so nothing is fragmented mid-thread.
   - **Prices are per model.** `/costs` and the monthly cap both compute money from
     `USD_PER_MTOK_IN`/`OUT`, which are single global numbers today, and every usage event
     currently records `model: null` because the handler never passes it. Both have to change in
     the same step, or the reports quietly drift the moment a second model appears.
8. **Context editing** (`clear_tool_uses`) for long Asana loops, where old tool results pile up
   inside a single request.

### Structural

9. **An answer cache for the manual.** Eighty people will ask "how many holidays do I get?" and
   deserve the same answer. The question is already embedded for retrieval, so the cache can be
   keyed on that embedding — a near-identical question is a hit at no extra cost, and the index
   version invalidates everything on reindex. Repeat questions become free.
   **Stored as a hash and an answer, never the question text**, so it does not quietly become a
   record of who asked what (see `0006-costs.md`).
10. **Scope more people.** A scoped person sends one module's instructions and tools rather than
    nine, and sits on a smaller cap. At company scale the assistant should be the exception.

## Consequences

- Expected: 2.5–3¢ → well under 1¢ for a typical request, and free for repeated manual questions
  and "who's out".
- Two changes can cost precision — effort and model — so both are gated behind the eval, per
  module, and are the last to be made.
- The answer cache is the only change that stores anything new about what people ask. Hashes only,
  and it is worth saying out loud rather than burying.
- More moving parts in cost reporting: `/costs` must know per-model prices or its figures drift.

## Alternatives considered

- **Haiku everywhere.** Half price, but it puts the weaker model on the modules that change other
  people's data. Rejected.
- **Batch API (50% off).** Not applicable: every request here is someone waiting in a chat window.
- **Fast mode.** The opposite of this document.

## As built (2026-09-24)

All ten are in, with three things worth knowing that the plan did not say:

- **The model is chosen from the scope, in the handler, once per request** (`tuningFor`), and only
  when the scope is unambiguous. Someone scoped to two modules gets the default: a request is
  answered by one model throughout, and guessing which of two it should be is worse than not
  guessing. Configured as `MODULE_TUNING=manual:claude-haiku-4-5:low`, priced by `MODEL_PRICES`.
- **The answer cache lives in the module, not the gateway** — read in `handleMessage` (so a hit
  never reaches Claude) and written in `afterAnswer`, a new hook the registry only offers to
  modules whose tools actually ran. The question is embedded at most once per message: the cache
  lookup, the retrieval and the write share one vector.
- **Only direct messages are checked** against the cache. Embedding every message of every busy
  space would cost more than the cache saves.

Two are deliberately left off:

- `CLEAR_TOOL_USES=0`. Context editing changes what Claude can still see inside a request, so it
  waits for the eval.
- The eval's known-good answers. `evals/manual.md` has the twenty questions; the answers need
  someone who knows the manual, and inventing them would defeat the purpose.

## Amendment, 2026-09-24 (same day): lever 2 was wrong, and it broke Asana

Within hours of the deploy a user hit a loop: Buddy said "Oops, I got cut off. Just ask me to
carry on", they said carry on, and it was cut off again, four times over.

**`max_tokens` is a ceiling, not a budget.** Output is billed per token written; headroom that is
never used costs nothing. Lowering the ceiling from 16,000 to 4,000 therefore saved nothing on
ordinary replies. What it did was make a legitimate request impossible: updating one custom field
on 54 tasks is a tool call of roughly 7,000 output tokens, so it was truncated every time, at the
same place, deterministically. The reply then invited the user to carry on — which regenerated the
identical too-long call. The "saving" cost four full requests and about twenty wasted minutes.

Reverted to 16,000, and two guards added so the shape of the failure cannot recur silently:

- the loop tells **cut off mid-answer** apart from **cut off mid-tool-call** (`max_tokens_tool`).
  A half-written tool call is discarded, so "carry on" is the one thing that cannot work; the
  reply now asks for a smaller batch instead;
- the Asana instructions cap a single call at 20 items, which keeps the common case well inside
  the ceiling in the first place.

The lesson for the rest of this document: a lever that changes a **limit** is not the same as a
lever that changes an **amount**. Levers 1, 3, 4, 5, 9 and 10 reduce what is sent or generated,
and are real savings. Lever 2 only narrowed what was possible.
