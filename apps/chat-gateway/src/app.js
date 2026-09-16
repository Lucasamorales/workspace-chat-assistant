const express = require('express');

function createApp({ verifyChat, handleEvent, log }) {
  const app = express();
  app.disable('x-powered-by');

  app.post('/', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      await verifyChat(req.get('authorization'));
    } catch (error) {
      log.warn('rejected unauthenticated request', { reason: error.message });
      return res.status(401).end();
    }

    try {
      res.status(200).json((await handleEvent(req.body)) || {});
    } catch (error) {
      log.error('event handling failed', { error });
      res.status(200).json({ text: 'Sorry, something went wrong on my side.' });
    }
  });

  // Note: Google's frontend intercepts /healthz from outside; this only answers inside Cloud Run.
  app.get('/healthz', (req, res) => res.type('text').send('ok'));
  app.use((req, res) => res.status(404).end());
  return app;
}

module.exports = { createApp };
