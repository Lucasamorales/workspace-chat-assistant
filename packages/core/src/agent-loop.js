/**
 * The Claude tool loop, with a hard human-approval gate.
 *
 * Read-only tool calls run immediately. If Claude asks for any call that needs approval,
 * the loop STOPS and returns its full state; nothing that changes data has run. The caller
 * stores that state, shows Approve/Cancel, and later calls resumeLoop() with the decision
 * (possibly on another instance, minutes later). This is why it's a manual loop and not
 * the SDK tool runner: the pause has to survive across separate HTTP requests.
 */

const MAX_RESULT_CHARS = 30_000;
const DECLINED = 'The user declined this action. It was not performed. Do not retry it unless they ask again.';

function textOf(content) {
  return content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

function resultBlock(id, result) {
  const content = String(result.content ?? '');
  return {
    type: 'tool_result',
    tool_use_id: id,
    content: content.length > MAX_RESULT_CHARS ? `${content.slice(0, MAX_RESULT_CHARS)}\n[truncated]` : content,
    ...(result.isError ? { is_error: true } : {}),
  };
}

async function runTool(toolset, use) {
  try {
    return await toolset.execute(use.name, use.input);
  } catch (e) {
    return { content: `Tool failed: ${String(e.message).slice(0, 300)}`, isError: true };
  }
}

async function drive({ claude, system, toolset, budget, maxSteps, log }, messages, stepsUsed) {
  let steps = stepsUsed;
  while (steps < maxSteps) {
    await budget.check();
    const res = await claude.create({ system, tools: toolset.definitions, messages });
    steps += 1;
    await budget.record(res.usage || {});
    messages.push({ role: 'assistant', content: res.content });

    if (res.stop_reason === 'pause_turn') continue;
    if (res.stop_reason !== 'tool_use') {
      return { status: 'done', text: textOf(res.content), stopReason: res.stop_reason, messages };
    }

    const uses = res.content.filter(b => b.type === 'tool_use');
    const results = {};
    const pending = [];
    for (const use of uses) {
      if (await toolset.needsApproval(use.name, use.input)) {
        pending.push({ id: use.id, name: use.name, input: use.input, ...toolset.describe(use.name, use.input) });
      } else {
        results[use.id] = await runTool(toolset, use);
      }
    }

    if (pending.length) {
      log.info('tool calls awaiting approval', { tools: pending.map(p => p.name) });
      return { status: 'needs_approval', pending, saved: { messages, results, steps } };
    }
    messages.push({ role: 'user', content: uses.map(u => resultBlock(u.id, results[u.id])) });
  }
  return { status: 'done', text: '', stopReason: 'max_steps', messages };
}

function runLoop(opts) {
  return drive(withDefaults(opts), [...opts.messages], 0);
}

/**
 * @param opts.saved     the `saved` object returned with status 'needs_approval'
 * @param opts.approved  true to run the pending calls, false to decline them
 */
async function resumeLoop(opts) {
  const o = withDefaults(opts);
  const { messages, results, steps } = opts.saved;
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant') throw new Error('saved loop state is not awaiting tool results');

  const uses = last.content.filter(b => b.type === 'tool_use');
  const blocks = [];
  for (const use of uses) {
    let result = results[use.id];
    if (!result) result = opts.approved ? await runTool(o.toolset, use) : { content: DECLINED, isError: true };
    blocks.push(resultBlock(use.id, result));
  }
  return drive(o, [...messages, { role: 'user', content: blocks }], steps);
}

function withDefaults(opts) {
  return { maxSteps: 12, log: { info() {}, warn() {}, error() {} }, ...opts };
}

module.exports = { runLoop, resumeLoop, textOf, DECLINED };
