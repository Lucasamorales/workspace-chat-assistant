/** Builds the `ctx` a module receives: scoped storage, scoped settings, scoped encryption. */

const { scopeStore } = require('./store');

function createContextFactory({ store, sealer, env = process.env, log, fetchImpl = fetch, access = null }) {
  const settingsFor = mod => {
    const prefix = `${mod.name.toUpperCase()}_`;
    return Object.freeze(Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith(prefix))));
  };

  /**
   * @param mod   the module
   * @param base  { userId, userEmail, spaceKind }
   * @param core  optional chat-only helpers
   */
  return function makeModuleContext(mod, base, core) {
    const context = `${mod.name}:${base.userId}`;
    return Object.freeze({
      userId: base.userId,
      userEmail: base.userEmail,
      userDisplayName: base.userDisplayName || '',
      spaceKind: base.spaceKind,
      store: scopeStore(store, `m_${mod.name}`),
      seal: value => sealer.seal(value, context),
      open: sealed => sealer.open(sealed, context),
      settings: settingsFor(mod),
      log: log.child(mod.name),
      fetch: fetchImpl,
      hasRole: role => Boolean(access && access.hasRole(mod.name, role, {
        email: base.userEmail,
        id: base.userId ? `users/${base.userId}` : undefined,
      })),
      ...(core ? { core } : {}),
    });
  };
}

module.exports = { createContextFactory };
