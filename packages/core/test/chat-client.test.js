const test = require('node:test');
const assert = require('node:assert/strict');
const { createChatClient } = require('../src');

function setup({ dm = null } = {}) {
  const calls = [];
  const api = { spaces: {
    messages: { create: async req => { calls.push(req); return { data: { name: `${req.parent}/messages/1` } }; } },
    findDirectMessage: async req => {
      calls.push(req);
      if (!dm) throw Object.assign(new Error('not found'), { code: 404 });
      return { data: { name: dm } };
    },
  } };
  return { chat: createChatClient({ api }), calls };
}

test('a reply names its thread and asks to reply in it', async () => {
  const { chat, calls } = setup();
  await chat.postText('spaces/dm1', 'spaces/dm1/threads/t1', 'hi');
  assert.equal(calls[0].messageReplyOption, 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD');
  assert.deepEqual(calls[0].requestBody.thread, { name: 'spaces/dm1/threads/t1' });
});

// Chat refused the first scheduled reminder that reached a DM: a reply option with nothing to
// reply to. A message Buddy starts itself must be a plain new message.
test('a message with no thread (a scheduled reminder) is a plain new message, not a reply', async () => {
  const { chat, calls } = setup();
  await chat.postCard('spaces/dm1', null, 'Reminder', [{ cardId: 'c', card: {} }]);
  assert.equal('messageReplyOption' in calls[0], false);
  assert.equal('thread' in calls[0].requestBody, false);
  assert.equal(calls[0].parent, 'spaces/dm1');
});

test('a DM is looked up by Chat user id, whichever way the id is written; no DM is null, not an error', async () => {
  const found = setup({ dm: 'spaces/dm-robin' });
  assert.equal(await found.chat.findDirectMessage('users/111'), 'spaces/dm-robin');
  assert.equal(await found.chat.findDirectMessage('111'), 'spaces/dm-robin');
  assert.deepEqual(found.calls.map(c => c.name), ['users/111', 'users/111']);
  assert.equal(await setup().chat.findDirectMessage('222'), null);
});
