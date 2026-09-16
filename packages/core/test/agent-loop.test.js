const test = require('node:test');
const assert = require('node:assert/strict');
const { runLoop, resumeLoop, executeApprovedItem, DECLINED, MAX_APPROVAL_ITEMS } = require('../src');

const noBudget = { check: async () => {}, record: async () => {} };

function scriptedClaude(responses) {
  const calls = [];
  return {
    calls,
    async create(params) {
      calls.push(structuredClone(params));
      const next = responses.shift();
      if (!next) throw new Error('unexpected extra call');
      return { usage: {}, ...next };
    },
  };
}

/** A toolset where "asana__create" is a batch tool that splits per entry of `tasks`. */
function toolset(readOnly) {
  const executed = [];
  return {
    executed,
    definitions: [{ name: 'asana__get', input_schema: {} }, { name: 'asana__create', input_schema: {} }],
    needsApproval: async name => !readOnly.includes(name),
    split: async (name, input) => (Array.isArray(input.tasks) && input.tasks.length > 1
      ? input.tasks.map(t => ({ ...input, tasks: [t] }))
      : [input]),
    describe: async (name, input, pos) => ({ module: 'asana', title: `${name} ${pos.part + 1}/${pos.of}`, effect: 'create', fields: [] }),
    execute: async (name, input) => { executed.push({ name, input }); return { content: `${name} ok` }; },
  };
}

const toolUse = (id, name, input = {}) => ({ type: 'tool_use', id, name, input });

test('read-only calls run; the loop finishes with text', async () => {
  const claude = scriptedClaude([
    { stop_reason: 'tool_use', content: [toolUse('1', 'asana__get')] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] },
  ]);
  const ts = toolset(['asana__get']);
  const r = await runLoop({ claude, toolset: ts, budget: noBudget, system: 's', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 'done');
  assert.equal(r.text, 'done');
  assert.deepEqual(ts.executed.map(e => e.name), ['asana__get']);
});

test('a batch write pauses BEFORE anything runs and becomes one item per entry', async () => {
  const claude = scriptedClaude([
    { stop_reason: 'tool_use', content: [toolUse('r', 'asana__get'), toolUse('w', 'asana__create', { tasks: [{ name: 'A' }, { name: 'B' }] })] },
  ]);
  const ts = toolset(['asana__get']);
  const paused = await runLoop({ claude, toolset: ts, budget: noBudget, system: 's', messages: [{ role: 'user', content: 'x' }] });

  assert.equal(paused.status, 'needs_approval');
  assert.deepEqual(paused.items.map(i => i.input.tasks[0].name), ['A', 'B']);
  assert.ok(paused.items.every(i => i.useId === 'w' && i.state === 'pending'));
  assert.deepEqual(ts.executed.map(e => e.name), ['asana__get'], 'nothing that writes has run');
});

test('approve one, decline one: only the approved entry runs; Claude gets one combined result', async () => {
  const claude = scriptedClaude([
    { stop_reason: 'tool_use', content: [toolUse('r', 'asana__get'), toolUse('w', 'asana__create', { tasks: [{ name: 'A' }, { name: 'B' }] })] },
  ]);
  const paused = await runLoop({ claude, toolset: toolset(['asana__get']), budget: noBudget, system: 's', messages: [{ role: 'user', content: 'x' }] });

  // Simulate storage + clicks handled on another instance.
  const saved = JSON.parse(JSON.stringify(paused.saved));
  const items = JSON.parse(JSON.stringify(paused.items));
  const ts2 = toolset(['asana__get']);
  items[0].result = await executeApprovedItem(ts2, items[0]);
  items[0].state = 'done';
  items[1].state = 'declined';

  const claude2 = scriptedClaude([{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Created A, skipped B.' }] }]);
  const r = await resumeLoop({ claude: claude2, toolset: ts2, budget: noBudget, system: 's', saved, items });

  assert.equal(r.text, 'Created A, skipped B.');
  assert.deepEqual(ts2.executed, [{ name: 'asana__create', input: { tasks: [{ name: 'A' }] } }]);
  const blocks = claude2.calls[0].messages.at(-1).content;
  assert.deepEqual(blocks.map(b => b.tool_use_id), ['r', 'w'], 'all results returned together, in order');
  assert.match(blocks[1].content, /Part 1 of 2.*asana__create ok/s);
  assert.match(blocks[1].content, /Part 2 of 2.*declined/s);
  assert.equal(blocks[1].is_error, undefined, 'partly done is not an error');
});

test('declining everything sends an error result and runs nothing', async () => {
  const claude = scriptedClaude([{ stop_reason: 'tool_use', content: [toolUse('w', 'asana__create', { tasks: [{ name: 'A' }] })] }]);
  const paused = await runLoop({ claude, toolset: toolset([]), budget: noBudget, system: 's', messages: [{ role: 'user', content: 'x' }] });
  const items = paused.items.map(it => ({ ...it, state: 'declined' }));
  const claude2 = scriptedClaude([{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok, left it' }] }]);
  const ts2 = toolset([]);
  await resumeLoop({ claude: claude2, toolset: ts2, budget: noBudget, system: 's', saved: paused.saved, items });
  assert.equal(ts2.executed.length, 0);
  const block = claude2.calls[0].messages.at(-1).content[0];
  assert.equal(block.is_error, true);
  assert.equal(block.content, DECLINED);
});

test('too many changes at once are refused instead of shown on a giant card', async () => {
  const tasks = Array.from({ length: MAX_APPROVAL_ITEMS + 1 }, (_, i) => ({ name: `T${i}` }));
  const claude = scriptedClaude([
    { stop_reason: 'tool_use', content: [toolUse('w', 'asana__create', { tasks })] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'please split it' }] },
  ]);
  const ts = toolset([]);
  const r = await runLoop({ claude, toolset: ts, budget: noBudget, system: 's', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.status, 'done');
  assert.equal(ts.executed.length, 0);
  assert.match(claude.calls[1].messages.at(-1).content[0].content, /Too many changes/);
});

test('pause_turn continues; max steps stops runaway loops; budget is checked every step', async () => {
  const claude = scriptedClaude([
    { stop_reason: 'pause_turn', content: [{ type: 'text', text: '…' }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'fine' }] },
  ]);
  const r = await runLoop({ claude, toolset: toolset([]), budget: noBudget, system: 's', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.text, 'fine');

  const forever = { async create() { return { usage: {}, stop_reason: 'tool_use', content: [toolUse('1', 'asana__get')] }; } };
  const capped = await runLoop({ claude: forever, toolset: toolset(['asana__get']), budget: noBudget, system: 's', messages: [], maxSteps: 3 });
  assert.equal(capped.stopReason, 'max_steps');

  let checks = 0;
  const budget = { check: async () => { checks += 1; if (checks > 1) throw new Error('over budget'); }, record: async () => {} };
  await assert.rejects(runLoop({ claude: forever, toolset: toolset(['asana__get']), budget, system: 's', messages: [] }), /over budget/);
});
