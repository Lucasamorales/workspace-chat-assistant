#!/usr/bin/env bash
# Removes the original bot and its leftovers. Run ONLY after Buddy is live and verified.
# Everything here is destructive, so it lists the plan and needs CONFIRM=yes.
set -euo pipefail
cd "$(dirname "$0")/.."
source infra/config.env
P="--project=$PROJECT_ID"
PROJNUM=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
COMPUTE_SA="serviceAccount:$PROJNUM-compute@developer.gserviceaccount.com"

cat <<EOF
This will:
  - delete Cloud Run service legacy-chat-bot (the old, public bot)
  - delete secrets clickup-client-secret, asana-client-secret, state-secret (old app only)
  - remove roles/editor from the default compute service account
  - remove the default compute service account's access to $SECRET_ANTHROPIC
EOF
[ "${CONFIRM:-}" = "yes" ] || { echo; echo "Re-run with CONFIRM=yes to proceed."; exit 1; }

gcloud run services delete legacy-chat-bot --region="$REGION" --quiet $P || true
for s in clickup-client-secret asana-client-secret state-secret; do
  gcloud secrets delete "$s" --quiet $P || true
done
gcloud secrets remove-iam-policy-binding "$SECRET_ANTHROPIC" --member="$COMPUTE_SA" \
  --role=roles/secretmanager.secretAccessor $P >/dev/null || true
gcloud projects remove-iam-policy-binding "$PROJECT_ID" --member="$COMPUTE_SA" --role=roles/editor --condition=None >/dev/null || true
gcloud projects remove-iam-policy-binding "$PROJECT_ID" --member="$COMPUTE_SA" --role=roles/datastore.user --condition=None >/dev/null || true
echo "Legacy bot decommissioned."
