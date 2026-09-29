// The disk layer: the state file, the PDFs in the Drive folder, the log.
const fs = require('node:fs');
const path = require('node:path');
const { FetchError, emptyState } = require('./plan');

function readState(file) {
  if (!fs.existsSync(file)) return emptyState();
  try { return { ...emptyState(), ...JSON.parse(fs.readFileSync(file, 'utf8')) }; }
  catch (err) { throw new Error(`The state file ${file} is damaged (${err.message}). Don't delete it blindly: it is how the fetcher knows what it has already sent.`); }
}

// Written to a temporary file and renamed, so a crash never leaves half a state behind.
function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

function checkOutputDir(dir) {
  if (!fs.existsSync(dir)) throw new FetchError('save', `The folder ${dir} doesn't exist. Is Drive for desktop running?`);
}

// Drive for desktop uploads whatever appears in the folder, so a half-written PDF must never
// appear there: write it beside the state first, then copy it in whole. An existing file with
// the same name is left alone (safe to run twice).
function savePdf(dir, name, bytes, { workDir }) {
  checkOutputDir(dir);
  const target = path.join(dir, name);
  if (fs.existsSync(target)) return { path: target, already: true };
  fs.mkdirSync(workDir, { recursive: true });
  const tmp = path.join(workDir, `${Date.now()}-${name}`);
  fs.writeFileSync(tmp, bytes);
  try { fs.copyFileSync(tmp, target, fs.constants.COPYFILE_EXCL); }
  catch (err) { throw new FetchError('save', `Couldn't write ${target} (${err.code || err.message}).`); }
  finally { fs.rmSync(tmp, { force: true }); }
  return { path: target, already: false };
}

function createLog(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().slice(0, 7)}.log`);
  const line = (level, msg) => {
    const text = `${new Date().toISOString()} ${level} ${msg}`;
    fs.appendFileSync(file, `${text}\n`);
    (level === 'ERROR' ? console.error : console.log)(text);
  };
  return { file, info: m => line('INFO', m), warn: m => line('WARN', m), error: m => line('ERROR', m) };
}

module.exports = { readState, writeState, savePdf, checkOutputDir, createLog };
