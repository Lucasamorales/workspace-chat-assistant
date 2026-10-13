/**
 * Conversation memory per Chat thread: plain text only (no files, no tool internals),
 * capped in length, and auto-deleted by a Firestore TTL policy after `ttlDays`.
 */

const crypto = require('crypto');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Conversation history per Chat thread.
 *
 * @param maxMessages  how many recent messages to keep
 * @param maxChars     cap on the total size sent back to the model
 * @param ttlDays      how long a thread is kept before Firestore deletes it
 */
function createThreads({ store, maxMessages, maxChars = 8000, ttlDays, now = () => Date.now() }) {
  const col = store.collection('core__threads');
  const id = threadKey => crypto.createHash('sha256').update(threadKey).digest('hex');

  /**
   * Twenty messages is nothing in a terse thread and a great deal in a chatty one, and history is
   * re-sent on every request — so the cap is a size as well as a count. Oldest goes first.
   */
  function normalize(messages) {
    const trimmed = messages.slice(-maxMessages);
    let size = trimmed.reduce((n, m) => n + String(m.text || '').length, 0);
    while (trimmed.length > 2 && size > maxChars) {
      size -= String(trimmed.shift().text || '').length;
    }
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
