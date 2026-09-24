# Module: asana

Acts in Asana as the user, through Asana's MCP server (`https://mcp.asana.com/v2/mcp`), with
Buddy as the MCP client. DMs only.

**Access:** `BUDDY_ACCESS_ASANA` alone — it does **not** need `BUDDY_ACCESS_ASSISTANT`. Asana drives
Claude for itself (`scopedConversation`), so someone can work in Asana by asking without being given
free-form Claude: Claude gets only Asana's tools, declines anything else, and that person is on the
smaller `MONTHLY_USD_CAP_SCOPED` allowance. See `docs/decisions/0007-scoped-conversation.md`.

- Commands: `/asana connect | status | tools | disconnect`
- **Tool payload:** the everyday tools are loaded on every request; the rest are deferred and
  looked up with the tool-search tool when needed (`ASANA_TOOLS` to name the list exactly).
  Nothing is unreachable — see `docs/decisions/0008-tool-payload.md`.
- Settings: `ASANA_CLIENT_ID`, `ASANA_CLIENT_SECRET` (required); `ASANA_READONLY_TOOLS`
  (comma list of tools that may skip approval), `ASANA_REQUIRE_EMAIL_MATCH` (default true)
- Storage: `m_asana__tokens/{userId}` — KMS-encrypted token bundle
- Approval: any tool not annotated `readOnlyHint: true` (and not destructive) needs a click. Batch calls are split one card section per task; ids are shown as names via read-only `get_<type>` lookups (`src/present.js`)

Tests: `npm test --workspace @buddy/module-asana`
