/**
 * buddy-bot: the Google Chat endpoint.
 * Deploy with --no-allow-unauthenticated (only chat@system may invoke) and
 * --no-cpu-throttling (work continues after the webhook is acknowledged).
 */

const { Firestore } = require('@google-cloud/firestore');
const { KeyManagementServiceClient } = require('@google-cloud/kms');
const { GoogleAuth, OAuth2Client } = require('google-auth-library');
const { chat: chatApi } = require('@googleapis/chat');
const core = require('@buddy/core');
const { createApp } = require('./app');
const { createEventHandler } = require('./handler');
const { createTaskRunner } = require('./tasks');
const { setAssetsUrl } = require('./cards');

const config = core.loadConfig({
  PORT: { type: 'number', default: 8080 },
  CHAT_AUDIENCE: { type: 'url', required: true },
  OAUTH_BASE_URL: { type: 'url', required: true },
  BUDDY_MODULES: { type: 'list', required: true },
  BUDDY_ALLOWED_USERS: { type: 'list', required: true },
  BUDDY_APP_NAME: { default: 'Buddy' },
  ANTHROPIC_API_KEY: { type: 'secret', required: true },
  STATE_SECRET: { type: 'secret', required: true, minLength: 32 },
  KMS_KEY_NAME: { required: true },
  MODEL: { default: 'claude-sonnet-5' },
  EFFORT: { type: 'enum', values: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'medium' },
  MONTHLY_USD_CAP: { type: 'number', min: 0, default: 15 },
  MONTHLY_USD_CAP_SCOPED: { type: 'number', min: 0, default: 5 },
  USD_PER_MTOK_IN: { type: 'number', min: 0, required: true },
  USD_PER_MTOK_OUT: { type: 'number', min: 0, required: true },
  MAX_HISTORY_MESSAGES: { type: 'number', min: 2, default: 20 },
  MAX_HISTORY_CHARS: { type: 'number', min: 500, default: 8000 },
  // A ceiling, not a budget: unwritten tokens cost nothing. Too low and a large tool call
  // cannot be written at all, and every retry is cut at the same place.
  MAX_OUTPUT_TOKENS: { type: 'number', min: 1000, default: 16000 },
  CACHE_TTL: { type: 'enum', values: ['5m', '1h'], default: '1h' },
  // "manual:claude-haiku-4-5:low" — the model and effort for people scoped to that module.
  MODULE_TUNING: { type: 'list', default: [] },
  // How many recent tool results a long request keeps; 0 leaves the request untouched.
  CLEAR_TOOL_USES: { type: 'number', min: 0, default: 0 },
  // "claude-haiku-4-5:1:5" — what each model costs per million tokens, in and out.
  MODEL_PRICES: { type: 'list', default: [] },
  THREAD_TTL_DAYS: { type: 'number', min: 1, default: 30 },
  // Experiment (docs/decisions/0010-subscription-proxy.md): these people are answered through the
  // subscription proxy instead of the API. Empty means nobody, and the experiment is off.
  // The service account Cloud Scheduler signs /tasks requests as. Unset: /tasks does not exist.
  BUDDY_SCHEDULER_EMAIL: { default: '' },
  CLAUDE_PROXY_USERS: { type: 'list', default: [] },
  CLAUDE_PROXY_URL: { type: 'url' },
  CLAUDE_PROXY_SECRET: { type: 'secret', minLength: 32 },
});

const log = core.createLogger('chat-gateway');

// Someone routed to a proxy that isn't configured would get an error on every message. Refuse to
// start instead, the same way a missing access rule does.
if (config.CLAUDE_PROXY_USERS.length && !(config.CLAUDE_PROXY_URL && config.CLAUDE_PROXY_SECRET)) {
  throw new Error('CLAUDE_PROXY_USERS is set, so CLAUDE_PROXY_URL and CLAUDE_PROXY_SECRET are required');
}

const moduleTuning = core.parseTuning(config.MODULE_TUNING);
const prices = core.parsePrices(config.MODEL_PRICES, {
  inPerMTok: config.USD_PER_MTOK_IN,
  outPerMTok: config.USD_PER_MTOK_OUT,
});

// ignoreUndefinedProperties: a module leaving an optional field undefined (a Drive file with
// no link, say) should not take down a write. The field is simply not stored.
const store = core.createFirestoreStore(new Firestore({ ignoreUndefinedProperties: true }));
// Access granted from chat by an admin. Config remains the floor: see packages/core/grants.js.
const grants = core.createGrants({ store });

const usage = core.createUsage({ store, capUsd: config.MONTHLY_USD_CAP, prices, cacheTtl: config.CACHE_TTL });

const modules = config.BUDDY_MODULES.map(name => {
  if (!/^[a-z][a-z0-9]*$/.test(name)) throw new Error(`invalid module name "${name}"`);
  const pkg = require(`@buddy/module-${name}`);
  // The admin module is the one module that needs the shared grants store, so it is built here
  // rather than exporting a ready-made object.
  if (typeof pkg.createAdminModule === 'function') return pkg.createAdminModule({ grants, moduleNames: config.BUDDY_MODULES });
  if (typeof pkg.createCostsModule === 'function') return pkg.createCostsModule({ usage });
  return pkg;
});
// Fails startup if any enabled module lacks BUDDY_ACCESS_<MODULE> or a declared role rule.
const access = core.createAccessPolicy({ modules, grants });
const registry = core.createRegistry({ modules, log, access });

const sealer = core.createKmsSealer({ kmsClient: new KeyManagementServiceClient(), keyName: config.KMS_KEY_NAME });
const chat = core.createChatClient({
  api: chatApi({ version: 'v1', auth: new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/chat.bot'] }) }),
});

// Buddy's pixel-art images are served publicly by buddy-oauth.
setAssetsUrl(`${config.OAUTH_BASE_URL}/assets`);

const people = core.createPeople({ store });
const handleEvent = createEventHandler({
  people,
  registry,
  chat,
  store,
  log,
  allowedUsers: config.BUDDY_ALLOWED_USERS,
  grants,
  scopedCapUsd: config.MONTHLY_USD_CAP_SCOPED,
  moduleTuning,
  // What a module with no MODULE_TUNING entry of its own counts as, when models are compared.
  defaultModel: config.MODEL,
  defaultEffort: config.EFFORT,
  subscriptionUsers: config.CLAUDE_PROXY_USERS,
  appName: config.BUDDY_APP_NAME,
  threads: core.createThreads({
    store,
    maxMessages: config.MAX_HISTORY_MESSAGES,
    maxChars: config.MAX_HISTORY_CHARS,
    ttlDays: config.THREAD_TTL_DAYS,
  }),
  usage,
  oauthFlows: core.createOAuthFlows({ store, secret: config.STATE_SECRET, baseUrl: config.OAUTH_BASE_URL }),
  claude: core.createClaude({
    apiKey: config.ANTHROPIC_API_KEY,
    model: config.MODEL,
    effort: config.EFFORT,
    maxTokens: config.MAX_OUTPUT_TOKENS,
    cacheTtl: config.CACHE_TTL,
    clearToolUses: config.CLEAR_TOOL_USES,
    proxy: config.CLAUDE_PROXY_URL ? { url: config.CLAUDE_PROXY_URL, secret: config.CLAUDE_PROXY_SECRET } : null,
    log: log.child('claude'),
  }),
  makeModuleContext: core.createContextFactory({ store, sealer, log, access }),
  defer: promise => promise.catch(error => log.error('background task crashed', { error })),
});

// Scheduled messages go through the same two gates as a message would: allowed on Buddy at all,
// and able to use the module that wants to speak.
const allowed = core.parseRule(config.BUDDY_ALLOWED_USERS.join(','), 'BUDDY_ALLOWED_USERS');
const runTask = createTaskRunner({
  registry,
  chat,
  people,
  makeModuleContext: core.createContextFactory({ store, sealer, log, access }),
  access,
  mayTalk: email => allowed({ email }) || Boolean(grants.mayTalk({ email })),
  log: log.child('tasks'),
});

const oauthClient = new OAuth2Client();
const app = createApp({
  verifyChat: core.createChatVerifier({ audience: config.CHAT_AUDIENCE, oauthClient }),
  handleEvent,
  ...(config.BUDDY_SCHEDULER_EMAIL ? {
    verifyTask: core.createCallerVerifier({ audience: config.CHAT_AUDIENCE, oauthClient, email: config.BUDDY_SCHEDULER_EMAIL }),
    runTask,
  } : {}),
  log,
});

app.listen(config.PORT, () => log.info('buddy-bot listening', { port: config.PORT, modules: config.BUDDY_MODULES }));
