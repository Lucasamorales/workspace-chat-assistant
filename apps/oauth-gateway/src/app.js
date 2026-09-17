/**
 * buddy-oauth: the only public service. It serves exactly two routes per OAuth module
 * and nothing else. It never accepts a user id from the browser: identity comes from
 * the signed, single-use session created inside Chat.
 */

const path = require('path');
const express = require('express');

// Buddy's pixel-art images for Google Chat cards and the app avatar. Chat can only show images
// from a public HTTPS address, so this public service serves them — only these exact files.
const ASSET_DIR = path.join(__dirname, '..', 'public');
const ASSETS = new Map([
  ['buddy-avatar.png', 'image/png'],
  ['buddy-neutral.png', 'image/png'],
  ['buddy-happy.png', 'image/png'],
  ['buddy-thinking.png', 'image/png'],
  ['buddy-idle.gif', 'image/gif'],
  ['buddy-talking.gif', 'image/gif'],
  ['buddy-thinking.gif', 'image/gif'],
]);

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer', // the callback URL carries an authorisation code
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  // img-src 'self' lets the pages show Buddy's own picture; everything else stays blocked.
  'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
  'Strict-Transport-Security': 'max-age=31536000',
};

/** A small page in the Buddy widget's retro style: pixel Buddy, black borders, hard shadow, orange accent. */
function page(title, body, mood = 'neutral') {
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const image = { happy: 'buddy-happy.png', thinking: 'buddy-thinking.png', neutral: 'buddy-neutral.png' }[mood] || 'buddy-neutral.png';
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f4f4f4;font:17px/1.5 system-ui,sans-serif;color:#111">
<main style="max-width:30rem;margin:16px;padding:28px;background:#fff;border:3px solid #000;border-radius:8px;box-shadow:8px 8px 0 #000;text-align:center">
<img src="/assets/${image}" alt="Buddy" width="112" height="112" style="image-rendering:pixelated;border:3px solid #000;border-radius:50%;background:#F47A2A">
<h1 style="font-size:1.4rem;margin:16px 0 8px">${esc(title)}</h1>
<p style="margin:0">${esc(body)}</p>
<div style="height:6px;background:#F47A2A;margin-top:20px;border-radius:3px"></div>
</main></body></html>`;
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

  app.get('/assets/:file', (req, res) => {
    const type = ASSETS.get(req.params.file);
    if (!type) return res.status(404).send(page('Hmm, nothing here', 'This link isn\'t valid.'));
    res.set({ 'Content-Type': type, 'Cache-Control': 'public, max-age=86400', 'Cross-Origin-Resource-Policy': 'cross-origin' });
    res.sendFile(path.join(ASSET_DIR, req.params.file));
  });

  app.get('/auth/:module/start', async (req, res) => {
    const mod = oauthModule(req.params.module);
    if (!mod) return res.status(404).send(page('Hmm, nothing here', 'This link isn\'t valid.'));
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
      res.status(400).send(page('Oh no, this link has expired',
        `Connect links work once, for an hour. Pop back to Google Chat and click "Connect ${mod.oauth.label}" again.`, 'thinking'));
    }
  });

  app.get('/auth/:module/callback', async (req, res) => {
    const mod = oauthModule(req.params.module);
    if (!mod) return res.status(404).send(page('Hmm, nothing here', 'This link isn\'t valid.'));

    if (req.query.error) {
      return res.status(400).send(page('No worries, nothing was connected',
        `You cancelled, so nothing changed. Close this tab, or pop back to Google Chat and click "Connect ${mod.oauth.label}" to try again.`));
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
      res.send(page(`Yessss, ${mod.oauth.label}'s connected!`,
        'Thank you, chap! You can close this tab. Pop back to Google Chat and click "I\'ve connected, continue" and I\'ll carry on.', 'happy'));
    } catch (error) {
      log.warn('oauth callback failed', { module: mod.name, reason: error.message });
      res.status(400).send(page(`Oh no, ${mod.oauth.label} wasn't connected`,
        error.expose ? error.message : `This link has expired or was already used. Pop back to Google Chat and click "Connect ${mod.oauth.label}" again.`, 'thinking'));
    }
  });

  app.use((req, res) => res.status(404).send(page('Hmm, nothing here', 'This link isn\'t valid.')));
  return app;
}

module.exports = { createOAuthApp, SECURITY_HEADERS };
