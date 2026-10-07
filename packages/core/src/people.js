/**
 * Who Buddy has met: each person's Chat id and their DM with Buddy, learnt from the messages they
 * send it. It exists for the one thing Buddy does unprompted — a scheduled message — which needs
 * to know where a person's DM is.
 *
 * Google won't tell an app that from an email address: `spaces.findDirectMessage` takes
 * `users/<email>` only when signed in as a user, and Buddy signs in as itself ("Service account
 * authentication doesn't support access to user information using email aliases", 2026-10-07).
 * Every message a person sends carries both their id and the space, though, so Buddy keeps them.
 * No directory lookup, no extra permission — and someone who has never written to Buddy is
 * simply not known, which is also exactly who an app can't message first.
 */

function createPeople({ store, now = () => Date.now() }) {
  const col = store.collection('core__people');
  // What this instance has already saved, so a busy chat is one write per person, not one per message.
  const saved = new Map();
  const clean = email => String(email || '').trim().toLowerCase();

  return {
    /** Called on every DM event. Writes only when the id or the space is new or changed. */
    async remember({ email, userId, space }) {
      const key = clean(email);
      if (!key.includes('@') || !userId || !space) return;
      const mark = `${userId}|${space}`;
      if (saved.get(key) === mark) return;
      await col.set(key, { email: key, userId: String(userId), space, seenAt: new Date(now()).toISOString() });
      saved.set(key, mark);
    },

    /** { userId, space } for a work email, or null if they have never written to Buddy. */
    find: email => col.get(clean(email)),
  };
}

module.exports = { createPeople };
