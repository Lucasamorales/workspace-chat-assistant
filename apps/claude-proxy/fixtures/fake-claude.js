/**
 * A stand-in for the Claude CLI: same arguments, same stream-json protocol, and it calls the
 * real stub MCP server through a real MCP client. Only the model is fake, scripted by the words
 * in each user message:
 *
 *   "rename"         asks for update_tasks, waits for the held call, then reports its result
 *   "search first"   uses the built-in ToolSearch, then answers
 *   anything else    echoes the user's text back
 *
 * The auth source it reports is read from the system prompt ("FAKE_AUTH=..."), because the
 * proxy strips the environment down to an allow-list and a test variable would not get through.
 */

const fs = require('fs');
const readline = require('readline');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const args = process.argv.slice(2);
const arg = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const system = fs.readFileSync(arg('--system-prompt-file'), 'utf8');
const authSource = (system.match(/FAKE_AUTH=(\S+)/) || [])[1] || 'none';
const overage = /FAKE_OVERAGE_IN_USE/.test(system);
const overageStatus = /FAKE_EXTRA_USAGE_ON/.test(system) ? 'allowed' : 'rejected';
const model = arg('--model');
let reported = false;

const emit = obj => process.stdout.write(`${JSON.stringify(obj)}\n`);
let n = 0;

function message(blocks, stopReason) {
  n += 1;
  const id = `msg_fake_${process.pid}_${n}`;
  emit({ type: 'stream_event', event: { type: 'message_start', message: { id, model, usage: { input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 1 } } } });
  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      emit({ type: 'stream_event', event: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } } });
      emit({ type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } } });
    } else {
      emit({ type: 'stream_event', event: { type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name } } });
      const json = JSON.stringify(b.input);
      // Split the JSON the way the real stream does, to prove it is reassembled.
      emit({ type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(0, 5) } } });
      emit({ type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(5) } } });
    }
    emit({ type: 'stream_event', event: { type: 'content_block_stop', index } });
  });
  emit({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 20 } } });
  emit({ type: 'stream_event', event: { type: 'message_stop' } });
  // Like the real CLI: the window is reported just *after* the first reply, then not again.
  if (!reported) {
    reported = true;
    emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', isUsingOverage: overage, overageStatus, unifiedWindows: { five_hour: { utilization: 0.25, resetsAt: 1790610000 }, seven_day: { utilization: 0.05 } } } });
  }
}

async function main() {
  let client = null;
  const config = arg('--mcp-config');
  let tools = [];
  if (config) {
    const server = JSON.parse(fs.readFileSync(config, 'utf8')).mcpServers.buddy;
    client = new Client({ name: 'fake-claude', version: '0' });
    await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env: { ...process.env, ...server.env } }));
    tools = (await client.listTools()).tools.map(t => `mcp__buddy__${t.name}`);
  }
  const builtins = arg('--tools') === 'ToolSearch' ? ['ToolSearch'] : [];
  emit({ type: 'system', subtype: 'init', model, tools: [...builtins, ...tools], mcp_servers: client ? [{ name: 'buddy', status: 'connected' }] : [], apiKeySource: authSource });

  const rl = readline.createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const text = JSON.parse(line).message.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    // Behave like a model that follows the replay's instruction: history is context, not a request.
    const asked = text.includes('</conversation_so_far>') ? text.split('</conversation_so_far>').pop() : text;

    if (/rename/i.test(asked) && client) {
      const input = { tasks: [{ gid: '123', name: 'Hello' }] };
      message([{ type: 'text', text: 'Renaming it now.' }, { type: 'tool_use', id: `toolu_fake_${process.pid}_${n}`, name: 'mcp__buddy__update_tasks', input }], 'tool_use');
      // Held here until the proxy hands over Buddy's result.
      const result = await client.callTool({ name: 'update_tasks', arguments: input });
      const said = result.content.map(c => c.text).join('');
      message([{ type: 'text', text: result.isError ? `failed: ${said}` : `done: ${said}` }], 'end_turn');
    } else if (/search first/i.test(asked)) {
      message([{ type: 'tool_use', id: `toolu_search_${n}`, name: 'ToolSearch', input: { query: 'select:x' } }], 'tool_use');
      message([{ type: 'text', text: 'found it' }], 'end_turn');
    } else {
      message([{ type: 'text', text: `echo: ${text}` }], 'end_turn');
    }
    emit({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.001, duration_api_ms: 10 });
  }
  if (client) await client.close();
  process.exit(0);
}

main().catch(error => {
  process.stderr.write(String(error && error.stack));
  process.exit(3);
});
