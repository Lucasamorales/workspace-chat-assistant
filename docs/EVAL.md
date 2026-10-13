# The eval: how we know a cheaper Buddy is still a right Buddy

Two of the cost changes can cost precision — a smaller model, and less effort per request
(`docs/decisions/0009-cost-reduction.md`, items 6 and 7). Precision is protected by measurement,
not by hope: the same questions, asked before and after, with the answers compared.

This is a human eval, run in a DM with Buddy. It is deliberately not automated: what we are
checking is whether a person gets a right, complete, well-cited answer, and only a person who
knows the policy can say.

## When to run it

- Before and after changing `MODULE_TUNING` (model or effort for a module).
- Before and after turning on `CLEAR_TOOL_USES`.
- After a reindex that changed a lot of documents.
- Once a quarter, as a check that nothing has drifted.

## How to run it

1. Open `evals/manual.md`. The **Known-good** column has to be filled in by someone who knows
   the manual — that is the whole value of the exercise, and it only has to be done once.
2. In a DM with Buddy, ask each question exactly as written. Paste the answer into the
   **Before** column.
3. Make the change (one change, not three) and deploy.
4. Ask the same questions again. Paste into **After**.
5. Score each row:
   - **pass** — the facts are right and the document is cited;
   - **partial** — right but thin, or missing the citation;
   - **fail** — wrong, invented, or "I don't know" for something the manual covers.

## The bar

A change ships if: no new **fail**, and at most one **pass → partial**.

Anything else is reverted — put `MODULE_TUNING` back and redeploy. A wrong answer about parental
leave costs far more than the fraction of a penny the change saves.

## Recording it

Keep the filled-in table in `evals/manual.md`, committed, with the date and what changed at the
top of the run. The point of writing it down is the next change, six months from now, by someone
who was not in the room.

## Cost, while you are there

Run `/costs week` before and after. The answer to "did this work?" is two numbers: cost per
request went down, and the eval did not get worse.
