/**
 * The loopback channel the stub MCP servers call. Bound to 127.0.0.1 on a random port, so the
 * tunnel that exposes the proxy to Cloud Run can never reach it; every call also carries its
 * session's own random secret.
 *
 * Requests are held open for as long as Buddy takes — Node's default five-minute request timeout
 * is switched off, because an approval card can take fifteen.
 */

const http = require('http');

const MAX_BODY = 5 * 1024 * 1024;

function createCallbackServer({ sessions, log }) {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/call') {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    let tooBig = false;
    req.setEncoding('utf8');
    req.on('data', d => {
      body += d;
      if (body.length > MAX_BODY) { tooBig = true; req.destroy(); }
    });
    req.on('end', async () => {
      if (tooBig) return;
      const reply = (status, payload) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
      let call;
      try {
        call = JSON.parse(body);
      } catch {
        reply(400, { isError: true, content: 'Unreadable call.' });
        return;
      }
      try {
        reply(200, await sessions.onStubCall(call.session, call.secret, call.name, call.args));
      } catch (error) {
        log.warn('stub call rejected', { tool: call.name, why: error.message });
        reply(error.status || 500, { isError: true, content: error.message });
      }
    });
  });
  server.requestTimeout = 0;
  server.timeout = 0;

  return {
    server,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    }),
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}

module.exports = { createCallbackServer };
