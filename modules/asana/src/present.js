/**
 * Turns raw Asana MCP tool calls into something a person can approve:
 * one item per task, labelled fields, names instead of ids, readable dates.
 */

// The object being changed comes first, then what it will look like.
const FIELD_ORDER = [
  'task', 'name', 'text', 'notes', 'html_notes', 'html_text', 'due_on', 'due_at', 'start_on', 'start_at',
  'assignee', 'followers', 'collaborators', 'projects', 'project', 'section', 'parent',
  'tags', 'completed', 'resource_subtype', 'workspace',
];

const LABELS = {
  text: 'Comment', html_text: 'Comment', notes: 'Description', html_notes: 'Description',
  due_on: 'Due date', due_at: 'Due', start_on: 'Start date', start_at: 'Start',
  assignee: 'Assignee', followers: 'Collaborators', collaborators: 'Collaborators',
  projects: 'Projects', project: 'Project', section: 'Section', parent: 'Parent task', task: 'Task',
  tags: 'Tags', completed: 'Completed', resource_subtype: 'Type', workspace: 'Workspace',
};

// Plumbing parameters that say nothing about what will change.
const HIDDEN = new Set(['opt_fields', 'opt_pretty', 'limit', 'offset']);

// Parameters holding Asana ids, and the kind of object they point to.
const ID_TYPES = {
  assignee: 'user', followers: 'user', collaborators: 'user', projects: 'project', project: 'project',
  section: 'section', parent: 'task', task: 'task', tags: 'tag', workspace: 'workspace',
};

const MAX_VALUE_CHARS = 500;

function humanize(key) {
  return key.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
}

function labelFor(key, toolName) {
  if (key === 'name') {
    if (/task/.test(toolName)) return 'Task title';
    if (/project/.test(toolName)) return 'Project name';
    return 'Name';
  }
  return LABELS[key] || humanize(key);
}

/** "create_tasks" → effect 'create', title "Create task" (singular when one part of a batch). */
function describeTool(toolName, annotations = {}, singular = false) {
  let effect = 'change';
  if (/(^|_)(delete|remove)/.test(toolName)) effect = 'delete';
  else if (/^create|^add/.test(toolName)) effect = 'create';
  else if (/^(update|set|move|complete|mark|assign)/.test(toolName) || annotations.destructiveHint) effect = 'update';

  let title = annotations.title || humanize(toolName);
  if (singular) title = title.replace(/(\w+)s$/, '$1');
  return { effect, title };
}

/** A batch call with one list of objects becomes one call per object. */
function splitInput(input) {
  if (!input || typeof input !== 'object') return [input];
  const lists = Object.entries(input).filter(([, v]) => Array.isArray(v) && v.length > 1
    && v.every(x => x && typeof x === 'object' && !Array.isArray(x)));
  if (lists.length !== 1) return [input];
  const [key, list] = lists[0];
  return list.map(entry => ({ ...input, [key]: [entry] }));
}

/** The object whose fields describe the change: the single batch entry if there is one. */
function subjectOf(input) {
  const out = {};
  for (const [k, v] of Object.entries(input || {})) {
    if (Array.isArray(v) && v.length === 1 && v[0] && typeof v[0] === 'object' && !Array.isArray(v[0])) {
      Object.assign(out, v[0]);
    } else if (!(k in out)) {
      out[k] = v;
    }
  }
  return out;
}

function idsIn(value) {
  if (value === null || value === undefined) return [];
  const list = Array.isArray(value) ? value : String(value).split(',');
  return list.map(v => (v && typeof v === 'object' ? v.gid || v.id : v)).map(v => String(v).trim()).filter(Boolean);
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Built by hand: toLocaleDateString output differs between Node/ICU versions.
function formatDate(value) {
  const d = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(value);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function formatDateTime(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return `${formatDate(d.toISOString().slice(0, 10))} ${d.toISOString().slice(11, 16)} UTC`;
}

function clip(s) {
  return s.length > MAX_VALUE_CHARS ? `${s.slice(0, MAX_VALUE_CHARS)}…` : s;
}

/**
 * Looks up names for ids using the server's own read-only get_<type> tools.
 * Any failure falls back to showing the id: approval must never depend on a lookup.
 */
function createNameResolver({ tools, isReadOnly, callTool, timeoutMs = 5000 }) {
  const cache = new Map();

  function paramFor(schema, type) {
    const props = Object.keys((schema && schema.properties) || {});
    const required = (schema && schema.required) || [];
    if (required.length === 1) return required[0];
    return props.find(p => p === `${type}_gid` || p === type || p === 'gid') || props.find(p => /gid$/.test(p)) || null;
  }

  function nameFrom(text) {
    try {
      const parsed = JSON.parse(text);
      const data = parsed && parsed.data !== undefined ? parsed.data : parsed;
      if (data && typeof data.name === 'string') return data.name;
    } catch { /* not JSON; try a looser match */ }
    const match = /"name"\s*:\s*"([^"]+)"/.exec(text);
    return match ? match[1] : null;
  }

  async function lookup(type, id) {
    const toolName = `get_${type}`;
    const tool = tools.get(toolName);
    if (!tool || !isReadOnly(toolName)) return null;
    const param = paramFor(tool.inputSchema, type);
    if (!param) return null;
    let timer;
    try {
      const text = await Promise.race([
        callTool(toolName, { [param]: id }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('lookup timeout')), timeoutMs); }),
      ]);
      return nameFrom(text);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return function resolve(type, id) {
    if (id === 'me') return Promise.resolve('You');
    if (!/^\d+$/.test(id)) return Promise.resolve(id);
    const key = `${type}:${id}`;
    if (!cache.has(key)) cache.set(key, lookup(type, id).then(name => name || id));
    return cache.get(key);
  };
}

async function describeFields(toolName, input, resolve) {
  const subject = subjectOf(input);
  const keys = Object.keys(subject).filter(k => !HIDDEN.has(k) && subject[k] !== null && subject[k] !== undefined && subject[k] !== '');
  keys.sort((a, b) => {
    const ia = FIELD_ORDER.indexOf(a);
    const ib = FIELD_ORDER.indexOf(b);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
  });

  return Promise.all(keys.map(async key => {
    const value = subject[key];
    let text;
    if (ID_TYPES[key]) {
      const names = await Promise.all(idsIn(value).map(id => resolve(ID_TYPES[key], id)));
      text = names.join(', ');
    } else if (key === 'due_on' || key === 'start_on') {
      text = formatDate(value);
    } else if (key === 'due_at' || key === 'start_at') {
      text = formatDateTime(value);
    } else if (typeof value === 'boolean') {
      text = value ? 'Yes' : 'No';
    } else if (Array.isArray(value) && value.every(v => typeof v !== 'object')) {
      text = value.join(', ');
    } else {
      text = typeof value === 'string' ? value : JSON.stringify(value);
    }
    return { label: labelFor(key, toolName), value: clip(text) };
  }));
}

module.exports = { splitInput, describeTool, describeFields, createNameResolver, subjectOf, formatDate };
