#!/usr/bin/env bash
# One-time (and safe to re-run) setup of everything Buddy needs in Google Cloud.
# Creates dedicated least-privilege service accounts, the KMS key, secrets, the image
# repository and Firestore auto-delete policies. Does NOT touch the old legacy-chat-bot.
set -euo pipefail
cd "$(dirname "$0")/.."
source infra/config.env

P="--project=$PROJECT_ID"
sa_email() { echo "$1@$PROJECT_ID.iam.gserviceaccount.com"; }
BOT="serviceAccount:$(sa_email "$BOT_SA")"
OAUTH="serviceAccount:$(sa_email "$OAUTH_SA")"
BUILD="serviceAccount:$(sa_email "$BUILD_SA")"
step() { printf '\n== %s\n' "$*"; }

step "Enable APIs"
gcloud services enable run.googleapis.com chat.googleapis.com firestore.googleapis.com \
  secretmanager.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  cloudkms.googleapis.com sheets.googleapis.com calendar-json.googleapis.com \
  iamcredentials.googleapis.com drive.googleapis.com aiplatform.googleapis.com $P

step "Service accounts"
for sa in "$BOT_SA" "$OAUTH_SA" "$BUILD_SA"; do
  gcloud iam service-accounts describe "$(sa_email "$sa")" $P >/dev/null 2>&1 \
    || gcloud iam service-accounts create "$sa" --display-name="Buddy $sa" $P
done

step "Firestore access (read/write documents only)"
for m in "$BOT" "$OAUTH"; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="$m" --role=roles/datastore.user --condition=None >/dev/null
done

step "Bot: mint its own scoped tokens (leave, manual) and use Vertex AI embeddings (manual)"
# Acting as a person on their own calendar, and asking Drive for a drive.readonly token, both
# need the bot to sign tokens as itself. No key is ever created.
gcloud iam service-accounts add-iam-policy-binding "$(sa_email "$BOT_SA")" \
  --member="$BOT" --role=roles/iam.serviceAccountTokenCreator $P >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="$BOT" --role=roles/aiplatform.user --condition=None >/dev/null

step "Build account: write images, write build logs, read uploaded source"
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="$BUILD" --role=roles/logging.logWriter --condition=None >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="$BUILD" --role=roles/storage.objectViewer --condition=None >/dev/null

step "Artifact Registry repository + cleanup policy"
gcloud artifacts repositories describe "$AR_REPO" --location="$REGION" $P >/dev/null 2>&1 \
  || gcloud artifacts repositories create "$AR_REPO" --repository-format=docker --location="$REGION" $P
gcloud artifacts repositories add-iam-policy-binding "$AR_REPO" --location="$REGION" \
  --member="$BUILD" --role=roles/artifactregistry.writer $P >/dev/null
for m in "$BOT" "$OAUTH"; do
  gcloud artifacts repositories add-iam-policy-binding "$AR_REPO" --location="$REGION" \
    --member="$m" --role=roles/artifactregistry.reader $P >/dev/null
done
gcloud artifacts repositories set-cleanup-policies "$AR_REPO" --location="$REGION" \
  --policy=infra/ar-cleanup-policy.json --no-dry-run $P >/dev/null

step "KMS key for encrypting Asana tokens (rotates every 90 days)"
gcloud kms keyrings describe "$KMS_KEYRING" --location="$REGION" $P >/dev/null 2>&1 \
  || gcloud kms keyrings create "$KMS_KEYRING" --location="$REGION" $P
gcloud kms keys describe "$KMS_KEY" --keyring="$KMS_KEYRING" --location="$REGION" $P >/dev/null 2>&1 \
  || gcloud kms keys create "$KMS_KEY" --keyring="$KMS_KEYRING" --location="$REGION" --purpose=encryption \
       --rotation-period=90d --next-rotation-time="$(date -u -d '+90 days' +%Y-%m-%dT%H:%M:%SZ)" $P
kms_bind() {
  gcloud kms keys add-iam-policy-binding "$KMS_KEY" --keyring="$KMS_KEYRING" --location="$REGION" \
    --member="$1" --role="$2" $P >/dev/null
}
kms_bind "$BOT" roles/cloudkms.cryptoKeyEncrypterDecrypter   # reads tokens, re-seals after refresh
kms_bind "$OAUTH" roles/cloudkms.cryptoKeyEncrypter          # can store new tokens, can never read them

step "Secrets"
if ! gcloud secrets describe "$SECRET_STATE" $P >/dev/null 2>&1; then
  openssl rand -base64 48 | tr -d '\n' | gcloud secrets create "$SECRET_STATE" --replication-policy=automatic --data-file=- $P
fi
gcloud secrets describe "$SECRET_ASANA" $P >/dev/null 2>&1 \
  || gcloud secrets create "$SECRET_ASANA" --replication-policy=automatic $P
secret_bind() { gcloud secrets add-iam-policy-binding "$1" --member="$2" --role=roles/secretmanager.secretAccessor $P >/dev/null; }
secret_bind "$SECRET_ANTHROPIC" "$BOT"
secret_bind "$SECRET_STATE" "$BOT"
secret_bind "$SECRET_ASANA" "$BOT"
secret_bind "$SECRET_STATE" "$OAUTH"
secret_bind "$SECRET_ASANA" "$OAUTH"

step "Firestore: auto-delete expired documents (threads after 30 days, approvals after 15 min, …)"
for c in core__threads core__events core__pending core__oauth_sessions core__requests core__usage_events; do
  gcloud firestore fields ttls update expireAt --collection-group="$c" --enable-ttl --async $P >/dev/null
done

step "Done"
PROJNUM=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
cat <<EOF

Next:
  1. In the Asana developer console create an app of type "MCP app" with redirect URL
       https://$OAUTH_SERVICE-$PROJNUM.$REGION.run.app/auth/asana/callback
  2. Put its client ID in infra/config.env (ASANA_CLIENT_ID=...)
  3. Store its client secret (no trailing newline):
       printf '%s' 'PASTE_SECRET' | gcloud secrets versions add $SECRET_ASANA --data-file=- $P
  4. bash infra/deploy.sh
EOF
