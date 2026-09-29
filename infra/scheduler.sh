#!/usr/bin/env bash
# One-time: lets Cloud Scheduler wake buddy-bot every weekday morning, so a module can say
# something first — today, "your Google Cloud bill should be ready". Safe to run again: it
# updates what exists.
#
# The service stays private. Cloud Scheduler signs each call as its own service account, which
# may invoke buddy-bot and nothing else; buddy-bot checks the token is that account's before
# running anything (packages/core/src/chat-verify.js).
set -euo pipefail
cd "$(dirname "$0")/.."
source infra/config.env

fail() { echo "ERROR: $*" >&2; exit 1; }
P="--project=$PROJECT_ID"
SA=buddy-scheduler
SA_EMAIL="$SA@$PROJECT_ID.iam.gserviceaccount.com"
JOB=buddy-daily

echo "== Cloud Scheduler API"
gcloud services enable cloudscheduler.googleapis.com $P

echo "== Scheduler account $SA_EMAIL"
gcloud iam service-accounts describe "$SA_EMAIL" $P >/dev/null 2>&1 \
  || gcloud iam service-accounts create "$SA" --display-name="Buddy scheduler (wakes buddy-bot)" $P

PROJNUM=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
BOT_URL="https://$BOT_SERVICE-$PROJNUM.$REGION.run.app"

echo "== It may call buddy-bot, and nothing else"
gcloud run services add-iam-policy-binding "$BOT_SERVICE" --region="$REGION" $P \
  --member="serviceAccount:$SA_EMAIL" --role=roles/run.invoker >/dev/null

echo "== Job at 09:00 Buenos Aires time, Monday to Friday"
if gcloud scheduler jobs describe "$JOB" --location="$REGION" $P >/dev/null 2>&1; then VERB=update; else VERB=create; fi
gcloud scheduler jobs "$VERB" http "$JOB" --location="$REGION" $P \
  --schedule="0 9 * * 1-5" --time-zone="America/Argentina/Buenos_Aires" \
  --uri="$BOT_URL/tasks/daily" --http-method=POST \
  --oidc-service-account-email="$SA_EMAIL" --oidc-token-audience="$BOT_URL"

MEMBERS=$(gcloud run services get-iam-policy "$BOT_SERVICE" --region="$REGION" $P --format='value(bindings.members)')
[[ "$MEMBERS" != *allUsers* && "$MEMBERS" != *allAuthenticatedUsers* ]] || fail "$BOT_SERVICE is public! Remove the binding."

cat <<MSG

Done. Now set, in infra/config.env:
  BUDDY_SCHEDULER_EMAIL=$SA_EMAIL
then deploy. Until then buddy-bot refuses /tasks, and the job's calls fail harmlessly.
Run it once by hand to check:  gcloud scheduler jobs run $JOB --location=$REGION $P
MSG
