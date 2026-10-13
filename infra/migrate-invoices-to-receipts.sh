#!/usr/bin/env bash
# One-off, 2026-09-29: the invoices module was renamed receipts. A module only ever sees its own
# storage (m_<name>__*), so what was saved under the old name is copied to the new one:
#
#   m_invoices__bills   → m_receipts__receipts
#   m_invoices__months  → m_receipts__months   (its "bill" field becomes "receipt")
#
# Copies only: nothing is deleted, and a document already copied is skipped, so it is safe to run
# again. Run it right after deploying the rename, so nothing added in between is missed.
set -euo pipefail
cd "$(dirname "$0")/.."
source infra/config.env

BASE="https://firestore.googleapis.com/v1/projects/$PROJECT_ID/databases/(default)/documents"
TOKEN=$(gcloud auth print-access-token)
[ -n "$TOKEN" ] || { echo "ERROR: no gcloud login. Run: gcloud auth login" >&2; exit 1; }

copy() {
  local from=$1 to=$2 rename=${3:-}
  echo "== $from → $to"
  local listing
  listing=$(curl -sf -H "Authorization: Bearer $TOKEN" "$BASE/$from?pageSize=300") || { echo "ERROR: couldn't read $from" >&2; exit 1; }
  # One line per document: its id, then its fields as JSON (with the field renamed if asked).
  # Piped, not through a temp file: on Windows, Node can't see Git Bash's /tmp.
  printf '%s' "$listing" | node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      const j = JSON.parse(s || "{}");
      const [from, to] = (process.argv[1] || ":").split(":");
      for (const d of j.documents || []) {
        const fields = { ...d.fields };
        if (from && fields[from]) { fields[to] = fields[from]; delete fields[from]; }
        console.log(d.name.split("/").pop() + "\t" + JSON.stringify({ fields }));
      }
    });' "$rename" | while IFS=$'\t' read -r id body; do
    code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
      "$BASE/$to?documentId=$id" -d "$body")
    case "$code" in
      200) echo "  copied   $id" ;;
      409) echo "  skipped  $id (already there)" ;;
      *)   echo "  FAILED   $id (HTTP $code)" >&2; exit 1 ;;
    esac
  done
}

copy m_invoices__bills m_receipts__receipts
copy m_invoices__months m_receipts__months bill:receipt
echo "Done. The old m_invoices__* collections are left as they were; delete them in the console once /receipts looks right."
