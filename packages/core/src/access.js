/**
 * Who may use what. Rules are comma-separated entries:
 *   domain:example.com   everyone with an email in that domain
 *   robin@example.com    one person, by email
 *   users/1234567890               one person, by Chat user id
 *
 * Every enabled module must have an explicit BUDDY_ACCESS_<MODULE> rule, and every role a
 * module declares needs BUDDY_ROLE_<MODULE>_<ROLE>. Missing rules stop the service at
 * startup: forgetting to configure access must never mean "open to everyone".
 */

const ENTRY = /^(domain:[a-z0-9.-]+\.[a-z]{2,}|users\/\d+|[^\s@,]+@[a-z0-9.-]+\.[a-z]{2,})$/;

/**
 * Compile one access rule into a predicate over `{email, id}`.
 *
 * Throws on an empty rule or a malformed entry, naming `label` (the setting it came
 * from), so a typo in configuration stops startup instead of locking someone out.
 */
function parseRule(raw, label) {
  const entries = String(raw || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!entries.length) throw new Error(`${label} is empty`);
  const bad = entries.filter(e => !ENTRY.test(e));
  if (bad.length) throw new Error(`${label} has invalid entries: ${bad.join(', ')}`);

  const domains = entries.filter(e => e.startsWith('domain:')).map(e => e.slice('domain:'.length));
  const people = new Set(entries.filter(e => !e.startsWith('domain:')));

  /** @param user {{email?: string, id?: string}} id is "users/123" */
  return function matches(user) {
    if (!user) return false;
    const email = String(user.email || '').toLowerCase();
    const id = String(user.id || '').toLowerCase();
    if ((email && people.has(email)) || (id && people.has(id))) return true;
    const domain = email.includes('@') ? email.split('@').pop() : '';
    return Boolean(domain) && domains.includes(domain);
  };
}

/**
 * @param opts.grants  optional store of access granted from chat (see grants.js). Grants only
 *   ever widen what the config rules allow: nothing granted in chat can remove configured access.
 */
function createAccessPolicy({ modules, env = process.env, grants = null }) {
  const problems = [];
  const moduleRules = new Map();
  const roleRules = new Map();

  const load = (key, onRule) => {
    if (!env[key]) { problems.push(`${key} is required`); return; }
    try { onRule(parseRule(env[key], key)); } catch (e) { problems.push(e.message); }
  };

  for (const mod of modules) {
    const upper = mod.name.toUpperCase();
    load(`BUDDY_ACCESS_${upper}`, rule => moduleRules.set(mod.name, rule));
    for (const role of mod.roles || []) {
      load(`BUDDY_ROLE_${upper}_${role.toUpperCase()}`, rule => roleRules.set(`${mod.name}:${role}`, rule));
    }
  }
  if (problems.length) throw new Error(`Invalid access configuration:\n  - ${problems.join('\n  - ')}`);

  const byConfig = (moduleName, user) => Boolean(moduleRules.get(moduleName) && moduleRules.get(moduleName)(user));

  return {
    canUse: (moduleName, user) => byConfig(moduleName, user) || Boolean(grants && grants.granted(moduleName, user)),
    /** Where a permission came from, for /access and for messages that explain a refusal. */
    sourceOf: (moduleName, user) => {
      if (byConfig(moduleName, user)) return 'config';
      return grants && grants.granted(moduleName, user) ? 'granted' : null;
    },
    /**
     * A role never grants more than module access: both must match. Roles are configuration
     * only — chat can widen who may *use* a module, never who holds a role inside it.
     */
    hasRole: (moduleName, role, user) => Boolean(
      byConfig(moduleName, user)
      && roleRules.get(`${moduleName}:${role}`) && roleRules.get(`${moduleName}:${role}`)(user),
    ),
  };
}

module.exports = { createAccessPolicy, parseRule };
