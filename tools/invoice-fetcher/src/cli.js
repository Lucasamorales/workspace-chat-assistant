#!/usr/bin/env node
// npm run login | inspect | run | dry-run | test-email   (see README.md)
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { loadConfig, problems } = require('../config');
const { createLog } = require('./files');
const { readPassword } = require('./secret');
const { createMailer } = require('./mail');
const { alertMail } = require('./plan');
const billing = require('./billing');
const { run } = require('./run');

const CHROME = [
  path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
  path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
];

async function launch(config, { headless }) {
  const { chromium } = require('playwright-core');
  fs.mkdirSync(config.profileDir, { recursive: true });
  try {
    const context = await chromium.launchPersistentContext(config.profileDir, { channel: 'chrome', headless, acceptDownloads: true, viewport: { width: 1400, height: 1000 } });
    return { context, page: context.pages()[0] || await context.newPage() };
  } catch (err) {
    if (/ProcessSingleton|profile.*in use|user data directory is already in use/i.test(err.message)) {
      throw new Error('The fetcher\'s Chrome profile is already open. Close the Chrome window from `npm run login` and try again.');
    }
    throw err;
  }
}

// Plain Chrome, not an automated one: Google refuses sign-ins from browsers under remote
// control, and a person signing in themselves is the point. The tool never sees the password.
function login(config, log) {
  const chrome = config.chromePath || CHROME.find(p => fs.existsSync(p));
  if (!chrome) throw new Error('Google Chrome isn\'t installed where expected. Install it, or set chromePath in config.local.json.');
  fs.mkdirSync(config.profileDir, { recursive: true });
  log.info('opening Chrome: sign in with the Google account that can see the billing account, check the invoices show, then close the window.');
  const child = spawn(chrome, [`--user-data-dir=${config.profileDir}`, '--no-first-run', '--no-default-browser-check', config.documentsUrl], { stdio: 'ignore' });
  return new Promise(resolve => child.on('exit', () => { log.info('Chrome closed. Try `npm run dry-run` next.'); resolve(); }));
}

async function inspect(config, log) {
  const { context, page } = await launch(config, { headless: false });
  try {
    await billing.open(page, config);
    const frames = await billing.describe(page);
    const candidates = await billing.findCandidates(page);
    const out = path.join(config.logDir, `inspect-${Date.now()}`);
    fs.mkdirSync(out, { recursive: true });
    await page.screenshot({ path: path.join(out, 'page.png'), fullPage: true });
    fs.writeFileSync(path.join(out, 'frames.json'), JSON.stringify({ url: page.url(), candidates, frames }, null, 2));
    log.info(`${candidates.length} download buttons matched SELECTORS.download. Everything the page offers is in ${out}`);
    for (const c of candidates) log.info(`  [${c.frameIndex}:${c.index}] ${c.label} | ${c.rowText.slice(0, 120)}`);
  } finally { await context.close(); }
}

async function screenshot(page, config) {
  if (!page) return null;
  try {
    const file = path.join(config.logDir, `failure-${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: true });
    return file;
  } catch { return null; }
}

async function main(mode) {
  const config = loadConfig();
  const log = createLog(config.logDir);
  const needs = { login: [false, false], inspect: [false, false], 'dry-run': [false, false], 'test-email': [false, true], run: [true, true] }[mode];
  if (!needs) {
    console.error('Usage: node src/cli.js login | inspect | run | dry-run | test-email');
    return 64;
  }
  const bad = problems(config, { needOutput: needs[0], needMail: needs[1] });
  if (bad.length) { bad.forEach(b => log.error(b)); return 2; }

  if (mode === 'login') { await login(config, log); return 0; }
  if (mode === 'inspect') { await inspect(config, log); return 0; }

  let mailer = null;
  if (needs[1]) {
    // Without a password there's no way to send an alert either, so this one only reaches the log.
    try { mailer = createMailer(config, { password: readPassword(config.mail) }); }
    catch (err) { log.error(err.message); return 2; }
  }
  if (mode === 'test-email') {
    await mailer.send({ subject: 'Invoice fetcher: test email', text: 'If you can read this, the invoice fetcher can email you. Nothing else to do.' });
    log.info(`test email sent to ${config.mail.to.join(', ')}`);
    return 0;
  }

  let browser = null;
  try {
    browser = await launch(config, { headless: true });
    const result = await run({ config, page: browser.page, mailer, log, dryRun: mode === 'dry-run' });
    log.info(`done: ${JSON.stringify(result)}`);
    return 0;
  } catch (err) {
    log.error(`${err.kind || 'unexpected'}: ${err.stack || err.message}`);
    if (!mailer) return 1;
    const shot = await screenshot(browser && browser.page, config);
    const alert = alertMail(err, { billingAccountId: config.billingAccountId, when: new Date().toISOString() });
    try {
      await mailer.send({ subject: alert.subject, text: alert.text, attachments: shot ? [{ filename: 'what-the-fetcher-saw.png', path: shot }] : [] });
      log.info(`alert sent: ${alert.subject}`);
      return 1;
    } catch (mailErr) {
      log.error(`and the alert email failed too: ${mailErr.message}`);
      return 2;
    }
  } finally {
    if (browser) await browser.context.close().catch(() => {});
  }
}

main(process.argv[2]).then(code => { process.exitCode = code; }, err => { console.error(err.message); process.exitCode = 2; });
