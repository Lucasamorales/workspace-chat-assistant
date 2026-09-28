#!/usr/bin/env bash
# Build once, deploy both services with EVERY setting, then verify access rules.
# Refuses to run with failing tests or uncommitted changes (so a deploy can't miss files,
# which is what broke revision 24 of the old bot).
set -euo pipefail
cd "$(dirname "$0")/.."
source infra/config.env

fail() { echo "ERROR: $*" >&2; exit 1; }

# On Windows, `bash` from PowerShell is WSL, which has its own HOME and so its own (empty) gcloud
# config: `gcloud auth login` on the Windows side never reaches it. The error you get is "no
# active account selected", which sends you round the login loop instead of here.
if grep -qi 'microsoft\|wsl' /proc/version 2>/dev/null; then
  fail "this is WSL, where gcloud has no credentials. Run it with Git Bash instead:
  & \"C:\Program Files\Git\bin\bash.exe\" infra/deploy.sh"
fi
if [ -z "$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null)" ]; then
  fail "no active gcloud account in this shell. Run: gcloud auth login"
fi

[ -n "$ASANA_CLIENT_ID" ] || fail "ASANA_CLIENT_ID is empty in infra/config.env"
git diff --quiet && git diff --cached --quiet || fail "commit your changes first"
[ -z "$(git ls-files --others --exclude-standard)" ] || fail "untracked files present; commit or ignore them"

echo "== Tests"
npm test --silent

P="--project=$PROJECT_ID"
PROJNUM=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
BOT_URL="https://$BOT_SERVICE-$PROJNUM.$REGION.run.app"
OAUTH_URL="https://$OAUTH_SERVICE-$PROJNUM.$REGION.run.app"
KMS_KEY_NAME="projects/$PROJECT_ID/locations/$REGION/keyRings/$KMS_KEYRING/cryptoKeys/$KMS_KEY"
TAG="$(git rev-parse --short HEAD)"
IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/$AR_REPO/buddy:$TAG"

echo "== Build $IMAGE"
gcloud builds submit --config=infra/cloudbuild.yaml --substitutions="_IMAGE=$IMAGE" \
  --region="$REGION" --service-account="projects/$PROJECT_ID/serviceAccounts/$BUILD_SA@$PROJECT_ID.iam.gserviceaccount.com" \
  --default-buckets-behavior=regional-user-owned-bucket $P .

# '^|^' makes '|' the separator, because ALLOWED_USERS contains commas.
echo "== Deploy $OAUTH_SERVICE (public: login pages only)"
gcloud run deploy "$OAUTH_SERVICE" --image="$IMAGE" --region="$REGION" $P \
  --service-account="$OAUTH_SA@$PROJECT_ID.iam.gserviceaccount.com" \
  --allow-unauthenticated \
  --command=node --args=apps/oauth-gateway/src/index.js \
  --cpu-throttling --min-instances=0 --max-instances=2 --concurrency=20 --memory=512Mi --timeout=30 \
  --set-env-vars="^|^OAUTH_BASE_URL=$OAUTH_URL|BUDDY_MODULES=asana|KMS_KEY_NAME=$KMS_KEY_NAME|ASANA_CLIENT_ID=$ASANA_CLIENT_ID" \
  --set-secrets="STATE_SECRET=$SECRET_STATE:latest,ASANA_CLIENT_SECRET=$SECRET_ASANA:latest"

# Everything module-specific from config.env: access rules (BUDDY_ACCESS_*), roles (BUDDY_ROLE_*)
# and each enabled module's own settings (e.g. ASANA_*, KUDOS_*). Empty values are skipped.
# The cost knobs (docs/decisions/0009-cost-reduction.md). Same skip-if-empty rule: an empty value
# keeps the code's default rather than deploying a blank one.
COST_VARS=""
for v in MAX_OUTPUT_TOKENS MAX_HISTORY_CHARS CACHE_TTL MONTHLY_USD_CAP_SCOPED MODULE_TUNING MODEL_PRICES CLEAR_TOOL_USES; do
  if [ -n "${!v}" ]; then COST_VARS="$COST_VARS|$v=${!v}"; fi
done

# Experiment 0010, the subscription proxy: only when someone is listed. Then the tunnel URL is
# required and the shared secret comes from Secret Manager, like every other secret. Leaving
# CLAUDE_PROXY_USERS empty and deploying removes all of it from the service again.
PROXY_VARS=""
PROXY_SECRETS=""
if [ -n "${CLAUDE_PROXY_USERS:-}" ]; then
  [ -n "${CLAUDE_PROXY_URL:-}" ] || fail "CLAUDE_PROXY_USERS is set, so CLAUDE_PROXY_URL is required (the tunnel's https URL)"
  PROXY_VARS="|CLAUDE_PROXY_USERS=$CLAUDE_PROXY_USERS|CLAUDE_PROXY_URL=$CLAUDE_PROXY_URL"
  PROXY_SECRETS=",CLAUDE_PROXY_SECRET=$SECRET_PROXY:latest"
  echo "== Subscription proxy experiment ON for: $CLAUDE_PROXY_USERS"
fi

MODULE_PREFIXES=$(echo "$MODULES" | tr ',' '\n' | tr '[:lower:]' '[:upper:]' | sed 's/$/_/' | paste -sd '|' -)
MODULE_VARS=""
for v in $(compgen -A variable | grep -E "^(BUDDY_(ACCESS|ROLE)_|(${MODULE_PREFIXES})[A-Z])"); do
  if [ -n "${!v}" ]; then MODULE_VARS="$MODULE_VARS|$v=${!v}"; fi
done

echo "== Deploy $BOT_SERVICE (private: Google Chat only)"
gcloud run deploy "$BOT_SERVICE" --image="$IMAGE" --region="$REGION" $P \
  --service-account="$BOT_SA@$PROJECT_ID.iam.gserviceaccount.com" \
  --no-allow-unauthenticated \
  --command=node --args=apps/chat-gateway/src/index.js \
  --no-cpu-throttling --min-instances=0 --max-instances=3 --concurrency=20 --memory=1Gi --timeout=60 \
  --set-env-vars="^|^CHAT_AUDIENCE=$BOT_URL|OAUTH_BASE_URL=$OAUTH_URL|BUDDY_MODULES=$MODULES|BUDDY_ALLOWED_USERS=$ALLOWED_USERS|BUDDY_APP_NAME=$APP_NAME|KMS_KEY_NAME=$KMS_KEY_NAME|MODEL=$MODEL|EFFORT=$EFFORT|MONTHLY_USD_CAP=$MONTHLY_USD_CAP|USD_PER_MTOK_IN=$USD_PER_MTOK_IN|USD_PER_MTOK_OUT=$USD_PER_MTOK_OUT$COST_VARS$PROXY_VARS$MODULE_VARS" \
  --set-secrets="ANTHROPIC_API_KEY=$SECRET_ANTHROPIC:latest,STATE_SECRET=$SECRET_STATE:latest,ASANA_CLIENT_SECRET=$SECRET_ASANA:latest$PROXY_SECRETS"

gcloud run services add-iam-policy-binding "$BOT_SERVICE" --region="$REGION" $P \
  --member=serviceAccount:chat@system.gserviceaccount.com --role=roles/run.invoker >/dev/null

echo "== Verify access rules"
MEMBERS=$(gcloud run services get-iam-policy "$BOT_SERVICE" --region="$REGION" $P --format='value(bindings.members)')
[[ "$MEMBERS" != *allUsers* && "$MEMBERS" != *allAuthenticatedUsers* ]] || fail "$BOT_SERVICE is public! Remove the binding."
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{}' "$BOT_URL/")
[ "$CODE" = "403" ] || fail "expected 403 from an anonymous call to $BOT_SERVICE, got $CODE"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$OAUTH_URL/auth/asana/start?u=1")
[ "$CODE" = "400" ] || fail "expected 400 from $OAUTH_SERVICE for a link without a signed token, got $CODE"

cat <<EOF

Deployed $TAG.
  Chat endpoint (set in the Chat app console):  $BOT_URL
  Asana redirect URL (Asana developer console): $OAUTH_URL/auth/asana/callback
EOF
