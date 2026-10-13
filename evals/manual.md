# Manual eval — 20 questions

How to use this file: `docs/EVAL.md`.

**Known-good** has to be filled in once, by someone who knows the manual (Remy or Riley). Until
it is, the eval can still catch a regression — compare Before with After — but it cannot catch an
answer that has been wrong all along.

Run: _(date)_ — change under test: _(e.g. manual on Haiku 4.5, effort low)_

| # | Question | Known-good | Before | After | Score |
|---|----------|------------|--------|-------|-------|
| 1 | How many holidays do I get? | | | | |
| 2 | How do I book time off? | | | | |
| 3 | Who do I tell when I'm sick? | | | | |
| 4 | What's the policy on working from home? | | | | |
| 5 | Can I work from another country, and for how long? | | | | |
| 6 | How do I claim expenses, and by when? | | | | |
| 7 | Do I need a receipt for a £6 coffee with a client? | | | | |
| 8 | What laptop do I get, and what happens if I break it? | | | | |
| 9 | What's the parental leave policy? | | | | |
| 10 | How much notice do I have to give if I leave? | | | | |
| 11 | What happens in my first week? | | | | |
| 12 | Who approves a training course, and is there a budget? | | | | |
| 13 | What are the core hours? | | | | |
| 14 | How does the probation period work? | | | | |
| 15 | What do I do if I want to raise a complaint about someone? | | | | |
| 16 | Are there company values, and what are they? | | | | |
| 17 | What's the policy on using client data on a personal device? | | | | |
| 18 | ¿Cuántos días de vacaciones tengo? | | | | |
| 19 | How many days of holiday does someone in their second year get? | | | | |
| 20 | What's the policy on pets in the office? | | | | |

Rows worth keeping whatever else changes:

- **18** is the same question as 1 in Spanish. Half the studio writes to Buddy in Spanish, and
  the embeddings are multilingual on purpose — if this one breaks, the model change broke it.
- **19** needs a detail, not a headline: it is the row that catches an answer that skims.
- **20** should be answered with "the manual doesn't cover that, ask X" — it is there to catch
  the expensive failure, which is inventing a policy rather than admitting there isn't one.
