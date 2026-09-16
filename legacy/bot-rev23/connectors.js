/**
 * Connector registry.
 *
 * To add a service: register an OAuth app with the vendor, store its secret in Secret
 * Manager, mount it as an env var, and add a block here. No other code changes.
 *
 * Fields:
 *   label          human name used in Chat replies
 *   mcpUrl         remote MCP endpoint passed to the Anthropic Messages API
 *   authorizeUrl   vendor's OAuth consent endpoint
 *   tokenUrl       vendor's token exchange endpoint
 *   scope          space-separated scopes, or null if the vendor has none
 *   clientId       from env
 *   clientSecret   from env (mounted from Secret Manager)
 *   refreshable    true if the vendor issues refresh tokens
 *   defaultTtlMs   fallback lifetime when the vendor omits expires_in
 */

const CONNECTORS = {
  asana: {
    label: 'Asana',
    mcpUrl: process.env.ASANA_MCP_URL || 'https://mcp.asana.com/v2/mcp',
    authorizeUrl: 'https://app.asana.com/-/oauth_authorize',
    tokenUrl: 'https://app.asana.com/-/oauth_token',
    scope: 'default',
    clientId: process.env.ASANA_CLIENT_ID,
    clientSecret: process.env.ASANA_CLIENT_SECRET,
    refreshable: true,
    defaultTtlMs: 3600 * 1000,        // Asana access tokens last 1 hour
  },

  clickup: {
    label: 'ClickUp',
    responseType: false,
    mcpUrl: process.env.CLICKUP_MCP_URL || 'https://mcp.clickup.com/mcp',
    authorizeUrl: 'https://app.clickup.com/api',
    tokenUrl: 'https://api.clickup.com/api/v2/oauth/token',
    scope: null,                      // ClickUp's OAuth flow has no scope parameter
    clientId: process.env.CLICKUP_CLIENT_ID,
    clientSecret: process.env.CLICKUP_CLIENT_SECRET,
    refreshable: false,               // no refresh token issued; treat as long-lived
    defaultTtlMs: null,               // null = never expires
    responseType: false,
  },
};

/** Connectors that are fully configured (client id + secret present). */
function available() {
  return Object.entries(CONNECTORS)
    .filter(([, c]) => c.clientId && c.clientSecret)
    .map(([name]) => name);
}

function get(name) {
  const c = CONNECTORS[name];
  if (!c) throw new Error(`Unknown connector: ${name}`);
  if (!c.clientId || !c.clientSecret) throw new Error(`${c.label} is not configured on this deployment.`);
  return c;
}

module.exports = { CONNECTORS, available, get };
