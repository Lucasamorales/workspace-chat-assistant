/**
 * Asana tools via Asana's MCP server, with Buddy as the MCP client (decision 0001 #3).
 * The user's token goes only to mcp.asana.com, from our own service.
 */

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const tokens = require('./tokens');
const { splitInput, describeTool, describeFields, createNameResolver } = require('./present');

const DEFAULT_MCP_URL = 'https://mcp.asana.com/v2/mcp';
const MAX_TOOLS = 100;

/**
 * Asana's MCP server offers around a hundred tools, and every definition is re-sent on every
 * request — tens of thousands of tokens before anyone has typed a word. So only the tools people
 * actually use are loaded; the rest are deferred, and Claude pulls one in when it needs it.
 *
 * Nothing becomes impossible: a deferred tool is still callable, it just isn't paid for up front.
 * `ASANA_TOOLS` overrides this list; if neither matches anything, everything is loaded, because
 * a cheaper Asana that cannot do its job is not cheaper.
 */
const EVERYDAY = [
  /search/i, /list/i, /^(asana_)?get_/i, /create/i, /update/i,
  /complete/i, /comment|story/i, /me|current_user/i, /project/i, /workspace/i,
];

function splitTools(tools, setting, log) {
  const wanted = String(setting || '').split(',').map(s => s.trim()).filter(Boolean);
  const keep = wanted.length
    ? tools.filter(t => wanted.includes(t.name))
    : tools.filter(t => EVERYDAY.some(re => re.test(t.name)));

  if (wanted.length) {
    const unknown = wanted.filter(name => !tools.some(t => t.name === name));
    if (unknown.length) log.warn('ASANA_TOOLS names no such tool', { unknown });
  }
  // Fail open: never leave Claude with nothing to work with.
  if (!keep.length) return { loaded: tools, deferred: [] };
  const names = new Set(keep.map(t => t.name));
  return { loaded: keep, deferred: tools.filter(t => !names.has(t.name)) };
}

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
    if (e.notConnected) return { connect: { reason: e.reason } };
    throw e;
  }

  let client;
  try {
    client = await connect(mcpUrl(ctx.settings), accessToken);
  } catch (e) {
    // Access removed on Asana's side while our token still looked valid: treat as disconnected
    // so the user gets a Reconnect button instead of a generic failure.
    if (e.code === 401 || /\b401\b|unauthori[sz]ed/i.test(String(e.message))) {
      await tokens.forget(ctx);
      return { connect: { reason: 'expired' } };
    }
    throw e;
  }
  let tools;
  try {
    tools = await listAllTools(client);
  } catch (e) {
    await client.close().catch(() => {});
    throw e;
  }

  const byName = new Map(tools.map(t => [t.name, t]));
  const readOnlyOverrides = String(ctx.settings.ASANA_READONLY_TOOLS || '').split(',').map(s => s.trim()).filter(Boolean);
  const needsApproval = name => needsApprovalFor(byName.get(name), readOnlyOverrides);

  const resolveName = createNameResolver({
    tools: byName,
    isReadOnly: name => !needsApproval(name),
    callTool: async (name, args) => renderResult(await client.callTool({ name, arguments: args })),
  });

  const { loaded, deferred } = splitTools(tools, ctx.settings.ASANA_TOOLS, ctx.log);
  ctx.log.info('asana tools', { loaded: loaded.length, deferred: deferred.length });
  const define = (t, defer) => ({
    name: t.name,
    description: t.description || t.title || t.name,
    input_schema: t.inputSchema || { type: 'object' },
    // Deferred definitions are not sent up front; Claude finds them with the tool-search tool
    // and they are then called like any other.
    ...(defer ? { defer_loading: true } : {}),
  });

  return {
    loadedTools: loaded.map(t => t.name),
    deferredTools: deferred.map(t => t.name),

    definitions: [...loaded.map(t => define(t, false)), ...deferred.map(t => define(t, true))],

    needsApproval,

    split: (name, input) => splitInput(input),

    async describe(name, input, position = { of: 1 }) {
      const tool = byName.get(name);
      const { effect, title } = describeTool(name, (tool && tool.annotations) || {}, position.of > 1);
      return { effect, title, fields: await describeFields(name, input, resolveName) };
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
