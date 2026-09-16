/**
 * Every Google Chat card Buddy sends. Module text is treated as plain text: it is escaped
 * here, so names or descriptions coming from Asana can never inject card formatting.
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

const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const plain = s => esc(s).replace(/\n/g, '<br>');

const EFFECT_NOTE = {
  delete: ' <font color="#d93025">— cannot be undone</font>',
  update: ' <i>— changes something that already exists</i>',
};

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
function simpleCard(cardId, { title, subtitle, text, buttons = [] }) {
  const widgets = [];
  if (text) widgets.push({ textParagraph: { text: plain(text) } });
  if (buttons.length) widgets.push(buttonList(buttons));
  if (!widgets.length) widgets.push({ textParagraph: { text: ' ' } });
  return {
    text: title || text || '',
    cardsV2: [{ cardId, card: { ...(title ? { header: { title, ...(subtitle ? { subtitle } : {}) } } : {}), sections: [{ widgets }] } }],
  };
}

/** A module Reply (string or {title, text, buttons}) → a Chat message body. */
function renderReply(reply) {
  if (reply && typeof reply === 'object') {
    return simpleCard('reply', { title: reply.title, text: reply.text, buttons: (reply.buttons || []).map(toChatButton) });
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
    title: lost ? `Reconnect your ${label}` : `Connect your ${label} first`,
    text: [
      lost
        ? `Your ${label} connection stopped working (it may have been removed in ${label}). Reconnect and I'll carry on with your request.`
        : `To do this I need permission to see and update ${label} as you. It takes a few seconds and you only do it once.`,
      `1. Click "Connect ${label}" and approve.`,
      '2. Come back here and click "I\'ve connected, continue".',
      ...(note ? ['', note] : []),
    ].join('\n'),
    buttons: [
      { text: `Connect ${label}`, onClick: { openLink: { url } } },
      actionButton('I\'ve connected, continue', ACTIONS.CONTINUE, { requestId, module }),
    ],
  });
}

function statusText(item) {
  if (item.state === 'running') return '⏳ Working on it…';
  if (item.state === 'declined') return '❌ Skipped — nothing was changed';
  if (item.state === 'done') {
    if (!item.result || !item.result.isError) return '✅ Done';
    return `⚠️ This didn't work: ${String(item.result.content || '').slice(0, 150)}`;
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
    sections.push({ widgets: [{ textParagraph: { text: 'Nothing will change until you click <b>Approve</b>.' } }] });
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
        ? buttonList([actionButton('Approve', ACTIONS.APPROVE, { ...ids, item: i }), actionButton('Cancel', ACTIONS.CANCEL, { ...ids, item: i })])
        : { decoratedText: { text: esc(statusText(item)), wrapText: true } },
    ],
  }));

  if (pending) {
    const widgets = [];
    if (pending > 1) {
      widgets.push(buttonList([actionButton('Approve all', ACTIONS.APPROVE_ALL, ids), actionButton('Cancel all', ACTIONS.CANCEL_ALL, ids)]));
    }
    if (expiresAt) {
      widgets.push({ textParagraph: { text: `<i>This request expires at ${esc(clockTime(expiresAt, timeZone))} (15 minutes). After that, just send your message again.</i>` } });
    }
    if (widgets.length) sections.push({ widgets });
  }

  const header = pending
    ? { title: 'Review before Buddy makes changes', subtitle: total > 1 ? `${total} changes to review` : '1 change to review' }
    : { title: 'All changes reviewed', subtitle: 'Buddy is finishing up.' };

  return {
    text: 'Buddy needs your approval before making changes.',
    cardsV2: [{ cardId: 'approval', card: { header, sections } }],
  };
}

/** A short status card, optionally with a "Try again" button for the saved original message. */
function noticeCard(title, text, retryRequestId) {
  return simpleCard('notice', {
    title,
    text,
    buttons: retryRequestId ? [actionButton('Try again', ACTIONS.RETRY, { requestId: retryRequestId })] : [],
  });
}

const updateMessage = body => ({ actionResponse: { type: 'UPDATE_MESSAGE' }, ...body });
const newMessage = body => ({ actionResponse: { type: 'NEW_MESSAGE' }, ...body });

module.exports = {
  ACTIONS, approvalCard, connectCard, noticeCard, renderReply, simpleCard, renderFields,
  clockTime, updateMessage, newMessage,
};
