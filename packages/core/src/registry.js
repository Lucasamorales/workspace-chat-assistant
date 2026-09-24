/**
 * Loads modules and is the only place core talks to them. Every call into a module goes
 * through `safe()`, which adds a timeout and turns exceptions into values, so one broken
 * module cannot break the others.
 *
 * Most methods take a `scope` — {kind: 'DM'|'SPACE', user: {email, id}} — and only consider
 * modules that are allowed in that place AND that this person may use. A module a person
 * can't use is invisible to them: no commands, no help entries, no tools, no handlers.
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

function labelOf(mod) {
  if (mod.oauth) return mod.oauth.label;
  return mod.name.charAt(0).toUpperCase() + mod.name.slice(1);
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

/**
 * @param opts.access  access policy (see access.js). Omitted only in tests and in the OAuth
 *                     service, which never acts on behalf of a Chat event.
 */
function createRegistry({ modules, env = process.env, log, timeouts = {}, access = null }) {
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

  const allowedHere = (list, kind) => (list || ['DM', 'SPACE']).includes(kind);
  // With a policy, a scope without a user sees nothing: a caller that forgets the user fails closed.
  const mayUse = (mod, scope) => !access || Boolean(scope.user && access.canUse(mod.name, scope.user));
  const reachable = (mod, scope) => allowedHere(mod.allowedIn, scope.kind) && mayUse(mod, scope);
  /**
   * Two different things, deliberately separated:
   *
   *   free   — the assistant module: ask Claude anything.
   *   scoped — a module that needs Claude to work (Asana, the manual) but only for itself:
   *            Claude is given that module's tools and told to decline everything else.
   *
   * So "can use Asana by talking to it" is an ordinary permission, while "can chat with Claude
   * about anything" stays with the people who are meant to have it.
   */
  const freeConverse = scope => [...byName.values()].some(m => m.conversation && reachable(m, scope));
  const scopedModules = scope => [...byName.values()].filter(m => m.scopedConversation && reachable(m, scope));
  const canConverse = scope => freeConverse(scope) || scopedModules(scope).length > 0;
  /** 'free' · 'scoped' · null — what Claude may do for this person here. */
  const conversationMode = scope => {
    if (freeConverse(scope)) return 'free';
    return scopedModules(scope).length ? 'scoped' : null;
  };
  // Modules that only work through Claude are hidden from people who cannot reach Claude at all.
  const visible = (mod, scope) => reachable(mod, scope) && (!mod.needsConversation || canConverse(scope));
  const active = scope => [...byName.values()].filter(m => visible(m, scope));

  const hasRole = (mod, role, user) => (access ? access.hasRole(mod.name, role, user) : false);
  // For commands the place is judged separately (so "/asana" in a space can say "use a DM"),
  // so the conversation requirement only asks whether the person can chat anywhere.
  const conversationOk = (mod, scope) => !mod.needsConversation
    || canConverse({ ...scope, kind: 'DM' }) || canConverse({ ...scope, kind: 'SPACE' });
  const commandVisible = (c, scope) => mayUse(c.module, scope) && conversationOk(c.module, scope)
    && allowedHere(c.spec.allowedIn || c.module.allowedIn, scope.kind)
    && (!c.spec.role || hasRole(c.module, c.spec.role, scope.user));

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
    hasRole: (name, role, user) => (byName.has(name) ? hasRole(byName.get(name), role, user) : false),
    canConverse,
    conversationMode,
    /** The modules Claude may act for when conversation is scoped, for the restricting prompt. */
    scopedFor: scope => scopedModules(scope).map(m => m.name),

    /**
     * Look up a slash command for this person and place.
     * Returns null if unknown or not available to them (so it looks the same as unknown),
     * or {…, placeAllowed: false} when they could use it, just not here.
     */
    findCommand(name, scope) {
      const found = commands.get(name);
      if (!found || !mayUse(found.module, scope) || !conversationOk(found.module, scope)) return null;
      if (found.spec.role && !hasRole(found.module, found.spec.role, scope.user)) return null;
      return { ...found, placeAllowed: allowedHere(found.spec.allowedIn || found.module.allowedIn, scope.kind) };
    },

    listCommands(scope) {
      return [...commands].filter(([, c]) => commandVisible(c, scope))
        .map(([name, c]) => ({ name, module: c.module.name, description: c.spec.description, usage: c.spec.usage }));
    },

    runCommand: (found, ctx, args) => safe(found.module, `command.${ctx.commandName}`, () => found.spec.run(ctx, args)),

    instructions(scope) {
      return active(scope).filter(m => m.instructions).map(m => `## ${m.name}\n${m.instructions}`);
    },

    /** Human name for a module, e.g. "Asana". */
    label: name => labelOf(byName.get(name) || { name }),

    examples(scope) {
      return active(scope).flatMap(m => m.examples || []);
    },

    /** Buttons modules offer on the welcome and help cards. Malformed buttons are dropped. */
    async quickActions(ctxFor, scope) {
      const buttons = [];
      for (const mod of active(scope).filter(m => m.quickActions)) {
        const r = await safe(mod, 'quickActions', () => mod.quickActions(ctxFor(mod)));
        if (r.ok && Array.isArray(r.value)) buttons.push(...r.value.filter(isButton));
      }
      return buttons;
    },

    async isConnected(ctxFor, name, scope) {
      const mod = byName.get(name);
      if (!mod || !mod.connected || !mayUse(mod, scope)) return false;
      const r = await safe(mod, 'connected', () => mod.connected(ctxFor(mod)));
      return r.ok && r.value === true;
    },

    async statuses(ctxFor, scope) {
      const lines = [];
      for (const mod of active(scope).filter(m => m.status)) {
        const r = await safe(mod, 'status', () => mod.status(ctxFor(mod)));
        lines.push(r.ok ? String(r.value) : `${mod.name}: unavailable right now`);
      }
      return lines;
    },

    /**
     * Offers a message to modules that handle messages directly, in configured order.
     * Returns {module, reply} for the first taker, or null so the message goes to Claude.
     * A module that fails after claiming nothing still ends here with a friendly reply,
     * rather than silently falling through to Claude with a half-done action.
     */
    async handleMessage(ctxFor, message, scope) {
      for (const mod of active(scope).filter(m => m.handleMessage)) {
        const r = await safe(mod, 'handleMessage', () => mod.handleMessage(ctxFor(mod), message));
        if (!r.ok) {
          return {
            module: mod.name,
            reply: r.error.expose ? r.error.message : `Sorry, something went wrong with ${labelOf(mod)}. Please try again.`,
          };
        }
        if (r.value) return { module: mod.name, reply: r.value };
      }
      return null;
    },

    /** First module that understands the attachment wins. Always returns content blocks. */
    async readAttachment(ctxFor, attachment, scope) {
      for (const mod of active(scope).filter(m => m.readAttachment)) {
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
    async buildToolset(ctxFor, scope) {
      const definitions = [];
      const routes = new Map();
      const closers = [];
      const notes = [];
      const connectRoutes = new Map();

      for (const mod of active(scope).filter(m => m.tools)) {
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
          definitions.push({
            name,
            description: def.description || '',
            input_schema: def.input_schema || { type: 'object' },
            // A module may defer a rarely-used tool: its definition is not sent up front, and
            // Claude loads it with the tool-search tool when it needs it.
            ...(def.defer_loading ? { defer_loading: true } : {}),
          });
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
