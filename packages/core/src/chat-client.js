/** Thin wrapper over the Google Chat API (app authentication). */

const MAX_TEXT = 4000; // Chat's limit is 4096 characters; keep headroom

function splitText(text) {
  const chunks = [];
  let rest = String(text);
  while (rest.length > MAX_TEXT) {
    let cut = rest.lastIndexOf('\n', MAX_TEXT);
    if (cut < MAX_TEXT / 2) cut = MAX_TEXT;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  chunks.push(rest);
  return chunks;
}

function createChatClient({ api }) {
  async function post(space, thread, body) {
    const res = await api.spaces.messages.create({
      parent: space,
      messageReplyOption: 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD',
      requestBody: { ...body, ...(thread ? { thread: { name: thread } } : {}) },
    });
    return res.data.name;
  }

  return {
    splitText,

    postText: (space, thread, text) => post(space, thread, { text }),

    postCard: (space, thread, text, cardsV2) => post(space, thread, { text, cardsV2 }),

    /**
     * The DM between Buddy and a person, for a message Buddy starts itself (a scheduled one).
     * Null when they have never opened a chat with Buddy: an app cannot start one on its own.
     */
    async findDirectMessage(userEmail) {
      try {
        const res = await api.spaces.findDirectMessage({ name: `users/${userEmail}` });
        return (res.data && res.data.name) || null;
      } catch (error) {
        if (error && (error.code === 404 || error.status === 404)) return null;
        throw error;
      }
    },

    /** Replace a message's text; overflow goes into follow-up messages in the same thread. */
    async replaceText(messageName, space, thread, text) {
      const [first, ...rest] = splitText(text || '_(empty reply)_');
      await api.spaces.messages.patch({ name: messageName, updateMask: 'text', requestBody: { text: first } });
      for (const chunk of rest) await post(space, thread, { text: chunk });
    },

    async replaceWithCard(messageName, text, cardsV2) {
      await api.spaces.messages.patch({ name: messageName, updateMask: 'text,cards_v2', requestBody: { text, cardsV2 } });
    },

    /** Download an uploaded attachment, refusing anything over maxBytes without buffering it all. */
    async download(resourceName, maxBytes) {
      const res = await api.media.download({ resourceName, alt: 'media' }, { responseType: 'stream' });
      const chunks = [];
      let size = 0;
      for await (const chunk of res.data) {
        size += chunk.length;
        if (size > maxBytes) {
          res.data.destroy();
          throw Object.assign(new Error(`file is larger than ${Math.round(maxBytes / 1e6)} MB`), { expose: true });
        }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    },
  };
}

module.exports = { createChatClient, splitText, MAX_TEXT };
