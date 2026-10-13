# Setting up the subscription proxy on a new PC

The experiment in `docs/decisions/0010-subscription-proxy.md`: Buddy answering the accounts in
`CLAUDE_PROXY_USERS` through the Claude CLI on a Claude subscription, from a PC, instead of the
API. This guide moves it to a new machine and makes it permanent: it survives reboots, and the
tunnel address never changes, so there is no redeploy every time something restarts.

**Who it answers.** Everyone in `CLAUDE_PROXY_USERS` is answered on the one Claude account the
proxy's CLI is logged into. List only accounts that belong to the owner of that Claude account.

Every command is Windows PowerShell, from a normal (not Administrator) window, unless it says
otherwise. Blocks marked *file* are lines to edit, not commands to run.

---

## 0. On the old PC, before anything else

The experiment only exists on the `develop` branch, and the new PC has to be able to fetch it:

```powershell
git push -u origin develop
```

Everything else is recreated on the new PC. Nothing needs copying.

## 1. Install the tools on the new PC

```powershell
winget install --id Git.Git
winget install --id OpenJS.NodeJS.LTS
winget install --id Google.CloudSDK
winget install --id Cloudflare.cloudflared
```

Close and reopen PowerShell so the new commands are found, then install Claude Code:

```powershell
npm install -g @anthropic-ai/claude-code
```

Install it with npm, as above: the proxy looks for `claude.exe` where npm puts it. If you install
it another way, point the proxy at it once:

```powershell
[Environment]::SetEnvironmentVariable('CLAUDE_BIN', 'C:\full\path\to\claude.exe', 'User')
```

## 2. Get the code

```powershell
Set-Location "$HOME\Documents"
git clone git@github.com:your-github-org/Buddy.git
Set-Location Buddy
git checkout develop
npm install
npm test
```

Every test should pass. The rest of this guide assumes you are in this `Buddy` folder.

## 3. The Claude account

The proxy's CLI uses whichever Claude account is logged in **for the Windows user that runs the
proxy**. See which one that is:

```powershell
claude auth status
```

Look for `"loggedIn": true`, `"authMethod": "claude.ai"` and the `email`. `claude.ai` means a
subscription. The proxy refuses to start with anything else (an API key, a Console login, or no
login at all), so it can never bill per use.

**To connect, or to change, the account:**

```powershell
claude auth logout
claude auth login
```

A browser opens: sign in with the Claude account you want. If the browser is already signed in to
claude.ai as a different account, switch accounts on that page first. Then run
`claude auth status` again to confirm the email, and restart the proxy (step 5) so it picks up
the new login. Buddy needs no change: it doesn't know or care which Claude account answers.

**Turn extra usage off** on that account (Claude settings → Usage). The proxy refuses to answer
while extra usage is on, because then a reply could be billed per use.

**If you also code with Claude Code on this PC**, the proxy and your coding share one login and
one five-hour window. To keep them apart, run the proxy under a separate Windows user: sign in as
that user, log its CLI in to the other Claude account, and do steps 4–5 as that user.

## 4. The shared secret

`buddy-bot` and the proxy share a secret; the proxy answers nothing without it. Moving machines
is a good moment to replace it, which also makes the old PC's copy useless:

```powershell
New-Item -ItemType Directory -Force "$HOME\.buddy" | Out-Null
node -e "require('fs').writeFileSync(require('os').homedir()+'/.buddy/proxy-secret.txt', require('crypto').randomBytes(32).toString('hex'))"
gcloud auth login
gcloud secrets versions add claude-proxy-secret --data-file="$HOME\.buddy\proxy-secret.txt" --project=your-gcp-project
```

The secret is written by node rather than PowerShell on purpose: PowerShell adds a line ending when
it pipes text, and writes UTF-16 with `>`, and either would make the secret silently not match.

From this moment, `buddy-bot` picks up the new secret as its instances restart, and the **old PC
stops working**. Do steps 5–7 in one go.

Tell the proxy where the secret is, once, for your Windows user:

```powershell
[Environment]::SetEnvironmentVariable('CLAUDE_PROXY_SECRET_FILE', "$HOME\.buddy\proxy-secret.txt", 'User')
```

Close and reopen PowerShell so it takes effect.

## 5. Run the proxy

**By hand first**, to see it work:

```powershell
node apps/claude-proxy/src/index.js
```

It should print `proxy listening` with the path and version of `claude.exe`. If it prints
`cannot start`, the reason is on the same line (see Troubleshooting). Stop it with Ctrl+C.

**Then permanently**, as a task that starts when you log in and restarts if it stops:

```powershell
$action   = New-ScheduledTaskAction -Execute (Get-Command node).Source -Argument "apps\claude-proxy\src\index.js" -WorkingDirectory (Get-Location).Path
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
Register-ScheduledTask -TaskName "Buddy claude-proxy" -Action $action -Trigger $trigger -Settings $settings
Start-ScheduledTask -TaskName "Buddy claude-proxy"
```

Check it's up:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/healthz
```

To stop, start or remove it later:

```powershell
Stop-ScheduledTask -TaskName "Buddy claude-proxy"
Start-ScheduledTask -TaskName "Buddy claude-proxy"
Unregister-ScheduledTask -TaskName "Buddy claude-proxy" -Confirm:$false
```

This runs while you're logged in. For a PC that should keep serving after a reboot with nobody
logged in, register the task with `New-ScheduledTaskTrigger -AtStartup` and add
`-User $env:USERNAME -Password <your Windows password>` to `Register-ScheduledTask`.

**Stop the PC from sleeping**, or the proxy vanishes with it:

```powershell
powercfg /change standby-timeout-ac 0
```

## 6. A permanent Cloudflare tunnel

A named tunnel gives the proxy an address that never changes, and runs as a Windows service that
starts at boot. It needs a Cloudflare account with a domain whose DNS is on Cloudflare.

1. In the Cloudflare dashboard: **Zero Trust → Networks → Tunnels → Create a tunnel →
   Cloudflared**. Name it `buddy-proxy`.
2. It shows an install command for Windows, `cloudflared.exe service install <token>`. Run it in
   an **Administrator** PowerShell. The token is a credential: don't paste it anywhere else, and
   never commit it.
3. Add a public hostname: subdomain `buddy-proxy`, your domain, service type **HTTP**, URL
   **`127.0.0.1:8787`**. Save.
4. From any machine:

   ```powershell
   Invoke-RestMethod https://buddy-proxy.<your-domain>/healthz
   ```

   It should answer `ok: True`.

Nothing is opened in the PC's firewall: the tunnel connects out to Cloudflare. Only the proxy's
port goes through it, and the proxy answers nothing without the secret. The loopback channel the
CLI uses is on a separate, random port the tunnel never reaches.

To check the tunnel service later: `Get-Service cloudflared`.

*No domain on Cloudflare?* Tailscale Funnel also gives a fixed `https://…ts.net` address. The quick
tunnel (`cloudflared tunnel --url http://127.0.0.1:8787`) works too, but its address changes every
time it restarts, and each change needs a redeploy.

## 7. Connect Buddy to it and deploy

In `infra/config.env` (*file*):

```
CLAUDE_PROXY_USERS=robin@example.com,<your second account>@example.com
CLAUDE_PROXY_URL=https://buddy-proxy.<your-domain>
```

No path and no trailing slash on the URL. Each listed account must also be allowed on Buddy as
usual (`ALLOWED_USERS` and the `BUDDY_ACCESS_*` lines for the modules it should have), and be
added to the Chat app's visibility in the console. Its permissions work exactly as for anyone
else: the proxy only ever receives what that account was already allowed.

Commit, then deploy from `develop`, in a normal PowerShell, from the `Buddy` folder:

```powershell
git add infra/config.env
git commit -m "chore: move the subscription proxy to the new PC"
& "C:\Program Files\Git\bin\bash.exe" infra/deploy.sh
```

Look for `Subscription proxy experiment ON for: …` in the output. Deploying `develop` replaces
`main`'s build for everyone, so first make sure `develop` has everything that's in `main`. Then
push, so the branch is backed up:

```powershell
git push
```

## 8. Check it works

- [ ] `claude auth status` shows the Claude account you meant, with `authMethod: claude.ai`
- [ ] `Invoke-RestMethod https://buddy-proxy.<your-domain>/healthz` answers from anywhere
- [ ] Say `hello` to Buddy from each listed account → a reply. In the proxy's log: `request`,
      `cli ready` with `authSource: "none"`, `request answered`
- [ ] Ask Buddy to create an Asana task → approval card → Approve → the log says
      `resuming a held session`, not `replaying`
- [ ] `/costs` → an **On the subscription** block with the window used
- [ ] Reboot the PC and log in → Buddy answers again without you starting anything

The log is `apps/claude-proxy/logs/proxy-<date>.jsonl`, one line per step. To read today's:

```powershell
Get-Content "apps/claude-proxy/logs/proxy-$(Get-Date -Format yyyy-MM-dd).jsonl" | ConvertFrom-Json | Select-Object at, message, ms, stop
```

The two lines worth searching for first are `replaying:` (a held session was lost) and
`guard refused` (a billing check stopped a reply).

## 9. Retire the old PC

- Stop its proxy and its tunnel (Ctrl+C in their windows).
- Delete `$HOME\.buddy\proxy-secret.txt` there. The secret was replaced in step 4, so it's
  useless anyway, but there's no reason to keep it.

## Troubleshooting

| What you see | Why | Fix |
|---|---|---|
| *"The subscription proxy couldn't answer: the proxy is not reachable"* | Proxy stopped, tunnel down, or PC asleep | `Get-ScheduledTask -TaskName "Buddy claude-proxy"`, `Get-Service cloudflared`, step 5's sleep setting |
| *"Invalid proxy key"* | The two sides have different secrets | `buddy-bot` not redeployed since step 4, or the proxy is reading an old file |
| `cannot start` … *not logged in* / *not a Claude subscription* | The CLI isn't on a subscription login | Step 3 |
| `guard refused` … *extra usage is switched on* | That Claude account allows pay-per-use | Turn extra usage off, restart the proxy |
| Buddy calls you by the proxy's Claude account instead of yours | `buddy-bot` is older than 2026-09-28's fix: the CLI tells the model its own account's email | Deploy `develop` again |
| Answers seem to come from the wrong Claude account | The task runs as a different Windows user than you think | `claude auth status` as the user the task runs as |
| `cannot start` … *Could not find claude.exe* | Claude Code isn't where npm puts it | Set `CLAUDE_BIN` (step 1) |
| An account not listed is answered by the API | Working as intended | Only `CLAUDE_PROXY_USERS` is routed to the proxy |

To turn the experiment off: empty `CLAUDE_PROXY_USERS`, commit, deploy. Everyone goes back to the
API, and the proxy can be stopped.
