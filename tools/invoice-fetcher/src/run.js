// One run, start to finish, with everything it touches passed in: so tests drive it with a fake
// page, a fake mailer and a temporary folder, and cli.js with the real ones.
const path = require('node:path');
const billing = require('./billing');
const { plan, recordSaved, recordSkipped, recordMailed, recordRun, invoicesMail, FetchError } = require('./plan');
const files = require('./files');

async function run({ config, page, mailer, log, now = Date.now, dryRun = false }) {
  let state = files.readState(config.stateFile);
  if (!dryRun) files.checkOutputDir(config.outputDir);

  await billing.open(page, config);
  const candidates = await billing.findCandidates(page);
  const p = plan(candidates, state, { now: now(), timeZone: config.timeZone, maxPerRun: config.maxPerRun });
  log.info(`page lists ${p.seen} documents; ${p.toFetch.length} new${p.firstRun ? ` (first run: only the latest; ${p.skip.length} older ones left alone)` : ''}; ${p.unmailed.length} saved but not yet emailed`);

  if (dryRun) {
    for (const d of p.toFetch) log.info(`would fetch ${d.fileName} (${d.id})`);
    return { dryRun: true, wouldFetch: p.toFetch.map(d => d.fileName), wouldSkip: p.skip.map(d => d.fileName), seen: p.seen };
  }

  // Each invoice is saved and remembered before the next one starts, so a failure half-way
  // keeps what was done and the next run carries on from there.
  const saved = [];
  const failed = [];
  for (const doc of p.toFetch) {
    try {
      const bytes = await billing.download(page, doc, config);
      const result = files.savePdf(config.outputDir, doc.fileName, bytes, { workDir: path.join(path.dirname(config.stateFile), 'work') });
      state = recordSaved(state, doc, { now: now() });
      files.writeState(config.stateFile, state);
      saved.push(doc.fileName);
      log.info(`${result.already ? 'already in Drive' : 'saved'}: ${doc.fileName}`);
    } catch (err) {
      if (err.kind === 'save' || err.kind === 'signin' || err.kind === 'layout') throw err;
      failed.push({ doc, err });
      log.warn(`couldn't fetch ${doc.fileName}: ${err.message}`);
    }
  }

  const toMail = Object.entries(state.documents).filter(([, d]) => d.mailed === false).map(([id, d]) => ({ id, ...d }));
  if (toMail.length) {
    const mail = invoicesMail(toMail, config);
    await mailer.send({ ...mail, attachments: toMail.map(d => ({ filename: d.file, path: path.join(config.outputDir, d.file) })) });
    state = recordMailed(state, toMail.map(d => d.id));
    files.writeState(config.stateFile, state);
    log.info(`emailed ${toMail.length} to ${config.mail.to.join(', ')}`);
  }

  // Only once the latest one is safely saved: if it failed, the next first run tries again.
  // Until then the run doesn't count as started either, or the next run would see all the older
  // ones as new.
  if (p.firstRun && saved.length) state = recordSkipped(state, p.skip, { now: now() });
  if (!p.firstRun || saved.length) state = recordRun(state, { now: now() });
  files.writeState(config.stateFile, state);

  // Partial failure is still failure: say which, after keeping everything that worked.
  if (failed.length) {
    throw new FetchError('download', `Fetched ${saved.length} of ${saved.length + failed.length}. Not fetched: ${failed.map(f => `${f.doc.fileName} (${f.err.message})`).join('; ')}`);
  }
  return { saved, mailed: toMail.length, seen: p.seen };
}

module.exports = { run };
