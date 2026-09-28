/**
 * The Anthropic Messages API, as far as Buddy uses it: POST /v1/messages, non-streaming.
 *
 * Buddy's SDK sends its key as `x-api-key`; here that key is the shared proxy secret, compared
 * in constant time. Errors come back in Anthropic's own error shape so the SDK raises them as it
 * would any API error — and Buddy's client for the proxy never retries, because a retried turn
 * could land on a session that has already moved on.
 */

const crypto = require('crypto');
const express = require('express');

const anthropicError = (res, status, type, message) => res.status(status).json({ type: 'error', error: { type, message } });

function createProxyApp({ secret, sessions, log, now = () => Date.now() }) {
  const expected = Buffer.from(secret);
  const validKey = key => {
    const given = Buffer.from(String(key || ''));
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  };

  const app = express();
  app.disable('x-powered-by');

  // Large enough for a PDF or image Buddy forwards from a Chat attachment.
  app.post('/v1/messages', express.json({ limit: '25mb' }), async (req, res) => {
    const rid = crypto.randomBytes(4).toString('hex');
    if (!validKey(req.get('x-api-key'))) {
      log.warn('rejected: wrong proxy key', { rid, from: req.ip });
      return anthropicError(res, 401, 'authentication_error', 'Invalid proxy key.');
    }
    if (req.body && req.body.stream) {
      return anthropicError(res, 400, 'invalid_request_error', 'The subscription proxy does not stream.');
    }
    const started = now();
    try {
      const out = await sessions.handle(req.body || {}, rid);
      return res.json(out);
    } catch (error) {
      const status = error.status || 502;
      if (status >= 500 && !error.type) log.error('request crashed', { rid, ms: now() - started, error });
      return anthropicError(res, status, error.type || 'api_error', error.message);
    }
  });

  app.get('/healthz', (req, res) => res.json({ ok: true, ...sessions.stats() }));
  app.use((req, res) => res.status(404).end());
  return app;
}

module.exports = { createProxyApp };
