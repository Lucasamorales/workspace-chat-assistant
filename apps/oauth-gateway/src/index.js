/** buddy-oauth: public service for the "connect your account" pages. */

const { Firestore } = require('@google-cloud/firestore');
const { KeyManagementServiceClient } = require('@google-cloud/kms');
const core = require('@buddy/core');
const { createOAuthApp } = require('./app');

const config = core.loadConfig({
  PORT: { type: 'number', default: 8080 },
  OAUTH_BASE_URL: { type: 'url', required: true },
  BUDDY_MODULES: { type: 'list', required: true },
  STATE_SECRET: { type: 'secret', required: true, minLength: 32 },
  KMS_KEY_NAME: { required: true },
});

const log = core.createLogger('oauth-gateway');

const modules = config.BUDDY_MODULES.map(name => {
  if (!/^[a-z][a-z0-9]*$/.test(name)) throw new Error(`invalid module name "${name}"`);
  return require(`@buddy/module-${name}`);
});
const registry = core.createRegistry({ modules, log });

const store = core.createFirestoreStore(new Firestore());
const sealer = core.createKmsSealer({ kmsClient: new KeyManagementServiceClient(), keyName: config.KMS_KEY_NAME });

const app = createOAuthApp({
  registry,
  log,
  flows: core.createOAuthFlows({ store, secret: config.STATE_SECRET, baseUrl: config.OAUTH_BASE_URL }),
  makeModuleContext: core.createContextFactory({ store, sealer, log }),
});

app.listen(config.PORT, () => log.info('buddy-oauth listening', { port: config.PORT }));
