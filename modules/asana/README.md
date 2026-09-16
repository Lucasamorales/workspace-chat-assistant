# Module: asana

Acts in Asana as the user, through Asana's MCP server (`https://mcp.asana.com/v2/mcp`), with
Buddy as the MCP client. DMs only.

- Commands: `/asana connect | status | disconnect`
- Settings: `ASANA_CLIENT_ID`, `ASANA_CLIENT_SECRET` (required); `ASANA_READONLY_TOOLS`
  (comma list of tools that may skip approval), `ASANA_REQUIRE_EMAIL_MATCH` (default true)
- Storage: `m_asana__tokens/{userId}` — KMS-encrypted token bundle
- Approval: any tool not annotated `readOnlyHint: true` (and not destructive) needs a click

Tests: `npm test --workspace @buddy/module-asana`
