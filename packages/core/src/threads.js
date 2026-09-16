/**
 * Conversation memory per Chat thread: plain text only (no files, no tool internals),
 * capped in length, and auto-deleted by a Firestore TTL policy after `ttlDays`.
 */

const crypto = require('crypto');

const DAY_MS = 24 * 60 * 60 * 1000;

function createThreads({ store, maxMessages, ttlDays, now = () => Date.now() }) {
  const col = store.collection('core__threads');
  const id = threadKey => crypto.createHash('sha256').update(threadKey).digest('hex');

  function normalize(messages) {
    const trimmed = messages.slice(-maxMessages);
    while (trimmed.length && trimmed[0].role !== 'user') trimmed.shift(); // must start with the user
    return trimmed;
  }

  return {
    async load(threadKey) {
      const doc = await col.get(id(threadKey));
      if (!doc || new Date(doc.expireAt).getTime() < now()) return [];
      return normalize(doc.messages || []).map(m => ({ role: m.role, content: m.text }));
    },
    async append(threadKey, userText, assistantText) {
      await col.update(id(threadKey), doc => {
        const previous = doc && new Date(doc.expireAt).getTime() >= now() ? doc.messages || [] : [];
        return {
          messages: normalize([...previous, { role: 'user', text: userText }, { role: 'assistant', text: assistantText }]),
          expireAt: new Date(now() + ttlDays * DAY_MS),
        };
      });
    },
    reset: threadKey => col.delete(id(threadKey)),
  };
}

module.exports = { createThreads };
