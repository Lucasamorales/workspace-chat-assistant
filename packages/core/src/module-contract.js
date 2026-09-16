/**
 * The Buddy module contract — the ONLY coupling between core and a module.
 *
 * A module is a package whose main export is an object of this shape. It does not need
 * to import anything from core: everything it may use arrives in `ctx`. Core validates
 * every enabled module at startup and refuses to start if one is malformed.
 *
 * Every hook core calls is wrapped in a timeout and try/catch by the registry, so a
 * throwing module degrades to a friendly message instead of taking Buddy down.
 *
 * @typedef {'DM' | 'SPACE'} SpaceKind
 *
 * @typedef {object} ModuleContext         Built by core for one module and one user.
 * @property {string}    userId            Chat user id (numeric part of users/{id}); verified by Google's JWT
 * @property {string}    userEmail
 * @property {SpaceKind} spaceKind
 * @property {object}    store             Storage scoped to this module only (see store.js)
 * @property {(value: any) => Promise<string>} seal     Encrypt, bound to this module + user
 * @property {(sealed: string) => Promise<any>} open    Decrypt what `seal` produced
 * @property {Record<string,string>} settings           Only env vars starting with <NAME>_
 * @property {object}    log               Structured logger tagged with the module name
 * @property {typeof fetch} fetch
 * @property {object}    [core]            Chat-only helpers:
 *   listCommands(), moduleStatuses(), usage(), resetThread(), startOAuth()
 *
 * @typedef {object} CommandSpec
 * @property {string}      description     Shown in /help
 * @property {string}      [usage]         e.g. "/asana connect|disconnect"
 * @property {SpaceKind[]} [allowedIn]     Defaults to the module's allowedIn
 * @property {(ctx: ModuleContext, args: string) => Promise<string>} run
 *
 * @typedef {object} Toolset               Returned by tools(ctx)
 * @property {{name: string, description?: string, input_schema: object}[]} definitions
 * @property {(name: string, input: object) => Promise<{content: string, isError?: boolean}>} execute
 * @property {(name: string, input: object) => Promise<boolean>|boolean} [needsApproval]
 *   Return false ONLY for calls that cannot change anything. Missing = approval required.
 * @property {(name: string, input: object) => object[]} [split]
 *   Split a batch call into independently executable calls (e.g. one per task), so the user
 *   can approve each. Every returned input must be safe to execute on its own.
 * @property {(name: string, input: object, position: {part: number, of: number}) => Promise<ApprovalInfo>} [describe]
 *
 * @typedef {object} ApprovalInfo          What the approval card shows for one item
 * @property {string} title                e.g. "Create task"
 * @property {'create'|'update'|'delete'|'change'} [effect]   'delete' is shown as "cannot be undone"
 * @property {{label: string, value: string}[]} [fields]      Human-readable; resolve ids to names where possible
 * @property {() => Promise<void>} [close]
 * @property {string} [unavailable]        Instead of tools: a note for Claude, e.g. "not connected"
 *
 * @typedef {object} BuddyModule
 * @property {string}      name            Lowercase; also the command, storage, route and settings namespace
 * @property {string}      [description]
 * @property {SpaceKind[]} [allowedIn]     Where the module is active. Default ['DM', 'SPACE']
 * @property {string[]}    [settings]      Env vars that MUST be set; each must start with <NAME>_
 * @property {string}      [instructions]  Static text appended to Claude's system prompt
 * @property {Record<string, CommandSpec>} [commands]
 * @property {(ctx: ModuleContext, attachment: Attachment) => Promise<object[]|null>} [readAttachment]
 * @property {(ctx: ModuleContext) => Promise<Toolset|null>} [tools]
 * @property {OAuthSpec}   [oauth]
 * @property {(ctx: ModuleContext) => Promise<string>} [status]
 *
 * @typedef {object} Attachment
 * @property {string} name
 * @property {string} contentType
 * @property {'UPLOADED_CONTENT'|'DRIVE_FILE'} source
 * @property {(maxBytes: number) => Promise<Buffer>} download   Throws if larger than maxBytes
 *
 * @typedef {object} OAuthSpec             oauth-gateway mounts /auth/<name>/start|callback
 * @property {string} label
 * @property {string} authorizeUrl
 * @property {string} tokenUrl
 * @property {string} clientIdSetting
 * @property {string} clientSecretSetting
 * @property {Record<string,string>} [extraAuthorizeParams]
 * @property {(ctx: ModuleContext, tokenResponse: object) => Promise<void>} saveTokens
 */

const FIELDS = [
  'name', 'description', 'allowedIn', 'settings', 'instructions',
  'commands', 'readAttachment', 'tools', 'oauth', 'status',
];
const SPACE_KINDS = ['DM', 'SPACE'];

function validateModule(mod, source = 'module') {
  const fail = msg => { throw new Error(`${source}: ${msg}`); };
  if (!mod || typeof mod !== 'object') fail('must export an object');
  if (typeof mod.name !== 'string' || !/^[a-z][a-z0-9]*$/.test(mod.name)) {
    fail(`name must be lowercase letters/digits, got "${mod.name}"`);
  }
  const unknown = Object.keys(mod).filter(k => !FIELDS.includes(k));
  if (unknown.length) fail(`unknown fields ${unknown.join(', ')}`);

  if (mod.allowedIn && (!Array.isArray(mod.allowedIn) || !mod.allowedIn.every(k => SPACE_KINDS.includes(k)))) {
    fail('allowedIn must be an array of "DM" / "SPACE"');
  }
  const prefix = `${mod.name.toUpperCase()}_`;
  for (const s of mod.settings || []) {
    if (!s.startsWith(prefix)) fail(`setting ${s} must start with ${prefix}`);
  }
  for (const hook of ['readAttachment', 'tools', 'status']) {
    if (mod[hook] !== undefined && typeof mod[hook] !== 'function') fail(`${hook} must be a function`);
  }
  for (const [cmd, spec] of Object.entries(mod.commands || {})) {
    if (!/^[a-z][a-z0-9-]*$/.test(cmd)) fail(`command "${cmd}" must be lowercase`);
    if (typeof spec.run !== 'function') fail(`command "${cmd}" needs run()`);
    if (!spec.description) fail(`command "${cmd}" needs a description`);
  }
  if (mod.oauth) {
    for (const k of ['label', 'authorizeUrl', 'tokenUrl', 'clientIdSetting', 'clientSecretSetting']) {
      if (!mod.oauth[k]) fail(`oauth.${k} is required`);
    }
    if (typeof mod.oauth.saveTokens !== 'function') fail('oauth.saveTokens must be a function');
    for (const u of [mod.oauth.authorizeUrl, mod.oauth.tokenUrl]) {
      if (!u.startsWith('https://')) fail(`oauth URL ${u} must be https`);
    }
  }
  return mod;
}

module.exports = { validateModule, SPACE_KINDS };
