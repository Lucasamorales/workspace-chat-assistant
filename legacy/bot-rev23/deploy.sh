#!/usr/bin/env bash
set -euo pipefail

URL="https://legacy-chat-bot-000000000000.europe-west1.run.app"

gcloud run services update legacy-chat-bot --region europe-west1 \
  --update-env-vars CHAT_AUDIENCE=$URL,MAX_TURNS=20

echo "--- all URLs on this service ---"
gcloud run services describe legacy-chat-bot --region europe-west1 --format='value(status.urls)'

echo "--- env vars ---"
gcloud run services describe legacy-chat-bot --region europe-west1 \
  --format='value(spec.template.spec.containers[0].env)'

echo "--- healthz ---"
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $(gcloud auth print-identity-token)" "$URL/healthz"