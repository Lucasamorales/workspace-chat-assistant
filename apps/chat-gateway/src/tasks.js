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
 * Buddy cannot open a DM on its own. Someone who has never messaged it is skipped, and the
 * summary says so.
 */

const { renderReply } = require('./cards');

const TASK = /^[a-z][a-z0-9-]{0,30}$/;
const SYSTEM = Object.freeze({ userId: '', userEmail: '', userDisplayName: '', spaceKind: 'SYSTEM' });

function createTaskRunner({ registry, chat, makeModuleContext, access, mayTalk, log }) {
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
            const space = await chat.findDirectMessage(email);
            if (!space) { skip('has never opened a chat with Buddy'); continue; }
            if (body.cardsV2) await chat.postCard(space, null, body.text, body.cardsV2);
            else await chat.postText(space, null, body.text);
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
