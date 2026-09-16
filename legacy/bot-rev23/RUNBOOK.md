# Google Chat ↔ Claude bot — build runbook

Reproducible from zero to a working bot. Written after a first build where the auth layer
took roughly 90 minutes of debugging; every trap we hit is called out inline as **⚠ TRAP**
so you don't repeat it. Following this in order should take about 40 minutes.

**Reference build:** project `your-gcp-project`, org `example.com`,
region `europe-west1`, service `legacy-chat-bot`.

---

## 0. Prerequisites

- A Google Workspace account with admin rights to create a Chat app
- A GCP project you can attach billing to
- An Anthropic API key (console.anthropic.com → API Keys)
- Current per-million-token rates for your chosen model (claude.com/pricing) — needed in
  step 6, and the budget cap silently does nothing without them

Everything below runs in **Cloud Shell** (console.cloud.google.com → terminal icon).
`gcloud` and Node are preinstalled and already authenticated.

---

## 1. Project and billing

```bash
gcloud config set project YOUR_PROJECT_ID
gcloud beta billing projects describe YOUR_PROJECT_ID --format='value(billingEnabled)'
```

Expect `True`. If `False`:

```bash
gcloud beta billing accounts list
gcloud beta billing projects link YOUR_PROJECT_ID --billing-account=XXXXXX-XXXXXX-XXXXXX
```

> **⚠ TRAP — `Cloud billing quota exceeded`**
> This means the billing account has hit its cap on *number of linked projects*. It is not
> a payment problem. Either unlink a dead project
> (`gcloud beta billing projects list --billing-account=...` then `unlink`), use a different
> billing account, or request an increase at
> https://support.google.com/code/contact/billing_quota_increase

---

## 2. Enable APIs

```bash
gcloud services enable \
  run.googleapis.com \
  chat.googleapis.com \
  firestore.googleapis.com \
  secretmanager.googleapis.com \
  cloudbuild.googleapis.com
```

`cloudbuild` is required for `gcloud run deploy --source`. Easy to miss.

---

## 3. Firestore

```bash
gcloud firestore databases list          # "Listed 0 items." = none exists
gcloud firestore databases create --location=eur3
```

`eur3` is the European multi-region. Use a single region if your data policy requires it,
but keep it consistent with what you tell your security reviewer.

---

## 4. Store the Anthropic key

```bash
printf '%s' "sk-ant-YOUR-KEY" | gcloud secrets create anthropic-key --data-file=-
gcloud secrets versions list anthropic-key
```

> **⚠ TRAP — use `printf`, not `echo`**
> `echo` appends a newline, the key fails auth, and the resulting error is generic and
> misleading.

To rotate later:

```bash
printf '%s' "sk-ant-NEW" | gcloud secrets versions add anthropic-key --data-file=-
gcloud secrets versions destroy 1 --secret=anthropic-key
```

`:latest` in the deploy picks up new versions automatically.

---

## 5. Service account permissions

The Cloud Run runtime service account needs to read the secret and write to Firestore.

```bash
PROJNUM=$(gcloud projects describe $(gcloud config get-value project) --format='value(projectNumber)')
SA="${PROJNUM}-compute@developer.gserviceaccount.com"
echo "runtime SA: $SA"

gcloud secrets add-iam-policy-binding anthropic-key \
  --member="serviceAccount:${SA}" --role='roles/secretmanager.secretAccessor'

gcloud projects add-iam-policy-binding $(gcloud config get-value project) \
  --member="serviceAccount:${SA}" --role='roles/datastore.user'
```

Note `$PROJNUM` — you need it again in step 6.

---

## 6. Source files

```bash
mkdir -p ~/legacy-chat-bot && cd ~/legacy-chat-bot
```

Three files. **Upload `server.js`** via the Cloud Shell toolbar (⋮ → Upload → File; it lands
in `$HOME`, then `mv ~/server.js ~/legacy-chat-bot/`), or paste it in the Cloud Shell
**editor**.

> **⚠ TRAP — never paste `server.js` into the terminal with `cat > file << EOF`**
> It contains backticks and `${}` in template literals; the shell will execute them and
> silently corrupt the file. Terminal heredocs are fine for `package.json` (no shell
> metacharacters), not for the JS.

> **⚠ TRAP — bracketed paste**
> Long multi-line commands pasted into the terminal can pick up a stray `200~` marker and
> truncate the last argument. In our build this produced `MAX_TURNS=20~`, which parses as
> `NaN` and silently disables context trimming. For anything longer than a few lines, write
> it to a `.sh` file in the editor and `bash` it.

`package.json`:

```bash
cat > ~/legacy-chat-bot/package.json << 'EOF'
{
  "name": "legacy-chat-bot",
  "type": "commonjs",
  "engines": { "node": ">=20" },
  "scripts": { "start": "node server.js" },
  "dependencies": {
    "@google-cloud/firestore": "^7",
    "express": "^4",
    "google-auth-library": "^9",
    "googleapis": "^140",
    "xlsx": "^0.18"
  }
}
EOF
```

`.gcloudignore` — without this every deploy uploads `node_modules`:

```bash
printf 'node_modules\n.git\n' > ~/legacy-chat-bot/.gcloudignore
```

Verify:

```bash
cd ~/legacy-chat-bot
ls -la
node --check server.js && echo "syntax OK"
node -e "require('./package.json'); console.log('package.json OK')"
```

`node --check` prints nothing on success — the `&& echo` is the confirmation. Run it before
every deploy; it catches scope and brace errors that otherwise cost a 3-minute build cycle.

---

## 7. First deploy

Substitute real pricing values.

```bash
cd ~/legacy-chat-bot
PROJNUM=$(gcloud projects describe $(gcloud config get-value project) --format='value(projectNumber)')

gcloud run deploy legacy-chat-bot \
  --source . --region europe-west1 \
  --no-allow-unauthenticated --no-cpu-throttling \
  --timeout 300 --min-instances 0 --max-instances 3 \
  --set-secrets ANTHROPIC_API_KEY=anthropic-key:latest \
  --set-env-vars MODEL=claude-sonnet-5,MONTHLY_USD_CAP=15,MAX_TURNS=20,USD_PER_MTOK_IN=X,USD_PER_MTOK_OUT=Y,PROJECT_NUMBER=$PROJNUM
```

Accept the Artifact Registry repo prompt. First build ~3 minutes.

> **⚠ `--no-cpu-throttling` is mandatory.** The handler acks the webhook with a 200 and then
> continues working. Without this flag Cloud Run freezes the container at the moment of the
> ack and the reply is never sent.

> **⚠ TRAP — `gcloud run services update` drops unspecified config**
> A bare `gcloud run deploy` or an `update` with only some flags can drop env vars and secret
> mounts. After any redeploy, verify:
> ```bash
> gcloud run services describe legacy-chat-bot --region europe-west1 \
>   --format='value(spec.template.spec.containers[0].env)'
> ```
> Also note `--no-allow-unauthenticated` is a `deploy` flag only; `update` rejects it. To
> lock an already-public service, remove the binding (step 9).

---

## 8. Set the audience

The service URL isn't known until after the first deploy, so this is a second pass.

```bash
URL="$(gcloud run services describe legacy-chat-bot --region europe-west1 --format='value(status.url)')"
echo "$URL"

gcloud run services update legacy-chat-bot --region europe-west1 \
  --update-env-vars CHAT_AUDIENCE=$URL
```

> **⚠ Cloud Run issues two hostnames** — a numeric form
> (`svc-000000000000.europe-west1.run.app`) and a hash form (`svc-pjexe4t6pq-ew.a.run.app`).
> Both are valid and both route. Pick one and use it *identically* in `CHAT_AUDIENCE` and in
> the Chat console, with no trailing slash. A mismatch fails JWT verification.

---

## 9. Verify the service is reachable

```bash
curl -i -X POST -H 'Content-Type: application/json' -d '{}' "$URL/"
```

Read the response carefully — **the headers tell you who answered**:

| Response | Who | Meaning |
|---|---|---|
| `x-powered-by: Express`, `content-length: 0`, 401 | your app | Working. It rejected an unsigned request, as designed. |
| Google-branded HTML, 403 | Cloud Run edge | IAM rejected the caller before your container ran. |
| Google-branded HTML, 404 | Google frontend | See the `/healthz` trap below. |

> **⚠ TRAP — `/healthz` returns a Google 404 from outside**
> Health-check paths appear to be intercepted at Google's frontend and never reach the
> container. In our build this consumed the better part of an hour: `POST /` returned a
> correct Express 401 the whole time while `GET /healthz` returned a Google 404, which read
> as "the service is broken". **Test with `POST /`, not `/healthz`.** (`/healthz` still works
> locally and via the Cloud Run proxy.)

Local sanity check, if you want to isolate app from platform:

```bash
npm install
PORT=8080 node server.js &
sleep 3 && curl -i http://localhost:8080/healthz
kill %1
```

---

## 10. Configure the Chat app

Console URL:
`https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat?project=YOUR_PROJECT_ID`

> **⚠** Searching "Google Chat API" in the console search bar often lands on the Marketplace
> product page, which has no Configuration tab. Use the URL above.

> **⚠ TRAP — "Build this Chat app as a Workspace add-on"**
> **Leave this UNTICKED.** Ticking it changes the entire request contract:
> - caller becomes `service-<PROJNUM>@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`,
>   not `chat@system.gserviceaccount.com`
> - user agent becomes `Google-gsuiteaddons`, not `Google-Dynamite`
> - the **Authentication Audience** field disappears from the page
> - the event payload is completely different — `commonEventObject` /
>   `authorizationEventObject` instead of `type` / `space` / `message` / `user`, so a
>   classic-payload handler silently does nothing
>
> The tick is reversible; **saving with it unticked is what's permanent.** This code targets
> the classic Chat payload, so untick it, save, and accept the lock-in. If you ever need
> add-on mode, it's a new Cloud project and Chat app — the Cloud Run service, secret and
> Firestore all carry over.

Settings:

| Field | Value |
|---|---|
| Build as Workspace add-on | **unticked** |
| App name | Claude (or your choice) |
| Avatar URL | any square HTTPS PNG |
| Description | max 40 chars |
| Enable interactive features | on |
| Functionality | tick **Receive 1:1 messages** and **Join spaces and group conversations** |
| Connection settings | **HTTP endpoint URL** |
| Triggers | **Use a common HTTP endpoint URL for all triggers** |
| HTTP endpoint URL | your `$URL`, no trailing slash |
| Authentication Audience | **App URL** |
| Visibility | specific people → your own email first |
| Logs | tick "Log errors to Logging" |

> **⚠** Choosing "Specify an HTTP endpoint URL for each trigger" demands four separate URLs
> and blocks Save with validation errors. This service handles everything at `/`, so use the
> common-endpoint option.

Leave Commands empty. The `/connect`, `/reset` and `/usage` handlers parse message text
directly; registering them here only adds UI autocomplete.

---

## 11. Grant Chat permission to invoke

```bash
gcloud run services add-iam-policy-binding legacy-chat-bot --region europe-west1 \
  --member='serviceAccount:chat@system.gserviceaccount.com' --role='roles/run.invoker'

gcloud run services get-iam-policy legacy-chat-bot --region europe-west1
```

Only `chat@system.gserviceaccount.com` should be listed. If `allUsers` is present from
debugging:

```bash
gcloud run services remove-iam-policy-binding legacy-chat-bot --region europe-west1 \
  --member='allUsers' --role='roles/run.invoker'
```

**Google Chat calls your service over the public internet.** There is no private tunnel.
Security comes from the IAM binding plus the in-app JWT verification, not from network
isolation. "Unreachable from outside" is a bug, not a goal.

---

## 12. Test

Google Chat → new chat → search your app name → send `hello`.

Expected: `_thinking…_` appears, then is replaced by a reply within a few seconds.

Watch logs while testing:

```bash
gcloud run services logs read legacy-chat-bot --region europe-west1 --limit 20
```

Live tail (needs a one-off component install):

```bash
sudo apt-get install -y google-cloud-cli-log-streaming
gcloud beta run services logs tail legacy-chat-bot --region europe-west1
```

Then verify the extras:

| Command | Expected |
|---|---|
| `/usage` | zeros, or your first request's tokens |
| `/reset` | `Thread context cleared.` |
| upload a small .xlsx + a question | reads the sheet contents |

---

## 13. Troubleshooting

Work top-down; each row assumes the ones above are clear.

| Symptom | Cause | Fix |
|---|---|---|
| "App not responding" in Chat, no Cloud Run request log | Chat can't reach the endpoint | Check the endpoint URL in the console matches `$URL` exactly |
| Request log shows **403**, no app log lines | Edge IAM rejection | Add the invoker binding (step 11). Check the caller identity matches what's bound |
| Request log shows **401**, no `auth failed` line | JWT verified but issuer check failed | Set `DEBUG_AUTH=1` and redeploy; read the logged `email=` and confirm it's in `CHAT_ISSUERS` |
| `auth failed: ... requires an ID Token` | No/malformed Authorization header | Confirm Authentication Audience is set in the console |
| `auth failed` with an audience error | `CHAT_AUDIENCE` ≠ console endpoint URL | Make them byte-identical, no trailing slash |
| **200** logged, no reply in Chat, no error | Event shape mismatch — usually add-on mode | See the add-on trap in step 10 |
| `documentPath must point to a document` | Raw `users/123` used as a Firestore doc ID | Already fixed via `.split('/').pop()`; check any new code you add |
| Reply sticks on `_thinking…_` | Chat API write-back failing | Runtime SA needs the `chat.bot` scope; check logs for the API error |
| `Anthropic 401` | Bad or unmounted key | `describe` the service and confirm the secret is mounted |
| Budget cap never trips | `USD_PER_MTOK_*` unset or non-numeric → `NaN` | Set real values; `NaN >= cap` is always false |
| Edits don't take effect | File not saved before deploy | `grep -n "<your new line>" server.js` before every deploy |

**Debug technique that actually worked:** rather than theorising about config, log at the
boundary. Add a `console.log` as the first statement in the handler dumping user agent and
Authorization header, then a second dumping `JSON.stringify(event).slice(0, 600)`. Those two
lines identified both the add-on caller identity and the payload mismatch in one deploy
cycle each, after several wrong hypotheses about ingress, org policy and default URLs.

Note that `console.error` and `console.log` both reach Cloud Logging, but the request log
line and the app's stdout can appear out of order — absence of a log line immediately after
a request is not proof the code didn't run.

---

## 14. Configuration reference

| Env var | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | mounted from Secret Manager |
| `CHAT_AUDIENCE` | must equal the console endpoint URL exactly |
| `PROJECT_NUMBER` | builds the add-on service-agent address for the issuer allowlist |
| `MODEL` | e.g. `claude-sonnet-5` |
| `MONTHLY_USD_CAP` | per-user hard stop, checked before each API call |
| `USD_PER_MTOK_IN` / `_OUT` | from claude.com/pricing |
| `MAX_TURNS` | conversation turns retained per thread |
| `OAUTH_START_URL` | step 3, Asana OAuth |
| `DEBUG_AUTH` | set to `1` to log JWT email/audience |

Firestore layout:

| Path | Contents |
|---|---|
| `users/{chatUserId}` | Asana token + expiry; monthly token counts and USD |
| `threads/{sha1(threadName)}` | last `MAX_TURNS` messages |

---

## 15. Not yet built

- Asana OAuth start/callback routes and refresh-token exchange
- Firestore TTL on `threads` (recommend 30 days on the `updated` field)
- Drive-sourced attachments (needs Drive scopes + per-user consent)
- Registered slash commands for UI autocomplete

---

## 16. Teardown

```bash
gcloud run services delete legacy-chat-bot --region europe-west1 --quiet
gcloud secrets delete anthropic-key --quiet
gcloud firestore databases delete --database='(default)' --quiet
```

Also delete the Chat app configuration in the console, and revoke the Anthropic API key.
