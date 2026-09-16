/**
 * Loads modules and is the only place core talks to them. Every call into a module goes
 * through `safe()`, which adds a timeout and turns exceptions into values, so one broken
 * module cannot break the others.
 */

const { validateModule } = require('./module-contract');

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const DEFAULT_TIMEOUTS = { hook: 20_000, tool: 60_000 };

function withTimeout(promiseFn, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve().then(promiseFn),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function isButton(b) {
  if (!b || typeof b.text !== 'string' || !b.text) return false;
  if (typeof b.url === 'string') return b.url.startsWith('https://');
  return typeof b.command === 'string' && /^[a-z][a-z0-9-]*$/.test(b.command);
}

/** Fallback when a module can't describe a call: show every parameter so approval is still informed. */
function genericFields(input) {
  return Object.entries(input && typeof input === 'object' ? input : {}).map(([key, value]) => ({
    label: key.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()),
    value: typeof value === 'string' ? value : JSON.stringify(value),
  }));
}

function createRegistry({ modules, env = process.env, log, timeouts = {} }) {
  const limits = { ...DEFAULT_TIMEOUTS, ...timeouts };
  const byName = new Map();
  const commands = new Map();
  const missing = [];

  for (const mod of modules) {
    validateModule(mod, `module ${mod && mod.name}`);
    if (byName.has(mod.name)) throw new Error(`duplicate module name ${mod.name}`);
    byName.set(mod.name, mod);
    for (const s of mod.settings || []) if (!env[s]) missing.push(s);
    for (const [cmd, spec] of Object.entries(mod.commands || {})) {
      if (commands.has(cmd)) throw new Error(`command /${cmd} is claimed by ${commands.get(cmd).module.name} and ${mod.name}`);
      commands.set(cmd, { module: mod, spec });
    }
  }
  if (missing.length) throw new Error(`Missing module settings: ${missing.join(', ')}`);

  const allowed = (list, kind) => (list || ['DM', 'SPACE']).includes(kind);
  const active = kind => [...byName.values()].filter(m => allowed(m.allowedIn, kind));

  async function safe(mod, label, fn, ms = limits.hook) {
    try {
      return { ok: true, value: await withTimeout(fn, ms, `${mod.name}.${label}`) };
    } catch (error) {
      log.error('module hook failed', { module: mod.name, hook: label, error });
      return { ok: false, error };
    }
  }

  return {
    modules: () => [...byName.values()],
    get: name => byName.get(name),

    /** Look up a slash command. Returns null if unknown. */
    findCommand(name) {
      const found = commands.get(name);
      if (!found) return null;
      const where = found.spec.allowedIn || found.module.allowedIn;
      return { ...found, allowedIn: kind => allowed(where, kind) };
    },

    listCommands(kind) {
      return [...commands].filter(([, c]) => allowed(c.spec.allowedIn || c.module.allowedIn, kind))
        .map(([name, c]) => ({ name, module: c.module.name, description: c.spec.description, usage: c.spec.usage }));
    },

    runCommand: (found, ctx, args) => safe(found.module, `command.${ctx.commandName}`, () => found.spec.run(ctx, args)),

    instructions(kind) {
      return active(kind).filter(m => m.instructions).map(m => `## ${m.name}\n${m.instructions}`);
    },

    /** Human name for a module, e.g. "Asana". */
    label(name) {
      const mod = byName.get(name);
      if (mod && mod.oauth) return mod.oauth.label;
      return name.charAt(0).toUpperCase() + name.slice(1);
    },

    examples(kind) {
      return active(kind).flatMap(m => m.examples || []);
    },

    /** Buttons modules offer on the welcome and help cards. Malformed buttons are dropped. */
    async quickActions(ctxFor, kind) {
      const buttons = [];
      for (const mod of active(kind).filter(m => m.quickActions)) {
        const r = await safe(mod, 'quickActions', () => mod.quickActions(ctxFor(mod)));
        if (r.ok && Array.isArray(r.value)) buttons.push(...r.value.filter(isButton));
      }
      return buttons;
    },

    async isConnected(ctxFor, name) {
      const mod = byName.get(name);
      if (!mod || !mod.connected) return false;
      const r = await safe(mod, 'connected', () => mod.connected(ctxFor(mod)));
      return r.ok && r.value === true;
    },

    async statuses(ctxFor, kind) {
      const lines = [];
      for (const mod of active(kind).filter(m => m.status)) {
        const r = await safe(mod, 'status', () => mod.status(ctxFor(mod)));
        lines.push(r.ok ? String(r.value) : `${mod.name}: unavailable right now`);
      }
      return lines;
    },

    /** First module that understands the attachment wins. Always returns content blocks. */
    async readAttachment(ctxFor, attachment, kind) {
      for (const mod of active(kind).filter(m => m.readAttachment)) {
        const r = await safe(mod, 'readAttachment', () => mod.readAttachment(ctxFor(mod), attachment));
        if (!r.ok) {
          const why = r.error.expose ? `: ${r.error.message}` : '.';
          return [{ type: 'text', text: `[Could not read the file "${attachment.name}"${why}]` }];
        }
        if (r.value) return r.value;
      }
      return [{ type: 'text', text: `[The file "${attachment.name}" is not a supported type.]` }];
    },

    /** Collects every active module's tools into one namespaced toolset for Claude. */
    async buildToolset(ctxFor, kind) {
      const definitions = [];
      const routes = new Map();
      const closers = [];
      const notes = [];
      const connectRoutes = new Map();

      for (const mod of active(kind).filter(m => m.tools)) {
        const r = await safe(mod, 'tools', () => mod.tools(ctxFor(mod)));
        if (!r.ok) { notes.push(`${mod.name}: temporarily unavailable. Tell the user if they ask for it.`); continue; }
        const ts = r.value;
        if (!ts) continue;
        if (ts.close) closers.push(() => ts.close());

        if (ts.connect && mod.oauth) {
          // Claude decides whether a request needs this service; if so it calls this action
          // and the user gets a Connect button instead of instructions to type a command.
          const label = mod.oauth.label;
          const reason = ts.connect.reason === 'expired' ? 'expired' : 'not_connected';
          const name = `${mod.name}__connect_account`;
          definitions.push({
            name,
            description: `The user's ${label} account is ${reason === 'expired' ? 'no longer connected (the connection stopped working)' : 'not connected'}. `
              + `Call this whenever the user's request needs ${label}. Do not answer the request yourself and do not mention commands: `
              + 'the user will be shown a button to connect, and their request will continue afterwards.',
            input_schema: { type: 'object', properties: {} },
          });
          connectRoutes.set(name, { module: mod.name, label, reason });
          continue;
        }
        if (ts.unavailable || ts.connect) { notes.push(`${mod.name}: ${ts.unavailable || 'not connected.'}`); continue; }

        for (const def of ts.definitions || []) {
          const name = `${mod.name}__${def.name}`;
          if (!TOOL_NAME.test(name)) { log.warn('skipping tool with invalid name', { module: mod.name, tool: def.name }); continue; }
          definitions.push({ name, description: def.description || '', input_schema: def.input_schema || { type: 'object' } });
          routes.set(name, { mod, ts, name: def.name });
        }
      }
      definitions.sort((a, b) => (a.name < b.name ? -1 : 1)); // stable order keeps the prompt cache warm

      return {
        definitions,
        notes,
        /** {module, label, reason} if this tool is a request to connect an account, else null. */
        connectionRequest: name => connectRoutes.get(name) || null,
        /** Module name behind a tool, for progress messages. */
        moduleOf: name => (routes.get(name) ? routes.get(name).mod.name : null),
        async needsApproval(name, input) {
          const route = routes.get(name);
          if (!route || !route.ts.needsApproval) return true;
          const r = await safe(route.mod, 'needsApproval', () => route.ts.needsApproval(route.name, input));
          return !(r.ok && r.value === false); // anything but an explicit false requires approval
        },
        /** Batch calls may be split so each part can be approved on its own. */
        async split(name, input) {
          const route = routes.get(name);
          if (!route || !route.ts.split) return [input];
          const r = await safe(route.mod, 'split', () => route.ts.split(route.name, input));
          return r.ok && Array.isArray(r.value) && r.value.length ? r.value : [input];
        },
        async describe(name, input, position) {
          const route = routes.get(name);
          let d = {};
          if (route && route.ts.describe) {
            const r = await safe(route.mod, 'describe', () => route.ts.describe(route.name, input, position));
            if (r.ok && r.value) d = r.value;
          }
          const effect = ['create', 'update', 'delete'].includes(d.effect) ? d.effect : 'change';
          return {
            module: route ? route.mod.name : 'unknown',
            title: d.title || name,
            effect,
            fields: Array.isArray(d.fields) && d.fields.length ? d.fields : genericFields(input),
          };
        },
        async execute(name, input) {
          const route = routes.get(name);
          if (!route) return { content: `Tool ${name} is not available right now.`, isError: true };
          const r = await safe(route.mod, `tool.${route.name}`, () => route.ts.execute(route.name, input), limits.tool);
          if (!r.ok) return { content: `The ${route.mod.name} tool failed: ${String(r.error.message).slice(0, 300)}`, isError: true };
          return r.value;
        },
        async close() {
          await Promise.allSettled(closers.map(c => c()));
        },
      };
    },
  };
}

module.exports = { createRegistry, withTimeout, isButton };
