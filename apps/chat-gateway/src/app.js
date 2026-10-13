const express = require('express');

/**
 * @param verifyTask  when Buddy has a scheduler account configured: checks a request is signed
 *   by it. Without one, /tasks does not exist at all — not a refusal, a 404.
 */
function createApp({ verifyChat, handleEvent, verifyTask = null, runTask = null, log }) {
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

  // Scheduled wake-ups (Cloud Scheduler). Same private service, same kind of signed token as
  // Chat's, but it must come from Buddy's own scheduler account.
  app.post('/tasks/:task', async (req, res) => {
    if (!verifyTask || !runTask) return res.status(404).end();
    try {
      await verifyTask(req.get('authorization'));
    } catch (error) {
      log.warn('rejected task request', { task: req.params.task, reason: error.message });
      return res.status(401).end();
    }
    try {
      return res.status(200).json(await runTask(req.params.task));
    } catch (error) {
      log.error('task failed', { task: req.params.task, error });
      return res.status(error.status || 500).end();
    }
  });

  // Note: Google's frontend intercepts /healthz from outside; this only answers inside Cloud Run.
  app.get('/healthz', (req, res) => res.type('text').send('ok'));
  app.use((req, res) => res.status(404).end());
  return app;
}

module.exports = { createApp };
