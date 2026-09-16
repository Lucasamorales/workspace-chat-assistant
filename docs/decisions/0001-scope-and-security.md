# 0001 — Scope and security decisions

Date: 2026-09-16 · Decided by: Robin (full authority over the project, taken over from Remy)

| # | Question | Decision |
|---|---|---|
| 1 | Asana in shared spaces | **DMs only.** In spaces Buddy is chat-only; Asana tools are never attached. |
| 2 | What Buddy may do in Asana | **Everything** the user's own Asana permissions allow, including deletes. |
| 3 | MCP connector vs. self-hosted MCP client | _Open_ — see options write-up. |
| 4 | Thread history retention | **30 days** (Firestore TTL on `updated`). |
| 5 | Code location | Local `Documents/your-company/Projects/Buddy`; GitHub once working. |
| 6 | Remy's project Owner role | **Keep.** Add Robin as Owner. |
| — | ClickUp | **Removed.** Asana only for now. |
| — | Architecture | Small core + independent modules (see README). |
| — | Who may use Buddy (Google group) | _Open._ |

## Consequences
- Because of (2), write and delete actions need a hard safeguard in code, not just a
  sentence in the system prompt. How strong that safeguard can be depends on (3).
- Because of (1), a Chat space never receives data from one person's Asana.
