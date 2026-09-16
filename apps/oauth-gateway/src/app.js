/**
 * buddy-oauth: the only public service. It serves exactly two routes per OAuth module
 * and nothing else. It never accepts a user id from the browser: identity comes from
 * the signed, single-use session created inside Chat.
 */

const express = require('express');

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer', // the callback URL carries an authorisation code
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
  'Strict-Transport-Security': 'max-age=31536000',
};

function page(title, body) {
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<body style="font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:15vh auto;padding:0 16px">
<h1 style="font-size:1.3rem">${esc(title)}</h1><p>${esc(body)}</p></body></html>`;
}

function createOAuthApp({ registry, flows, makeModuleContext, env = process.env, log }) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => { res.set(SECURITY_HEADERS); next(); });

  const oauthModule = name => {
    const mod = registry.get(name);
    return mod && mod.oauth ? mod : null;
  };
  const single = v => (typeof v === 'string' ? v : null); // reject ?s=a&s=b style arrays

  app.get('/auth/:module/start', async (req, res) => {
    const mod = oauthModule(req.params.module);
    if (!mod) return res.status(404).send(page('Not found', 'This link is not valid.'));
    try {
      const url = await flows.authorizeUrl({
        moduleName: mod.name,
        token: single(req.query.s),
        oauth: mod.oauth,
        clientId: env[mod.oauth.clientIdSetting],
      });
      res.redirect(302, url);
    } catch (error) {
      log.warn('oauth start rejected', { module: mod.name, reason: error.message });
      res.status(400).send(page('This link has expired',
        `Connect links work once, for 1 hour. Go back to Google Chat and click "Connect ${mod.oauth.label}" again.`));
    }
  });

  app.get('/auth/:module/callback', async (req, res) => {
    const mod = oauthModule(req.params.module);
    if (!mod) return res.status(404).send(page('Not found', 'This link is not valid.'));

    if (req.query.error) {
      return res.status(400).send(page(`${mod.oauth.label} was not connected`,
        `You cancelled the request, so nothing was connected. You can close this tab, or go back to Google Chat and click "Connect ${mod.oauth.label}" to try again.`));
    }

    try {
      const { userId, userEmail, tokenResponse } = await flows.complete({
        moduleName: mod.name,
        state: single(req.query.state),
        code: single(req.query.code),
        oauth: mod.oauth,
        clientId: env[mod.oauth.clientIdSetting],
        clientSecret: env[mod.oauth.clientSecretSetting],
      });
      const ctx = makeModuleContext(mod, { userId, userEmail, spaceKind: 'DM' });
      await mod.oauth.saveTokens(ctx, tokenResponse);
      res.send(page(`✅ ${mod.oauth.label} connected`,
        'You can close this tab. Go back to Google Chat and click "I\'ve connected, continue" to carry on with your request.'));
    } catch (error) {
      log.warn('oauth callback failed', { module: mod.name, reason: error.message });
      res.status(400).send(page(`${mod.oauth.label} was not connected`,
        error.expose ? error.message : `This link has expired or was already used. Go back to Google Chat and click "Connect ${mod.oauth.label}" again.`));
    }
  });

  app.use((req, res) => res.status(404).send(page('Not found', '')));
  return app;
}

module.exports = { createOAuthApp, SECURITY_HEADERS };
