#!/usr/bin/env bash
# Build once, deploy both services with EVERY setting, then verify access rules.
# Refuses to run with failing tests or uncommitted changes (so a deploy can't miss files,
# which is what broke revision 24 of the old bot).
set -euo pipefail
cd "$(dirname "$0")/.."
source infra/config.env

fail() { echo "ERROR: $*" >&2; exit 1; }
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

# Per-module access rules and roles: every BUDDY_ACCESS_* / BUDDY_ROLE_* variable from config.env.
ACCESS_VARS=""
for v in $(compgen -A variable | grep -E "^BUDDY_(ACCESS|ROLE)_"); do ACCESS_VARS="$ACCESS_VARS|$v=${!v}"; done

echo "== Deploy $BOT_SERVICE (private: Google Chat only)"
gcloud run deploy "$BOT_SERVICE" --image="$IMAGE" --region="$REGION" $P \
  --service-account="$BOT_SA@$PROJECT_ID.iam.gserviceaccount.com" \
  --no-allow-unauthenticated \
  --command=node --args=apps/chat-gateway/src/index.js \
  --no-cpu-throttling --min-instances=0 --max-instances=3 --concurrency=20 --memory=1Gi --timeout=60 \
  --set-env-vars="^|^CHAT_AUDIENCE=$BOT_URL|OAUTH_BASE_URL=$OAUTH_URL|BUDDY_MODULES=$MODULES|BUDDY_ALLOWED_USERS=$ALLOWED_USERS|BUDDY_APP_NAME=$APP_NAME|KMS_KEY_NAME=$KMS_KEY_NAME|MODEL=$MODEL|EFFORT=$EFFORT|MONTHLY_USD_CAP=$MONTHLY_USD_CAP|USD_PER_MTOK_IN=$USD_PER_MTOK_IN|USD_PER_MTOK_OUT=$USD_PER_MTOK_OUT|ASANA_CLIENT_ID=$ASANA_CLIENT_ID$ACCESS_VARS" \
  --set-secrets="ANTHROPIC_API_KEY=$SECRET_ANTHROPIC:latest,STATE_SECRET=$SECRET_STATE:latest,ASANA_CLIENT_SECRET=$SECRET_ASANA:latest"

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
