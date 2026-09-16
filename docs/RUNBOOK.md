# Buddy runbook

Project `your-gcp-project` · region `europe-west1`. All commands run from the repo root
in Cloud Shell or any terminal with `gcloud`, `node 22`, `git` and `openssl`.

## 1. One-time setup

```bash
bash infra/setup.sh
```

Creates (safe to re-run): service accounts `buddy-bot`, `buddy-oauth`, `buddy-build`;
KMS key `buddy/tokens`; secrets `buddy-state-secret` (random) and `asana-mcp-client-secret`
(empty); Artifact Registry repo `buddy` with a cleanup policy; Firestore TTL policies.

## 2. Asana app

Any Asana user can create the app. If the workspace restricts third-party apps, an Asana
admin must approve it.

1. <https://app.asana.com/0/my-apps> → **Create new app** → type **MCP app** (not a regular
   OAuth app: Asana's MCP server rejects tokens from regular apps).
2. Redirect URL, exactly: `https://buddy-oauth-000000000000.europe-west1.run.app/auth/asana/callback`
3. Distribution: your Google Workspace.
4. Put the **client ID** in `infra/config.env` → `ASANA_CLIENT_ID=`. It is not secret.
5. Store the **client secret** in Secret Manager from PowerShell. The file is written without
   a trailing newline (a newline silently breaks the secret) and deleted right after:
   ```powershell
   $secure = Read-Host "Asana client secret" -AsSecureString
   $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
   [IO.File]::WriteAllText("$env:TEMP\asana-secret.txt", $plain)
   gcloud secrets create asana-mcp-client-secret --replication-policy=automatic --data-file="$env:TEMP\asana-secret.txt" --project=your-gcp-project
   Remove-Item "$env:TEMP\asana-secret.txt"
   ```
   If the secret already exists (e.g. `setup.sh` ran first), use `gcloud secrets versions add asana-mcp-client-secret` instead of `gcloud secrets create`.

## 3. Deploy

```bash
git commit -am "…"      # deploy refuses uncommitted changes
bash infra/deploy.sh
```

Runs all tests, builds one image, deploys `buddy-oauth` (public) and `buddy-bot` (Chat
only) with every setting, then checks: `buddy-bot` is not public, an anonymous call gets
403, and the old `?u=` login trick gets 400. Any failure stops the script.

## 4. Point the Chat app at Buddy (console, once)

<https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat?project=your-gcp-project>

| Field | Value |
|---|---|
| Build as Workspace add-on | **unticked** |
| App name | Buddy-Asana (renamed to Buddy at the merge, see `docs/BACKLOG.md` Epic 4) |
| Functionality | Receive 1:1 messages; Join spaces and group conversations |
| Connection | HTTP endpoint URL → `https://buddy-bot-000000000000.europe-west1.run.app` |
| Triggers | Use a common HTTP endpoint URL for all triggers |
| Authentication Audience | App URL |
| Visibility | **Specific people**: robin@example.com, remy@example.com |
| Logs | Log errors to Logging |

Saving this switches traffic from the old bot to Buddy. To roll back, put the old URL back
(`https://legacy-chat-bot-000000000000.europe-west1.run.app`) until the legacy bot is removed.

## 5. Acceptance checklist

In a DM with Buddy:
- [ ] `hello` → a reply replaces "_Buddy is thinking…_"
- [ ] `/help`, `/usage`, `/status`, `/reset`
- [ ] `/asana connect` → link → Asana consent → "Asana connected" page
- [ ] Open the same link again → "invalid or expired"
- [ ] "What are my tasks due this week?" → answer, **no** approval card (read-only)
- [ ] "Create a task called Buddy test" → approval card → **Cancel** → nothing created
- [ ] Same again → **Approve** → task exists in Asana; clicking Approve again → "already handled"
- [ ] "Delete the task Buddy test" → card says "cannot be undone" → Approve → gone
- [ ] Upload a PDF, an image and an .xlsx with a question each
- [ ] `/asana disconnect` → Buddy no longer appears under Asana → Settings → Apps

In a space with Buddy:
- [ ] `@Buddy hello` works; `@Buddy /asana connect` → "only works in a direct message"
- [ ] `@Buddy list my Asana tasks` → Buddy says Asana is DM-only

## 6. After Buddy is verified: remove the old bot

```bash
CONFIRM=yes bash infra/decommission-legacy.sh
```

Deletes `legacy-chat-bot`, the ClickUp/old Asana/old state secrets, and removes the
**Editor** role from the default compute service account.

## 7. Everyday operations

| Task | How |
|---|---|
| Logs | `gcloud run services logs read buddy-bot --region europe-west1 --limit 50` |
| Add a user | Add to `ALLOWED_USERS` in `infra/config.env` **and** Chat app visibility, then deploy |
| Change cap / model | Edit `infra/config.env`, commit, deploy |
| Rotate Anthropic key | `printf '%s' 'sk-ant-…' \| gcloud secrets versions add anthropic-key --data-file=-`, deploy, then disable the old version |
| Rotate state secret | `openssl rand -base64 48 \| tr -d '\n' \| gcloud secrets versions add buddy-state-secret --data-file=-`, deploy (open connect links become invalid) |
| Roll back | `gcloud run services update-traffic buddy-bot --region europe-west1 --to-revisions=REVISION=100` |
| Turn Asana off | Remove `asana` from `MODULES`, deploy. Nothing else changes |

## 8. Troubleshooting

| Symptom | Likely cause |
|---|---|
| "Buddy isn't enabled for you yet" | Email missing from `ALLOWED_USERS` |
| Chat: app not responding, log shows `rejected unauthenticated request` | Chat console endpoint URL ≠ `CHAT_AUDIENCE` (byte-for-byte, no trailing slash) or add-on mode ticked |
| Service won't start, log `Invalid configuration` | The log lists exactly which setting is wrong |
| Asana consent page error about `scope` | App was created as a regular OAuth app, not an MCP app |
| "That Asana account doesn't match your Google account" | Signed into Asana with another email. Intended; set `ASANA_REQUIRE_EMAIL_MATCH=false` only if emails legitimately differ |
| Every read asks for approval | Asana isn't marking tools read-only. List safe tools in `ASANA_READONLY_TOOLS` |
| `/healthz` returns a Google 404 from outside | Expected; Google's frontend intercepts it |
