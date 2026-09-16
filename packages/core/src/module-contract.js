/**
 * The Buddy module contract — the ONLY coupling between core and a module.
 *
 * A module is a package that default-exports an object of this shape. Core loads the
 * modules listed in BUDDY_MODULES, validates them against this contract at startup,
 * and refuses to start if one is malformed (fail fast, never half-run).
 *
 * Every hook is optional except `name`. Every hook core calls is wrapped in a timeout
 * and try/catch by the registry, so a throwing module degrades to a friendly message
 * instead of taking Buddy down.
 *
 * @typedef {'DM' | 'SPACE'} SpaceKind
 *
 * @typedef {object} BuddyContext          Handed to every hook. Built by core per event.
 * @property {string}    userId            Chat user id (numeric part of users/{id}); verified by Google's JWT
 * @property {string}    userEmail
 * @property {SpaceKind} spaceKind
 * @property {string}    threadKey
 * @property {object}    store             Firestore scoped to modules/<this module>/ — cannot see other modules
 * @property {object}    secrets           Only the secrets this module declared
 * @property {object}    log               Structured logger tagged with the module name
 * @property {(text: string) => Promise<void>} reply
 * @property {(text: string) => Promise<void>} replyPrivately   Visible only to the sender
 *
 * @typedef {object} CommandSpec
 * @property {string}      description     Shown in /help
 * @property {SpaceKind[]} [allowedIn]     Default ['DM', 'SPACE']
 * @property {(ctx: BuddyContext, args: string) => Promise<string|void>} run
 *
 * @typedef {object} BuddyModule
 * @property {string}      name            Lowercase, unique; also the Firestore and route namespace
 * @property {string}      [description]
 * @property {string[]}    [secrets]       Secret names this module may read
 * @property {SpaceKind[]} [allowedIn]     Where the module is active at all. Asana: ['DM'] (decision 0001)
 *
 * @property {Record<string, CommandSpec>} [commands]
 *   Slash commands this module owns. Core rejects duplicate command names at startup.
 *
 * @property {(ctx: BuddyContext, attachment: object) => Promise<object|null>} [readAttachment]
 *   Turn a Chat attachment into Claude content blocks, or null if not handled.
 *
 * @property {(ctx: BuddyContext) => Promise<object|null>} [tools]
 *   Tools this module offers Claude for this user right now, or null (e.g. user not
 *   connected). Returns { definitions, execute(name, input), needsApproval(name, input) }.
 *
 * @property {object} [oauth]
 *   If present, oauth-gateway mounts /auth/<name>/start and /auth/<name>/callback.
 *   { authorizeUrl, tokenUrl, clientIdSetting, clientSecretName, usePkce, extraParams }
 *
 * @property {(ctx: BuddyContext) => Promise<string|null>} [status]
 *   One line for /status, e.g. "Asana: connected as robin@…".
 */

const REQUIRED = ['name'];
const HOOKS = ['commands', 'readAttachment', 'tools', 'oauth', 'status'];

/** Throws with a precise message if a module does not satisfy the contract. */
function validateModule(mod, source) {
  if (!mod || typeof mod !== 'object') throw new Error(`${source}: module must export an object`);
  for (const key of REQUIRED) {
    if (!mod[key]) throw new Error(`${source}: missing required field "${key}"`);
  }
  if (!/^[a-z][a-z0-9-]*$/.test(mod.name)) {
    throw new Error(`${source}: name "${mod.name}" must be lowercase letters, digits or dashes`);
  }
  const unknown = Object.keys(mod).filter(
    k => !['name', 'description', 'secrets', 'allowedIn', ...HOOKS].includes(k),
  );
  if (unknown.length) throw new Error(`${source}: unknown fields ${unknown.join(', ')}`);
  return mod;
}

module.exports = { validateModule };
