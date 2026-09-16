const test = require('node:test');
const assert = require('node:assert/strict');
const { splitInput, describeTool, describeFields, createNameResolver } = require('../src/present');

// The exact calls from the first live test (Remy's screenshots).
const CREATE = {
  tasks: [
    { name: 'Give Robin feedback about client scope', notes: 'Robin needs feedback on the client scope thing', assignee: 'me', due_on: '2026-09-17', workspace: '0000000000000000' },
    { name: 'Burn After reading', notes: 'burn everything', assignee: 'me', due_on: '2026-09-16', followers: '1210352158486920', workspace: '0000000000000000' },
  ],
};
const UPDATE = { tasks: [{ task: '1208706746926007', due_on: '2026-09-17' }] };

const NAMES = {
  get_user: { '1210352158486920': 'Robin' },
  get_task: { '1208706746926007': 'Quarterly review' },
  get_workspace: { '0000000000000000': 'Your Company' },
};

function fakeServer({ failLookups = false } = {}) {
  const calls = [];
  const tools = new Map([
    ['get_user', { name: 'get_user', inputSchema: { type: 'object', properties: { user_gid: {} }, required: ['user_gid'] } }],
    ['get_task', { name: 'get_task', inputSchema: { type: 'object', properties: { task_gid: {}, opt_fields: {} }, required: ['task_gid'] } }],
    ['get_workspace', { name: 'get_workspace', inputSchema: { type: 'object', properties: { workspace_gid: {} }, required: ['workspace_gid'] } }],
  ]);
  const resolve = createNameResolver({
    tools,
    isReadOnly: () => true,
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (failLookups) throw new Error('boom');
      const id = Object.values(args)[0];
      return JSON.stringify({ data: { gid: id, name: NAMES[name][id] } });
    },
  });
  return { resolve, calls };
}

test('a batch of two tasks becomes two separately executable calls', () => {
  const parts = splitInput(CREATE);
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[1], { tasks: [CREATE.tasks[1]] });
  assert.deepEqual(splitInput(UPDATE), [UPDATE], 'a single entry is left alone');
  assert.deepEqual(splitInput({ a: [1, 2] }), [{ a: [1, 2] }], 'lists of plain values are not split');
});

test('titles and effects: updating a due date is not "cannot be undone"', () => {
  assert.deepEqual(describeTool('create_tasks', {}, true), { effect: 'create', title: 'Create task' });
  assert.deepEqual(describeTool('update_tasks', { destructiveHint: true }, false), { effect: 'update', title: 'Update tasks' });
  assert.equal(describeTool('delete_task').effect, 'delete');
});

test('fields are labelled, ordered, dated and use names instead of ids', async () => {
  const { resolve } = fakeServer();
  const [, burn] = splitInput(CREATE);
  const fields = await describeFields('create_tasks', burn, resolve);
  assert.deepEqual(fields, [
    { label: 'Task title', value: 'Burn After reading' },
    { label: 'Description', value: 'burn everything' },
    { label: 'Due date', value: 'Wed 16 Sep 2026' },
    { label: 'Assignee', value: 'You' },
    { label: 'Collaborators', value: 'Robin' },
    { label: 'Workspace', value: 'Your Company' },
  ]);

  const update = await describeFields('update_tasks', UPDATE, resolve);
  assert.deepEqual(update, [
    { label: 'Task', value: 'Quarterly review' },
    { label: 'Due date', value: 'Thu 17 Sep 2026' },
  ]);
});

test('lookups are cached, and a failed lookup shows the id instead of blocking approval', async () => {
  const ok = fakeServer();
  for (const part of splitInput(CREATE)) await describeFields('create_tasks', part, ok.resolve);
  assert.equal(ok.calls.filter(c => c.name === 'get_workspace').length, 1);

  const broken = fakeServer({ failLookups: true });
  const fields = await describeFields('update_tasks', UPDATE, broken.resolve);
  assert.deepEqual(fields.find(f => f.label === 'Task'), { label: 'Task', value: '1208706746926007' });
});

test('lookups never use tools that could change data', async () => {
  const calls = [];
  const resolve = createNameResolver({
    tools: new Map([['get_user', { name: 'get_user', inputSchema: { required: ['user_gid'] } }]]),
    isReadOnly: () => false,
    callTool: async (...args) => { calls.push(args); return '{}'; },
  });
  assert.equal(await resolve('user', '123'), '123');
  assert.equal(calls.length, 0);
});
