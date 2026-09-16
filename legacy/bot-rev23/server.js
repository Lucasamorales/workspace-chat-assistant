/**
 * Google Chat <-> Claude bridge. Cloud Run service.
 *
 * POST /                       Chat webhook (JWT-verified, IAM-restricted)
 * GET  /auth/:c/start          OAuth kickoff  (public, signed state)
 * GET  /auth/:c/callback       OAuth callback (public, signed state)
 * GET  /healthz                liveness (note: intercepted by Google's frontend
 *                              externally; works locally and via the Run proxy)
 *
 * DEPLOY NOTE: must run with --no-cpu-throttling, otherwise Cloud Run freezes the
 * container the moment we return 200 and the async work never finishes.
 */

const express = require('express');
const { OAuth2Client } = require('google-auth-library');
const { google } = require('googleapis');
const { Firestore } = require('@google-cloud/firestore');
const XLSX = require('xlsx');
const connectors = require('./connectors');
const oauth = require('./oauth');

const {
  ANTHROPIC_API_KEY,
  CHAT_AUDIENCE,
  PROJECT_NUMBER,
  MODEL = 'claude-sonnet-5',
  MONTHLY_USD_CAP = '15',
  USD_PER_MTOK_IN = '2',
  USD_PER_MTOK_OUT = '10',
  MAX_TURNS = '20',
  DEBUG_AUTH,
} = process.env;

const BASE_URL = CHAT_AUDIENCE;          // same host serves Chat and OAuth
const db = new Firestore();
const authClient = new OAuth2Client();

const CHAT_ISSUERS = [
  'chat@system.gserviceaccount.com',
  `service-${PROJECT_NUMBER}@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`,
];

let chatApi;
async function chat() {
  if (!chatApi) {
    const auth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/chat.bot'],
    });
    chatApi = google.chat({ version: 'v1', auth: await auth.getClient() });
  }
  return chatApi;
}

const app = express();
app.use(express.json({ limit: '1mb' }));

/* ---------- routes ---------- */

oauth.mount(app, { baseUrl: BASE_URL, db });
app.get('/healthz', (_, res) => res.send('ok'));

app.post('/', async (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  try {
    const ticket = await authClient.verifyIdToken({ idToken: token, audience: CHAT_AUDIENCE });
    const payload = ticket.getPayload();
    if (DEBUG_AUTH) console.log('JWT ok. email=', payload.email, 'aud=', payload.aud);
    if (!CHAT_ISSUERS.includes(payload.email)) {
      console.error('rejected issuer', payload.email);
      return res.status(401).end();
    }
  } catch (e) {
    console.error('auth failed:', e.message,
      'hdr=', (req.headers.authorization || 'NONE').slice(0, 20));
    return res.status(401).end();
  }

  const event = req.body;
  res.status(200).json({});
  if (event.type !== 'MESSAGE') return;
  handleMessage(event).catch(e => console.error('handler blew up', e));
});

app.listen(process.env.PORT || 8080);

/* ---------- main handler ---------- */

async function handleMessage(event) {
  const api = await chat();
  const space = event.space.name;
  const threadKey = event.message.thread?.name || event.message.name;
  const userId = event.user.name.split('/').pop();
  const text = (event.message.argumentText || event.message.text || '').trim();

  const placeholder = await api.spaces.messages.create({
    parent: space,
    messageReplyOption: 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD',
    requestBody: { text: '_thinking…_', thread: event.message.thread },
  });
  const reply = t => api.spaces.messages.patch({
    name: placeholder.data.name, updateMask: 'text', requestBody: { text: t },
  });

  try {
    const userRef = db.collection('users').doc(userId);
    const user = (await userRef.get()).data() || {};

    const command = await handleCommand(text, { userId, user, userRef, threadKey });
    if (command) return reply(command);

    const used = usageThisMonth(user);
    if (used.usd >= Number(MONTHLY_USD_CAP)) {
      return reply(`Monthly budget reached ($${MONTHLY_USD_CAP}). Ping Remy to raise the cap.`);
    }

    const blocks = [];
    for (const att of event.message.attachment || []) {
      const parsed = await readAttachment(api, att);
      if (parsed) blocks.push(parsed);
    }
    blocks.push({ type: 'text', text: text || 'See attachment.' });

    const threadRef = db.collection('threads').doc(hash(threadKey));
    const history = ((await threadRef.get()).data()?.messages || []).slice(-Number(MAX_TURNS));
    const messages = [...history, { role: 'user', content: blocks }];

    const mcp = await buildMcpServers(userId, user);
    const result = await callClaude(messages, mcp);

    await threadRef.set({
      messages: [...messages, { role: 'assistant', content: [{ type: 'text', text: result.text }] }]
        .slice(-Number(MAX_TURNS)),
      updated: Firestore.Timestamp.now(),
    });

    const cost = (result.usage.input_tokens / 1e6) * Number(USD_PER_MTOK_IN)
               + (result.usage.output_tokens / 1e6) * Number(USD_PER_MTOK_OUT);
    await userRef.set({
      usage: {
        month: monthKey(),
        in_tok: used.in_tok + result.usage.input_tokens,
        out_tok: used.out_tok + result.usage.output_tokens,
        usd: used.usd + cost,
      },
    }, { merge: true });

    await reply(result.text || '_(no text returned)_');
  } catch (e) {
    console.error(e);
    await reply(`Error: ${e.message}`);
  }
}

/* ---------- commands ---------- */

async function handleCommand(text, { userId, user, userRef, threadKey }) {
  const m = text.match(/^\/(\w+)\s*(\w+)?/);
  if (!m) return null;
  const [, cmd, arg] = m;
  const linked = Object.keys(user.connectors || {});

  switch (cmd.toLowerCase()) {
    case 'connect': {
      const names = arg ? [arg.toLowerCase()] : connectors.available();
      const lines = names.map(n => {
        try {
          const label = connectors.get(n).label;
          return `• *${label}*: ${BASE_URL}/auth/${n}/start?u=${encodeURIComponent(userId)}`;
        } catch (e) { return `• ${n}: ${e.message}`; }
      });
      return `Authorise by opening the link — you'll consent on the vendor's own site:\n${lines.join('\n')}`;
    }

    case 'disconnect': {
      if (!arg) return `Specify one: ${linked.join(', ') || 'nothing connected'}`;
      const n = arg.toLowerCase();
      await userRef.set({ connectors: { [n]: Firestore.FieldValue.delete() } }, { merge: true });
      return `Disconnected ${n}. Revoke the app in ${n}'s own settings too if you want the grant removed at their end.`;
    }

    case 'connectors': {
      const rows = connectors.available().map(n => {
        const c = connectors.get(n);
        return `• *${c.label}* — ${linked.includes(n) ? 'connected' : 'not connected'}`;
      });
      return rows.length ? rows.join('\n') : 'No connectors configured.';
    }

    case 'reset':
      await db.collection('threads').doc(hash(threadKey)).delete();
      return 'Thread context cleared.';

    case 'usage': {
      const u = usageThisMonth(user);
      return `This month: ${u.in_tok} in / ${u.out_tok} out — $${u.usd.toFixed(2)} of $${MONTHLY_USD_CAP}.`;
    }

    case 'help':
      return [
        '*Commands*',
        '• `/connect [service]` — authorise a connector',
        '• `/disconnect <service>` — remove your token',
        '• `/connectors` — what is available and linked',
        '• `/usage` — your spend this month',
        '• `/reset` — clear this thread\'s context',
      ].join('\n');

    default:
      return null;   // not a command, treat as a normal message
  }
}

/* ---------- MCP assembly ---------- */

async function buildMcpServers(userId, user) {
  const servers = [];
  for (const name of Object.keys(user.connectors || {})) {
    try {
      const cfg = connectors.get(name);
      const token = await oauth.validToken(name, user.connectors[name], async next => {
        await db.collection('users').doc(userId)
          .set({ connectors: { [name]: next } }, { merge: true });
      });
      servers.push({ type: 'url', url: cfg.mcpUrl, name, authorization_token: token });
    } catch (e) {
      console.warn(`skipping connector ${name}: ${e.message}`);
    }
  }
  return servers;
}

/* ---------- Anthropic ---------- */

async function callClaude(messages, mcpServers) {
  const body = {
    model: MODEL,
    max_tokens: 4000,
    system: 'You are the company assistant in Google Chat. Be concise; Chat renders '
          + 'limited markdown (*bold*, _italic_, bullets — no tables, no headings). '
          + 'Confirm before any destructive action in a connected tool.',
    messages,
  };

  if (mcpServers.length) {
    body.mcp_servers = mcpServers;
    body.tools = mcpServers.map(s => ({ type: 'mcp_toolset', mcp_server_name: s.name }));
  }

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'mcp-client-2025-11-20',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 300)}`);

  const data = await r.json();
  return {
    text: data.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim(),
    usage: data.usage,
  };
}

/* ---------- attachments ---------- */

async function readAttachment(api, att) {
  if (att.source !== 'UPLOADED_CONTENT') {
    return { type: 'text', text: `[Drive attachment "${att.contentName}" not supported yet]` };
  }
  const res = await api.media.download(
    { resourceName: att.attachmentDataRef.resourceName, alt: 'media' },
    { responseType: 'arraybuffer' },
  );
  const buf = Buffer.from(res.data);
  const name = att.contentName || 'file';
  const mime = att.contentType || '';

  if (/\.(xlsx|xls|csv|tsv)$/i.test(name)) {
    const wb = XLSX.read(buf, { type: 'buffer' });
    const dump = wb.SheetNames
      .map(s => `### ${s}\n${XLSX.utils.sheet_to_csv(wb.Sheets[s])}`)
      .join('\n\n').slice(0, 200_000);
    return { type: 'text', text: `File: ${name}\n\n${dump}` };
  }
  if (mime === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: mime, data: buf.toString('base64') } };
  }
  if (/^image\/(jpeg|png|gif|webp)$/.test(mime)) {
    return { type: 'image', source: { type: 'base64', media_type: mime, data: buf.toString('base64') } };
  }
  if (/^text\//.test(mime) || /\.(txt|md|json|log)$/i.test(name)) {
    return { type: 'text', text: `File: ${name}\n\n${buf.toString('utf8').slice(0, 200_000)}` };
  }
  return { type: 'text', text: `[Unsupported file type: ${name}]` };
}

/* ---------- helpers ---------- */

function monthKey() { return new Date().toISOString().slice(0, 7); }
function usageThisMonth(user) {
  const u = user.usage;
  return u && u.month === monthKey() ? u : { month: monthKey(), in_tok: 0, out_tok: 0, usd: 0 };
}
function hash(s) { return require('crypto').createHash('sha1').update(s).digest('hex'); }
