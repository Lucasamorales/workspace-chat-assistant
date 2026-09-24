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
   out". Sonnet 5 stays where mistakes write to real data: Asana, leave. This needs a per-model
   price table, or `/costs` starts lying the moment two models are in play.
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
