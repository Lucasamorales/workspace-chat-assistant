const test = require('node:test');
const assert = require('node:assert/strict');
const { runLoop, resumeLoop, DECLINED } = require('../src');

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

function toolset(readOnly) {
  const executed = [];
  return {
    executed,
    definitions: [{ name: 'asana__get', input_schema: {} }, { name: 'asana__delete', input_schema: {} }],
    needsApproval: async name => !readOnly.includes(name),
    describe: name => ({ module: 'asana', title: name }),
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
  const lastSent = claude.calls[1].messages.at(-1);
  assert.equal(lastSent.content[0].type, 'tool_result');
});

test('a write call stops the loop BEFORE anything runs, then resumes on approval', async () => {
  const claude = scriptedClaude([
    { stop_reason: 'tool_use', content: [toolUse('r', 'asana__get'), toolUse('w', 'asana__delete', { task: 42 })] },
  ]);
  const ts = toolset(['asana__get']);
  const paused = await runLoop({ claude, toolset: ts, budget: noBudget, system: 's', messages: [{ role: 'user', content: 'delete it' }] });

  assert.equal(paused.status, 'needs_approval');
  assert.deepEqual(paused.pending.map(p => p.name), ['asana__delete']);
  assert.deepEqual(ts.executed.map(e => e.name), ['asana__get'], 'the delete must not have run');

  // Simulate storage round trip + a different instance.
  const saved = JSON.parse(JSON.stringify(paused.saved));
  const claude2 = scriptedClaude([{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'deleted' }] }]);
  const ts2 = toolset(['asana__get']);
  const r = await resumeLoop({ claude: claude2, toolset: ts2, budget: noBudget, system: 's', saved, approved: true });

  assert.equal(r.text, 'deleted');
  assert.deepEqual(ts2.executed, [{ name: 'asana__delete', input: { task: 42 } }], 'only the approved call runs, exactly once');
  const results = claude2.calls[0].messages.at(-1).content;
  assert.deepEqual(results.map(b => b.tool_use_id), ['r', 'w'], 'all results returned together, in order');
});

test('declining sends an error result and runs nothing', async () => {
  const claude = scriptedClaude([{ stop_reason: 'tool_use', content: [toolUse('w', 'asana__delete')] }]);
  const paused = await runLoop({ claude, toolset: toolset([]), budget: noBudget, system: 's', messages: [{ role: 'user', content: 'x' }] });
  const claude2 = scriptedClaude([{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok, left it' }] }]);
  const ts2 = toolset([]);
  await resumeLoop({ claude: claude2, toolset: ts2, budget: noBudget, system: 's', saved: paused.saved, approved: false });
  assert.equal(ts2.executed.length, 0);
  const block = claude2.calls[0].messages.at(-1).content[0];
  assert.equal(block.is_error, true);
  assert.equal(block.content, DECLINED);
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
