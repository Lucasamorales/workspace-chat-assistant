/**
 * Scheduled tasks: the only way Buddy speaks first.
 *
 * Cloud Scheduler calls /tasks/<name>, signed as Buddy's own scheduler account (verified in
 * app.js). Every module with onSchedule runs with no person behind it and returns what to tell
 * whom; this delivers it by DM. Two rules make it safe to let a module name recipients:
 *
 *  - a recipient must be allowed to talk to Buddy *and* be able to use that module, checked here
 *    against the same rules as a message would be — a module's notify list can never reach past
 *    its access list;
 *  - a module never gets a space, a thread or a client: only emails and a reply, so it can post
 *    nowhere but the DM that Buddy itself looks up.
 *
 * Buddy cannot open a DM on its own, and Google won't let an app find one from an email address.
 * So it delivers to the DM it remembers from the person's own messages (core/people.js): someone
 * who has never written to Buddy is skipped, and the summary says so.
 */

const { renderReply } = require('./cards');

const TASK = /^[a-z][a-z0-9-]{0,30}$/;
const SYSTEM = Object.freeze({ userId: '', userEmail: '', userDisplayName: '', spaceKind: 'SYSTEM' });

// Never met: Buddy learns where someone's DM is from a message they send it.
const UNKNOWN = 'has not messaged Buddy yet (one message in a DM is enough)';

function createTaskRunner({ registry, chat, people, makeModuleContext, access, mayTalk, log }) {
  const post = (space, body) => (body.cardsV2 ? chat.postCard(space, null, body.text, body.cardsV2) : chat.postText(space, null, body.text));

  /**
   * Post to the DM Buddy remembers. If that space no longer takes the message (the chat was
   * removed and started again, say), ask Chat for the current one by the person's id — which an
   * app is allowed to do — and remember it. Returns false when there is no DM to post to.
   */
  async function deliver(person, email, body) {
    try {
      await post(person.space, body);
      return true;
    } catch (error) {
      const space = await chat.findDirectMessage(person.userId);
      if (!space) return false;
      if (space === person.space) throw error;
      await post(space, body);
      await people.remember({ email, userId: person.userId, space });
      return true;
    }
  }

  return async function runTask(task) {
    if (!TASK.test(String(task || ''))) throw Object.assign(new Error('unknown task'), { status: 404 });
    const results = await registry.runScheduled(mod => makeModuleContext(mod, SYSTEM), task);
    const summary = { task, sent: 0, skipped: 0, failedModules: [] };

    for (const r of results) {
      if (r.failed) summary.failedModules.push(r.module);
      for (const note of r.notes) {
        const body = renderReply(note.reply);
        for (const email of new Set(note.to)) {
          const skip = why => {
            summary.skipped += 1;
            log.warn('scheduled message not sent', { task, module: r.module, to: email, why });
          };
          if (!mayTalk(email)) { skip('not allowed to talk to Buddy'); continue; }
          if (!access.canUse(r.module, { email })) { skip(`cannot use ${r.module}`); continue; }
          try {
            const person = await people.find(email);
            if (!person) { skip(UNKNOWN); continue; }
            if (!await deliver(person, email, body)) { skip('their chat with Buddy is gone; one new message brings it back'); continue; }
            summary.sent += 1;
          } catch (error) {
            log.error('scheduled message failed', { task, module: r.module, to: email, error });
            skip('the Chat API refused');
          }
        }
      }
    }
    log.info('scheduled task finished', summary);
    return summary;
  };
}

module.exports = { createTaskRunner, SYSTEM };
