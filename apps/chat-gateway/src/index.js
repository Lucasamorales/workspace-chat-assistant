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
  MAX_OUTPUT_TOKENS: { type: 'number', min: 256, default: 4000 },
  CACHE_TTL: { type: 'enum', values: ['5m', '1h'], default: '1h' },
  // "manual:claude-haiku-4-5:low" — the model and effort for people scoped to that module.
  MODULE_TUNING: { type: 'list', default: [] },
  // How many recent tool results a long request keeps; 0 leaves the request untouched.
  CLEAR_TOOL_USES: { type: 'number', min: 0, default: 0 },
  // "claude-haiku-4-5:1:5" — what each model costs per million tokens, in and out.
  MODEL_PRICES: { type: 'list', default: [] },
  THREAD_TTL_DAYS: { type: 'number', min: 1, default: 30 },
});

const log = core.createLogger('chat-gateway');

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

const usage = core.createUsage({ store, capUsd: config.MONTHLY_USD_CAP, prices });

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

const handleEvent = createEventHandler({
  registry,
  chat,
  store,
  log,
  allowedUsers: config.BUDDY_ALLOWED_USERS,
  grants,
  scopedCapUsd: config.MONTHLY_USD_CAP_SCOPED,
  moduleTuning,
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
  }),
  makeModuleContext: core.createContextFactory({ store, sealer, log, access }),
  defer: promise => promise.catch(error => log.error('background task crashed', { error })),
});

const app = createApp({
  verifyChat: core.createChatVerifier({ audience: config.CHAT_AUDIENCE, oauthClient: new OAuth2Client() }),
  handleEvent,
  log,
});

app.listen(config.PORT, () => log.info('buddy-bot listening', { port: config.PORT, modules: config.BUDDY_MODULES }));
