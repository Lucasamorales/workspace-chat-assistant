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
| Avatar URL | `https://buddy-oauth-000000000000.europe-west1.run.app/assets/buddy-avatar.png` (works after the first deploy that includes the images) |
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
- [ ] `hello` → a reply replaces "_Hmm, give me a sec…_"
- [ ] `/help` → card with examples and buttons (Connect Asana, My usage, Start fresh)
- [ ] While not connected: "what's due today in Asana?" → **Let's connect your Asana first** card
- [ ] **Connect Asana** → Asana consent → "Yessss, Asana's connected!" page
- [ ] Back in Chat → **I've connected, continue** → Buddy answers the original question without retyping
- [ ] Open the same connect link again → "Oh no, this link has expired"
- [ ] `/asana status` → **Disconnect** → asks first → **Yes, disconnect** → "Connect again" button
- [ ] "What are my tasks due this week?" → answer, **no** approval card (read-only)
- [ ] `/asana tools` lists actions split into "runs without asking" and "asks for approval"
- [ ] "Create a task called Buddy test" → card shows Task title / Description / Due date / Assignee by name → **Cancel** → nothing created
- [ ] "Create two tasks A and B" → one section per task → **Approve** A, **Cancel** B → only A exists; no "finishing up" message; the card header ends on **All sorted! · Done** and Buddy adds at most one short line (or something new, like a link)
- [ ] "Create tasks C and D" → **Approve all** → both exist; clicking again changes nothing
- [ ] "Move task A's due date to Friday" → card says "changes something that already exists" (not "can't be undone")
- [ ] "Delete the task A" → card says "can't be undone" → Approve → gone
- [ ] Upload a PDF, an image and an .xlsx with a question each
- [ ] `/asana disconnect` → Buddy no longer appears under Asana → Settings → Apps

In a space with Buddy:
- [ ] `@Buddy hello` works; `@Buddy /asana connect` → "only works in a private chat with me"
- [ ] `@Buddy list my Asana tasks` → Buddy says Asana is DM-only

## 5b. Kudos test (test Sheet copy + test space)

One-time:
1. `gcloud services enable sheets.googleapis.com --project=your-gcp-project`
2. The **test copy** of the Kudos Sheet is shared as Editor with
   `buddy-bot@your-gcp-project.iam.gserviceaccount.com` (`KUDOS_SHEET_ID` in `infra/config.env`).
3. Deploy, then in the test space send `@Buddy-Asana /kudos check`. It replies with the space id.
4. Put that id in `KUDOS_SPACES` in `infra/config.env`, commit, deploy again.
5. `@Buddy-Asana /kudos check` again → "✅ Votes count here" and "✅ Sheet reachable".

Checklist (in the test space unless noted):
- [ ] `@Buddy-Asana kudos to @Remy for thinking big` → "Yessss! Logged 1 kudos from…"; a row appears in the **test** Sheet with G–H filled
- [ ] Two people, two values in one message → two rows with the right values
- [ ] Tag yourself → "can't give kudos to yourself", no row
- [ ] Same person a 4th time this month → "max per person", no row
- [ ] `@Buddy-Asana kudos for being curious` (no one tagged) → "didn't spot anyone tagged"
- [ ] `@Buddy-Asana summarise this thread for @Remy` → normal Claude reply, no row
- [ ] Vote in a DM with Buddy-Asana → "Nice try, chap!" reply, no row
- [ ] `/kudos` in a DM → your month's received/given
- [ ] `/kudos check` (admin) → "✅ Buddy can add rows"
- [ ] `@Buddy-Asana /kudos leadership @Charlie @Toni …` (admin) → list saved
- [ ] The **real** Kudos Sheet is unchanged

## 5d. OOO check (after the calendar is shared)

1. Add `ooo` to `MODULES` in `infra/config.env`, commit, deploy.
2. `/ooo check` in a DM → "✅ I can read the calendar: N OOO entries this week".
   A failure quotes Google's own message under "Google said:".

- [ ] `/ooo` → who's out today; `/ooo week` → Monday to Sunday
- [ ] Someone on a half-day shows hours in ARG; someone on multi-day leave shows the real last day
- [ ] The same person is listed once, not twice (own block + team invite)
- [ ] A day with nobody out → "Nobody's out today · Full house! 🎉"
- [ ] Answers match Remy's Apps Script bot for the same day
- [ ] Someone outside the pilot (basics-only) can use `/ooo` — it needs no Claude

## 5e. Leave check (after the delegation is in place)

1. Add `leave` to `MODULES` in `infra/config.env`, commit, deploy.
2. `/leave check` in a DM → "✅ Buddy can act on your calendar".

- [ ] `/leave shift ARG_8_5` → remembered; `/leave` shows it
- [ ] "I'm off next Thursday" → card shows whose calendar, dates, type, team invite → **Approve**
- [ ] Your calendar has the out-of-office block; a meeting invite for that day is auto-declined
- [ ] `wholeteam@` shows the leave, and it does **not** block anyone's availability
- [ ] Book the same day again → "Already booked", no duplicate
- [ ] "Off Friday afternoon" → half-day with your shift's hours
- [ ] "Cancel my leave on <that day>" → card says it cannot be undone → **Approve** → both events gone
- [ ] Cancel a range → leave on the day *after* the range is still there
- [ ] Ask Buddy to book leave for someone else → refused (unless you hold `leave.admin`)
- [ ] Remy (no `leave.admin`) tries the same → refused

## 5f. Admin module check

- [ ] `/access` in a DM → granted list, and "Not changeable from chat: admin, leave, assistant"
- [ ] "give <a colleague> access to kudos" → card shows module, person, and that they'll be able
      to talk to Buddy → **Approve**
- [ ] That colleague can use Kudos (they also need the Chat app shared with them in the console)
- [ ] "give <someone> access to leave" → refused, explains it stays in the config file
- [ ] "give someone@gmail.com access to kudos" → refused (company addresses only)
- [ ] "remove <colleague>'s kudos access" → card → **Approve** → they lose it
- [ ] Revoke someone listed in `infra/config.env` → Buddy says it's set in the file; they keep it
- [ ] A non-admin has no `/access` command and cannot grant anything

## 5c. Voice and look check

- [ ] Open `https://buddy-oauth-000000000000.europe-west1.run.app/assets/buddy-avatar.png` → pixel Buddy on orange
- [ ] Chat app shows the pixel avatar (Avatar URL set in the console)
- [ ] `hello` in a DM → reply in Buddy's voice ("Hey…", Toni-isms now and then)
- [ ] A review card shows thinking Buddy in the header and an orange **Approve** button
- [ ] Buddy's gears **move** on the review card (confirmed 2026-09-17, BACKLOG V2)
- [ ] Asana connect page (browser) shows Buddy, black border and orange accent

## 6. After Buddy is verified: remove the old bot

```bash
CONFIRM=yes bash infra/decommission-legacy.sh
```

Deletes `legacy-chat-bot`, the ClickUp/old Asana/old state secrets, and removes the
**Editor** role from the default compute service account.

## 6b. Who can use what

`/access` in a DM with Buddy is the answer, not `infra/config.env` alone: access is the union of
the file and grants admins made from chat. The file still governs `admin`, `leave`, `assistant`,
every role, and anyone listed there.

- Give someone a module: tell Buddy, e.g. "give riley@example.com access to kudos",
  and approve the card. Add "until 30 November" for temporary access.
- Take it away: "remove riley's kudos access". If she still has it afterwards, it is in the file.
- New starters also need the Chat app shared with them in the console (until visibility goes
  company-wide at the merge).

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
