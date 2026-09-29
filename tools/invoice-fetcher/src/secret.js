// The Gmail app password, read from Windows Credential Manager where set-password.ps1 put it.
// Never from a file, an argument or an environment variable, so it can't end up in a log, the
// task scheduler's history or git.
const { spawnSync } = require('node:child_process');

function readPassword({ credentialName, from }) {
  // The names go in as arguments, not pasted into the script, so nothing in them is ever run.
  const script = `
    param($resource, $user)
    [void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]
    try {
      $c = (New-Object Windows.Security.Credentials.PasswordVault).Retrieve($resource, $user)
      $c.RetrievePassword()
      [Console]::Out.Write($c.Password)
    } catch { exit 3 }`;
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `& {${script}} '${q(credentialName)}' '${q(from)}'`], { encoding: 'utf8', windowsHide: true });
  if (res.status === 3 || (res.status === 0 && !res.stdout)) {
    throw new Error(`There's no app password saved for ${from}. Run set-password.ps1 in tools/invoice-fetcher, as the same Windows user the scheduled task runs as.`);
  }
  if (res.status !== 0) throw new Error(`Couldn't read Windows Credential Manager (${(res.stderr || '').trim().split('\n')[0] || `exit ${res.status}`}).`);
  return res.stdout;
}

// Single-quoted PowerShell strings only need their own quote doubled.
const q = s => String(s).replace(/'/g, "''");

module.exports = { readPassword };
