/** Google Chat cards for the approval step: one section per change, plus approve/cancel all. */

const ACTIONS = Object.freeze({
  APPROVE: 'buddy.approve',
  CANCEL: 'buddy.cancel',
  APPROVE_ALL: 'buddy.approveAll',
  CANCEL_ALL: 'buddy.cancelAll',
});

const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const EFFECT_NOTE = {
  delete: ' <font color="#d93025">— cannot be undone</font>',
  update: ' <i>— changes something that already exists</i>',
};

function button(text, fn, pendingId, index) {
  const parameters = [{ key: 'pendingId', value: pendingId }];
  if (index !== undefined) parameters.push({ key: 'item', value: String(index) });
  return { text, onClick: { action: { function: fn, parameters } } };
}

function renderFields(fields) {
  if (!fields || !fields.length) return '<i>(no details)</i>';
  return fields.map(f => `<b>${esc(f.label)}:</b> ${esc(f.value)}`).join('<br>');
}

function statusText(item) {
  if (item.state === 'running') return '⏳ Working on it…';
  if (item.state === 'declined') return '❌ Skipped — nothing was changed';
  if (item.state === 'done') return item.result && item.result.isError ? '⚠️ Asana returned an error' : '✅ Done';
  return '';
}

function approvalCard(pendingId, items) {
  const total = items.length;
  const pending = items.filter(it => it.state === 'pending').length;

  const sections = items.map((item, i) => ({
    widgets: [
      {
        decoratedText: {
          topLabel: `${item.module} · ${i + 1} of ${total}`,
          text: `<b>${esc(item.title)}</b>${EFFECT_NOTE[item.effect] || ''}`,
          wrapText: true,
        },
      },
      { textParagraph: { text: renderFields(item.fields) } },
      item.state === 'pending'
        ? { buttonList: { buttons: [button('Approve', ACTIONS.APPROVE, pendingId, i), button('Cancel', ACTIONS.CANCEL, pendingId, i)] } }
        : { decoratedText: { text: statusText(item) } },
    ],
  }));

  if (pending > 1) {
    sections.push({
      widgets: [{ buttonList: { buttons: [button('Approve all', ACTIONS.APPROVE_ALL, pendingId), button('Cancel all', ACTIONS.CANCEL_ALL, pendingId)] } }],
    });
  }

  const header = pending
    ? { title: total > 1 ? `Approve these ${total} changes?` : 'Approve this change?', subtitle: 'Nothing changes until you approve. Expires in 15 minutes.' }
    : { title: 'Changes reviewed', subtitle: 'Buddy is finishing up.' };

  return {
    text: 'Buddy needs your approval before making changes.',
    cardsV2: [{ cardId: 'approval', card: { header, sections } }],
  };
}

/** Synchronous reply to a click: replace the card in place. */
function cardResponse(card) {
  return { actionResponse: { type: 'UPDATE_MESSAGE' }, text: card.text, cardsV2: card.cardsV2 };
}

/** For clicks on a card whose request no longer exists: remove the buttons. */
function statusResponse(message) {
  return {
    actionResponse: { type: 'UPDATE_MESSAGE' },
    text: message,
    cardsV2: [{ cardId: 'approval', card: { header: { title: message }, sections: [{ widgets: [{ textParagraph: { text: ' ' } }] }] } }],
  };
}

module.exports = { approvalCard, cardResponse, statusResponse, renderFields, ACTIONS };
