/**
 * The MCP server the CLI launches, one per session.
 *
 * It declares Buddy's tools and runs none of them. Every call is relayed to the proxy over
 * loopback, and the proxy holds it open until Buddy has run the tool itself — behind its
 * approval card when the tool writes — and sent the result back. So the CLI believes it called a
 * tool; in fact it asked Buddy to, and Buddy's rules decided.
 *
 * The relay uses http.request rather than fetch on purpose: fetch gives up on a response that
 * takes longer than five minutes to start, and an approval card can take fifteen.
 */

const fs = require('fs');
const http = require('http');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const tools = JSON.parse(fs.readFileSync(process.env.BUDDY_TOOLS_FILE, 'utf8'));
const target = new URL(process.env.BUDDY_CALLBACK_URL);

function relay(name, args) {
  const body = JSON.stringify({ session: process.env.BUDDY_SESSION, secret: process.env.BUDDY_SESSION_SECRET, name, args });
  return new Promise(resolve => {
    const req = http.request({
      hostname: target.hostname, port: target.port, path: '/call', method: 'POST', agent: false,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', d => { text += d; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(text));
        } catch {
          resolve({ isError: true, content: `The proxy answered with something unreadable (HTTP ${res.statusCode}).` });
        }
      });
    });
    req.setTimeout(0);
    req.on('error', error => resolve({ isError: true, content: `Could not reach the proxy: ${error.message}` }));
    req.end(body);
  });
}

const server = new Server({ name: 'buddy', version: '0.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const result = await relay(request.params.name, request.params.arguments || {});
  return { content: [{ type: 'text', text: String(result.content ?? '') }], isError: Boolean(result.isError) };
});
server.connect(new StdioServerTransport());
