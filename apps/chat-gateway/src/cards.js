/**
 * Every Google Chat card Buddy sends. Module text is treated as plain text: it is escaped
 * here, so names or descriptions coming from Asana can never inject card formatting.
 *
 * Look and feel: pixel-art Buddy in card headers and brand orange on main buttons.
 * Google Chat allows no custom fonts or backgrounds, so images and button colour carry the style.
 */

const ACTIONS = Object.freeze({
  APPROVE: 'buddy.approve',
  CANCEL: 'buddy.cancel',
  APPROVE_ALL: 'buddy.approveAll',
  CANCEL_ALL: 'buddy.cancelAll',
  COMMAND: 'buddy.command',
  CONTINUE: 'buddy.continue',
  RETRY: 'buddy.retry',
});

// brand orange (#F47A2A) as Chat's 0–1 RGB colour.
const BRAND_ORANGE = { red: 244 / 255, green: 122 / 255, blue: 42 / 255, alpha: 1 };

// Buddy's expressions, served publicly by buddy-oauth. GIFs animate where Chat supports it
// and otherwise show their first frame.
const MOOD_IMAGES = {
  neutral: 'buddy-idle.gif',
  talking: 'buddy-talking.gif',
  thinking: 'buddy-thinking.gif',
  happy: 'buddy-happy.png',
};

let assetsUrl = null;

/** Called once at startup with the public assets address; without it cards have no images. */
function setAssetsUrl(url) {
  assetsUrl = url ? String(url).replace(/\/$/, '') : null;
}

const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const plain = s => esc(s).replace(/\n/g, '<br>');

function header(title, subtitle, mood) {
  const image = assetsUrl && MOOD_IMAGES[mood]
    ? { imageUrl: `${assetsUrl}/${MOOD_IMAGES[mood]}`, imageType: 'CIRCLE', imageAltText: 'Buddy' }
    : {};
  return { title, ...(subtitle ? { subtitle } : {}), ...image };
}

const EFFECT_NOTE = {
  delete: ' <font color="#d93025">— can\'t be undone</font>',
  update: ' <i>— changes something that already exists</i>',
};

/** The main action on a card gets the brand colour. */
const primary = button => ({ ...button, type: 'FILLED', color: BRAND_ORANGE });

function actionButton(text, fn, params) {
  const parameters = Object.entries(params).filter(([, v]) => v !== undefined).map(([key, value]) => ({ key, value: String(value) }));
  return { text, onClick: { action: { function: fn, parameters } } };
}

/** A module Button → a Chat button. */
function toChatButton(b) {
  if (b.url) return { text: b.text, onClick: { openLink: { url: b.url } } };
  return actionButton(b.text, ACTIONS.COMMAND, { command: b.command, args: b.args || '', replace: b.replace ? '1' : '0' });
}

const buttonList = buttons => ({ buttonList: { buttons } });

/** A title/text/buttons card as a Chat message body. */
function simpleCard(cardId, { title, subtitle, text, buttons = [], image }) {
  const widgets = [];
  if (text) widgets.push({ textParagraph: { text: plain(text) } });
  if (buttons.length) widgets.push(buttonList(buttons));
  if (!widgets.length) widgets.push({ textParagraph: { text: ' ' } });
  return {
    text: title || text || '',
    cardsV2: [{ cardId, card: { ...(title ? { header: header(title, subtitle, image) } : {}), sections: [{ widgets }] } }],
  };
}

/** A module Reply (string or {title, text, buttons}) → a Chat message body. */
function renderReply(reply) {
  if (reply && typeof reply === 'object') {
    const buttons = (reply.buttons || []).map(toChatButton);
    if (buttons.length) buttons[0] = primary(buttons[0]);
    return simpleCard('reply', { title: reply.title, text: reply.text, buttons, image: reply.image || 'happy' });
  }
  return { text: String(reply || 'Done.') };
}

/** "14:32" in the user's time zone when Chat tells us it, otherwise UTC. */
function clockTime(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: timeZone || 'UTC' }).formatToParts(date);
    const get = type => parts.find(p => p.type === type).value;
    return `${get('hour')}:${get('minute')}${timeZone ? '' : ' UTC'}`;
  } catch {
    return `${date.toISOString().slice(11, 16)} UTC`;
  }
}

function connectCard({ label, reason, url, requestId, module, note }) {
  const lost = reason === 'expired';
  return simpleCard('connect', {
    title: lost ? `Let's reconnect your ${label}` : `Let's connect your ${label} first`,
    image: 'neutral',
    text: [
      lost
        ? `Oh no, your ${label} connection stopped working (it may have been removed in ${label}). Reconnect and I'll pick up right where we left off.`
        : `To help with this, I need permission to see and update ${label} as you. Takes a few seconds, and you only do it once.`,
      `1. Click "Connect ${label}" and approve.`,
      '2. Pop back here and click "I\'ve connected, continue".',
      ...(note ? ['', note] : []),
    ].join('\n'),
    buttons: [
      primary({ text: `Connect ${label}`, onClick: { openLink: { url } } }),
      actionButton('I\'ve connected, continue', ACTIONS.CONTINUE, { requestId, module }),
    ],
  });
}

function statusText(item) {
  if (item.state === 'running') return '⏳ On it…';
  if (item.state === 'declined') return '❌ Skipped — nothing was changed';
  if (item.state === 'done') {
    if (!item.result || !item.result.isError) return '✅ Done!';
    return `⚠️ Oh no, that didn't work: ${String(item.result.content || '').slice(0, 150)}`;
  }
  return '';
}

function renderFields(fields) {
  if (!fields || !fields.length) return '<i>(no details)</i>';
  return fields.map(f => `<b>${esc(f.label)}:</b> ${esc(f.value)}`).join('<br>');
}

/**
 * @param opts.expiresAt  Date the request expires
 * @param opts.timeZone   the user's IANA time zone, if Chat provided it
 * @param opts.requestId  saved original message, so an expired card can offer "Try again"
 */
function approvalCard(pendingId, items, { expiresAt, timeZone, requestId } = {}) {
  const total = items.length;
  const pending = items.filter(it => it.state === 'pending').length;
  const ids = { pendingId, requestId };

  const sections = [];
  if (pending) {
    sections.push({ widgets: [{ textParagraph: { text: 'Nothing changes until you hit <b>Approve</b>.' } }] });
  }

  items.forEach((item, i) => sections.push({
    widgets: [
      {
        decoratedText: {
          topLabel: total > 1 ? `Change ${i + 1} of ${total}` : 'Change',
          text: `<b>${esc(item.title)}</b>${EFFECT_NOTE[item.effect] || ''}`,
          wrapText: true,
        },
      },
      { textParagraph: { text: renderFields(item.fields) } },
      item.state === 'pending'
        ? buttonList([primary(actionButton('Approve', ACTIONS.APPROVE, { ...ids, item: i })), actionButton('Cancel', ACTIONS.CANCEL, { ...ids, item: i })])
        : { decoratedText: { text: esc(statusText(item)), wrapText: true } },
    ],
  }));

  if (pending) {
    const widgets = [];
    if (pending > 1) {
      widgets.push(buttonList([primary(actionButton('Approve all', ACTIONS.APPROVE_ALL, ids)), actionButton('Cancel all', ACTIONS.CANCEL_ALL, ids)]));
    }
    if (expiresAt) {
      widgets.push({ textParagraph: { text: `<i>This one expires at ${esc(clockTime(expiresAt, timeZone))} (15 minutes). After that, just send your message again.</i>` } });
    }
    if (widgets.length) sections.push({ widgets });
  }

  const cardHeader = pending
    ? header('Quick check before I make changes', total > 1 ? `${total} changes to look at` : '1 change to look at', 'thinking')
    : header('All sorted!', 'Just finishing up…', 'talking');

  return {
    text: 'Quick check before I make changes.',
    cardsV2: [{ cardId: 'approval', card: { header: cardHeader, sections } }],
  };
}

/** A short status card, optionally with a "Try again" button for the saved original message. */
function noticeCard(title, text, retryRequestId) {
  return simpleCard('notice', {
    title,
    text,
    image: 'neutral',
    buttons: retryRequestId ? [primary(actionButton('Try again', ACTIONS.RETRY, { requestId: retryRequestId }))] : [],
  });
}

const updateMessage = body => ({ actionResponse: { type: 'UPDATE_MESSAGE' }, ...body });
const newMessage = body => ({ actionResponse: { type: 'NEW_MESSAGE' }, ...body });

module.exports = {
  ACTIONS, approvalCard, connectCard, noticeCard, renderReply, simpleCard, renderFields,
  clockTime, updateMessage, newMessage, setAssetsUrl, MOOD_IMAGES,
};
