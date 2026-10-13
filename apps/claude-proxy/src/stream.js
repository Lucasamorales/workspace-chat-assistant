/**
 * The CLI's stream-json output, turned into whole API messages.
 *
 * One reply arrives as many events: `message_start`, blocks opening, deltas, `message_delta`
 * with the stop reason and final usage, then `message_stop`. Messages are built from these
 * stream events rather than from the `assistant` snapshots the CLI also prints, because the
 * snapshots arrive once per block and their usage undercounts: thinking tokens only appear in
 * the final delta (the spike: a snapshot said 3 output tokens, the truth was 44).
 *
 * Emits:
 *   init        the CLI's system/init event (tools, MCP servers, auth source)
 *   message     { id, model, blocks, stopReason, usage } once a whole API message is in
 *   rate_limit  the subscription window: utilisation, reset times, whether overage is in use
 *   result      the end of a user turn, with totals
 *   noise       a line that was not JSON (logged, never fatal)
 */

const { EventEmitter } = require('events');

function createStreamParser() {
  const emitter = new EventEmitter();
  let buffer = '';
  let current = null;

  function onStreamEvent(ev) {
    switch (ev.type) {
      case 'message_start': {
        const m = ev.message || {};
        current = { id: m.id, model: m.model, blocks: [], stopReason: null, usage: { ...(m.usage || {}) } };
        break;
      }
      case 'content_block_start': {
        if (!current) return;
        const b = ev.content_block || {};
        current.blocks[ev.index] = b.type === 'tool_use'
          ? { type: 'tool_use', id: b.id, name: b.name, json: '' }
          : { type: b.type, text: b.text || '' };
        break;
      }
      case 'content_block_delta': {
        const block = current && current.blocks[ev.index];
        if (!block || !ev.delta) return;
        if (ev.delta.type === 'text_delta') block.text += ev.delta.text || '';
        if (ev.delta.type === 'input_json_delta') block.json += ev.delta.partial_json || '';
        break;
      }
      case 'content_block_stop': {
        const block = current && current.blocks[ev.index];
        if (block && block.type === 'tool_use') {
          try {
            block.input = block.json ? JSON.parse(block.json) : {};
          } catch {
            block.input = {};
            block.badJson = true;
          }
          delete block.json;
        }
        break;
      }
      case 'message_delta': {
        if (!current) return;
        if (ev.delta && ev.delta.stop_reason) current.stopReason = ev.delta.stop_reason;
        // The final delta carries the true output count; input figures may repeat. Latest wins.
        if (ev.usage) for (const [k, v] of Object.entries(ev.usage)) if (typeof v === 'number') current.usage[k] = v;
        break;
      }
      case 'message_stop': {
        if (!current) return;
        const done = { ...current, blocks: current.blocks.filter(Boolean) };
        current = null;
        emitter.emit('message', done);
        break;
      }
      default:
        break;
    }
  }

  function onLine(line) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      emitter.emit('noise', line.slice(0, 300));
      return;
    }
    if (ev.type === 'stream_event' && ev.event) onStreamEvent(ev.event);
    else if (ev.type === 'system' && ev.subtype === 'init') emitter.emit('init', ev);
    else if (ev.type === 'rate_limit_event') emitter.emit('rate_limit', ev.rate_limit_info || {});
    else if (ev.type === 'result') emitter.emit('result', ev);
  }

  emitter.feed = chunk => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) if (line.trim()) onLine(line.trim());
  };
  emitter.end = () => {
    if (buffer.trim()) onLine(buffer.trim());
    buffer = '';
  };
  return emitter;
}

module.exports = { createStreamParser };
