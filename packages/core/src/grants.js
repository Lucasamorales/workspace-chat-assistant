/**
 * Access granted from chat, on top of what `infra/config.env` says.
 *
 * Config is the floor: a grant can only widen access, never take away what the file allows.
 * That way no chat message — and no admin account someone else got hold of — can lock the
 * pilot out of its own modules, and the file always describes at least the minimum truth.
 *
 * Everything lives in one document so a refresh is a single read and an edit is one
 * transaction: { modules: { asana: [entry] }, allowed: [entry] } where an entry is
 * { email, by, at, until? }.
 */

const DOC = 'v1';
const DEFAULT_TTL_MS = 15_000;
const EMAIL = /^[a-z0-9][a-z0-9._%+-]*@[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const clean = email => String(email || '').trim().toLowerCase();
const empty = () => ({ modules: {}, allowed: [] });

function bad(message) {
  return Object.assign(new Error(message), { expose: true });
}

/** A grant is over at the end of its `until` day, in the team's own time zone. */
function isActive(entry, nowMs) {
  if (!entry || !entry.until) return true;
  return Date.parse(`${entry.until}T23:59:59Z`) + 3 * 3600 * 1000 > nowMs;
}

/**
 * Access granted from chat, cached for `ttlMs` so a check is not a database read
 * per message. Grants can carry an end date and only ever add to configured access.
 */
function createGrants({ store, now = () => Date.now(), ttlMs = DEFAULT_TTL_MS }) {
  const col = store.collection('core__grants');
  let cache = empty();
  let fetchedAt = 0;

  const load = async () => {
    cache = (await col.get(DOC)) || empty();
    fetchedAt = now();
    return cache;
  };

  const entriesFor = moduleName => (cache.modules || {})[moduleName] || [];

  return {
    /** Called once per incoming event; cheap, and cached so bursts do not hammer Firestore. */
    async refresh(force = false) {
      if (force || now() - fetchedAt > ttlMs) await load();
      return cache;
    },

    /** Synchronous, so access checks stay simple: reads the snapshot `refresh()` last loaded. */
    granted(moduleName, user) {
      const email = clean(user && user.email);
      if (!email) return false;
      return entriesFor(moduleName).some(e => e.email === email && isActive(e, now()));
    },

    /** Someone granted any module may also talk to Buddy at all. */
    mayTalk(user) {
      const email = clean(user && user.email);
      if (!email) return false;
      return (cache.allowed || []).some(e => e.email === email && isActive(e, now()));
    },

    /** Everything currently stored, for /access. Expired entries are marked, not hidden. */
    all() {
      const nowMs = now();
      const modules = Object.fromEntries(Object.entries(cache.modules || {}).map(([name, list]) => [
        name, list.map(e => ({ ...e, expired: !isActive(e, nowMs) })),
      ]));
      return { modules, allowed: (cache.allowed || []).map(e => ({ ...e, expired: !isActive(e, nowMs) })) };
    },

    async grant({ module: moduleName, email, by, until = null, domain }) {
      const person = clean(email);
      if (!EMAIL.test(person)) throw bad('That doesn\'t look like a work email address.');
      if (domain && person.split('@').pop() !== domain) throw bad(`I can only grant access to ${domain} addresses.`);
      if (until !== null && !DATE.test(String(until))) throw bad('An end date needs to look like 2026-11-30.');
      if (until !== null && !isActive({ until }, now())) throw bad('That end date has already passed.');

      const entry = { email: person, by: clean(by), at: new Date(now()).toISOString(), ...(until ? { until } : {}) };
      await col.update(DOC, doc => {
        const next = doc || empty();
        const list = (next.modules[moduleName] || []).filter(e => e.email !== person);
        return {
          ...next,
          modules: { ...next.modules, [moduleName]: [...list, entry] },
          // Module access is useless if the person cannot reach Buddy at all.
          allowed: [...(next.allowed || []).filter(e => e.email !== person), entry],
        };
      });
      await load();
      return entry;
    },

    /**
     * Removes a grant. Access written in config is untouched by design: if the file allows it,
     * only the file can take it away.
     */
    async revoke({ module: moduleName, email, by }) {
      const person = clean(email);
      let removed = false;
      await col.update(DOC, doc => {
        const next = doc || empty();
        const list = next.modules[moduleName] || [];
        const kept = list.filter(e => e.email !== person);
        removed = kept.length !== list.length;
        if (!removed) return undefined;
        const modules = { ...next.modules, [moduleName]: kept };
        // Keep them able to talk to Buddy only while some other grant still stands.
        const stillGranted = Object.values(modules).some(l => l.some(e => e.email === person));
        return {
          ...next,
          modules,
          allowed: stillGranted ? next.allowed : (next.allowed || []).filter(e => e.email !== person),
        };
      });
      if (removed) {
        await load();
        return { email: person, by: clean(by), at: new Date(now()).toISOString() };
      }
      return null;
    },
  };
}

module.exports = { createGrants, isActive };
