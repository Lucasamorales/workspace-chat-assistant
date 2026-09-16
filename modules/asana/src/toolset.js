/**
 * Asana tools via Asana's MCP server, with Buddy as the MCP client (decision 0001 #3).
 * The user's token goes only to mcp.asana.com, from our own service.
 */

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const tokens = require('./tokens');

const DEFAULT_MCP_URL = 'https://mcp.asana.com/v2/mcp';
const MAX_TOOLS = 100;

function mcpUrl(settings) {
  const raw = settings.ASANA_MCP_URL || DEFAULT_MCP_URL;
  const url = new URL(raw);
  // Never send a user's Asana token anywhere except Asana.
  if (url.protocol !== 'https:' || url.hostname !== 'mcp.asana.com') {
    throw new Error(`ASANA_MCP_URL must be an https://mcp.asana.com URL, got ${raw}`);
  }
  return url;
}

async function connectMcp(url, accessToken) {
  const client = new Client({ name: 'buddy', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  await client.connect(transport);
  return client;
}

async function listAllTools(client) {
  const all = [];
  let cursor;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    all.push(...(page.tools || []));
    cursor = page.nextCursor;
  } while (cursor && all.length < MAX_TOOLS);
  return all.slice(0, MAX_TOOLS);
}

function renderResult(result) {
  const parts = (result.content || []).map(item => {
    if (item.type === 'text') return item.text;
    if (item.type === 'resource' && item.resource && item.resource.text) return item.resource.text;
    return `[${item.type} content omitted]`;
  });
  if (!parts.length && result.structuredContent) parts.push(JSON.stringify(result.structuredContent));
  return parts.join('\n') || '(no content)';
}

/**
 * Only calls that the server explicitly marks read-only AND not destructive skip approval.
 * An admin can also list known read-only tools in ASANA_READONLY_TOOLS. Everything else,
 * including unknown or unannotated tools, needs the user's click.
 */
function needsApprovalFor(tool, readOnlyOverrides) {
  if (!tool) return true;
  if (readOnlyOverrides.includes(tool.name)) return false;
  const a = tool.annotations || {};
  return !(a.readOnlyHint === true && a.destructiveHint !== true);
}

async function createAsanaToolset(ctx, { connect = connectMcp } = {}) {
  let accessToken;
  try {
    accessToken = await tokens.accessToken(ctx);
  } catch (e) {
    if (e.notConnected) {
      return { unavailable: `${e.message} Tell the user to send \`/asana connect\` in this direct message to connect their account.` };
    }
    throw e;
  }

  const client = await connect(mcpUrl(ctx.settings), accessToken);
  let tools;
  try {
    tools = await listAllTools(client);
  } catch (e) {
    await client.close().catch(() => {});
    throw e;
  }

  const byName = new Map(tools.map(t => [t.name, t]));
  const readOnlyOverrides = String(ctx.settings.ASANA_READONLY_TOOLS || '').split(',').map(s => s.trim()).filter(Boolean);

  return {
    definitions: tools.map(t => ({
      name: t.name,
      description: t.description || t.title || t.name,
      input_schema: t.inputSchema || { type: 'object' },
    })),

    needsApproval: name => needsApprovalFor(byName.get(name), readOnlyOverrides),

    describe(name) {
      const t = byName.get(name);
      const a = (t && t.annotations) || {};
      return { title: a.title || (t && t.title) || name, destructive: a.destructiveHint === true };
    },

    async execute(name, input) {
      if (!byName.has(name)) return { content: `Unknown Asana tool ${name}.`, isError: true };
      ctx.log.info('asana tool call', { tool: name, userId: ctx.userId });
      const result = await client.callTool({ name, arguments: input || {} });
      return { content: renderResult(result), isError: Boolean(result.isError) };
    },

    close: () => client.close(),
  };
}

module.exports = { createAsanaToolset, needsApprovalFor, renderResult, mcpUrl };
