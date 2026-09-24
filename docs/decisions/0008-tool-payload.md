# 0008 — Not paying for a hundred Asana tools on every request

Date: 2026-09-24 · Status: accepted (Robin) · Prompted by: Remy's cost measurements

## Context

Asana's MCP server offers around a hundred tools. Every one of their descriptions and JSON schemas
is re-sent on **every** request — tens of thousands of tokens before anyone has typed a word.
Remy measured this on his own build: a first interaction cost about 12¢, and adding prompt caching
brought follow-ups down to 2–3¢.

Buddy already caches: `packages/core/src/claude.js` sets `cache_control: { type: 'ephemeral' }`,
which caches the tools, the system prompt and the conversation prefix. But caching makes a large
payload *cheap for five minutes*; it does not make it small. Chat is bursty — a question at 10:00
and another at 10:20 pays the full price twice.

## Decision

**Load the tools people use; defer the rest.**

- The everyday tools (searching, listing, getting, creating, updating, completing, comments,
  projects, workspaces, "me") are sent with every request as before.
- Everything else is marked `defer_loading: true`. Its definition is not sent; Claude finds it with
  the **tool-search tool** when a request needs it, and then calls it like any other tool.
- `ASANA_TOOLS` names the list exactly when the built-in match is wrong. `/asana tools` shows what
  is loaded and says how many more are a lookup away.

Two safety rules, both tested:

- **If a list matches nothing, everything is loaded.** A cheaper Asana that cannot do its job is
  not cheaper, and a typo in a config list must not quietly disable half of it.
- **Never defer every tool.** The API rejects that outright; the flags are dropped instead, so a
  mistake costs money rather than breaking Asana.

## Consequences

- The common path — "what's due this week", "create a task" — stops paying for a long tail nobody
  asks for, cached or not.
- The rare request costs one extra step: Claude searches, then calls. Slower by a beat, still
  possible, and it is the case that used to be free only because everything was always loaded.
- Fewer tools in front of Claude usually means better tool choice, which matters most for the
  module that writes to real Asana data.
- The mechanism is general: `defer_loading` travels through the registry, and the search tool is
  added automatically whenever any module defers anything. Nothing about it is Asana-specific.
- `/costs` is what tells us whether this worked, and whether the long tail is used at all. If a
  month of traffic never searches for a deferred tool, the deferred list is simply dead weight and
  can be trimmed; if it searches often, the everyday list is wrong and should grow.

## Alternatives considered

- **A curated list alone**, with the rest removed. Cheapest and simplest, but it puts a ceiling on
  Asana: anything unlisted becomes impossible, and the gap is discovered in front of a user.
- **Tool search alone**, deferring everything. Rejected: the API refuses it, and every ordinary
  request would pay for a search step it does not need.
- **A longer cache TTL** (one hour instead of five minutes). Complementary, not an alternative —
  worth measuring next, since it cuts the cost of the *first* request in a burst, which is the
  expensive one.

## Amendment, 2026-09-24: the first version of this did nothing

Two things in the context above were wrong, and together they meant the change saved nothing.

**The server offers about thirty tools, not a hundred.** Counted against the real tool list:
31. Still ~14,000 tokens on every request, so the decision stands — but the headline was
overstated.

**The "everyday" patterns kept 30 of those 31.** They were loose fragments — `/^get_/` alone kept
17, and `/me|current_user/` matched `add_com`**`me`**`nt` and `get_attach`**`me`**`nts`. Only
`delete_task` was ever deferred.

The tests did not catch it because they ran against seven invented tool names
(`duplicate_portfolio`, `reorder_sections`) chosen so the filter appeared to work. They proved the
mechanism — a deferred tool is still callable — and never the list. **A test of a filter has to
use the strings the filter will meet.**

Now:

- every pattern is anchored to a whole tool name, and 13 of 31 are loaded;
- below four matches the code loads everything, on the assumption that the patterns do not fit
  this server's naming rather than that Asana offers three tools;
- above 60% kept it logs a warning, because a curation that keeps almost everything costs the
  same as none and looks like it worked;
- the tests use the real names and assert the **ratio**, not just that the mechanism runs.

Cost, estimated from the payload: a first Asana request drops from ~7.7¢ to ~2.8¢. Measured
figures replace these once `/costs` has a week of data.
