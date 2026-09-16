/** Google Chat cards for the approval step. */

const ACTION_APPROVE = 'buddy.approve';
const ACTION_CANCEL = 'buddy.cancel';

const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** Show exactly what will be sent, key by key, so the user approves the real call. */
function renderInput(input) {
  const entries = Object.entries(input && typeof input === 'object' ? input : {});
  if (!entries.length) return '<i>(no parameters)</i>';
  return entries.map(([k, v]) => {
    let value = typeof v === 'string' ? v : JSON.stringify(v);
    if (value.length > 400) value = `${value.slice(0, 400)}…`;
    return `<b>${esc(k)}</b>: ${esc(value)}`;
  }).join('<br>');
}

function approvalCard(pendingId, pending) {
  const param = [{ key: 'pendingId', value: pendingId }];
  const widgets = pending.flatMap((p, i) => [
    {
      decoratedText: {
        topLabel: `${p.module} · action ${i + 1} of ${pending.length}`,
        text: `<b>${esc(p.title)}</b>${p.destructive ? ' <font color="#d93025">— cannot be undone</font>' : ''}`,
        wrapText: true,
      },
    },
    { textParagraph: { text: renderInput(p.input) } },
  ]);
  widgets.push({
    buttonList: {
      buttons: [
        { text: 'Approve', onClick: { action: { function: ACTION_APPROVE, parameters: param } } },
        { text: 'Cancel', onClick: { action: { function: ACTION_CANCEL, parameters: param } } },
      ],
    },
  });
  return {
    text: 'Buddy needs your approval before making changes.',
    cardsV2: [{
      cardId: 'approval',
      card: {
        header: { title: 'Approve these changes?', subtitle: 'Nothing changes until you click Approve. Expires in 15 minutes.' },
        sections: [{ widgets }],
      },
    }],
  };
}

/** Synchronous reply to a button click: replaces the approval card so it can't be clicked again. */
function statusResponse(message, pending = []) {
  return {
    actionResponse: { type: 'UPDATE_MESSAGE' },
    text: message,
    cardsV2: [{
      cardId: 'approval',
      card: {
        header: { title: message },
        sections: pending.length
          ? [{ widgets: pending.map(p => ({ decoratedText: { text: esc(p.title), topLabel: p.module } })) }]
          : [{ widgets: [{ textParagraph: { text: ' ' } }] }],
      },
    }],
  };
}

module.exports = { approvalCard, statusResponse, renderInput, ACTION_APPROVE, ACTION_CANCEL };
