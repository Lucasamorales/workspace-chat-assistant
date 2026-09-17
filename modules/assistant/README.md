# Module: assistant

Free-form chat with Claude through Buddy. It has no code of its own: enabling it, and its
access rule, decide **who can talk to Claude**.

- `BUDDY_ACCESS_ASSISTANT` — who can chat with Claude (every conversation costs money; the
  per-user `MONTHLY_USD_CAP` still applies).
- People without it still get modules that don't need Claude (Kudos votes, commands). Any other
  message gets a short "here's what I can do" card instead of a Claude reply, at no cost.
- Modules marked `needsConversation` (Asana, files) are hidden from people without it.

Tests: `npm test --workspace @buddy/module-assistant`
