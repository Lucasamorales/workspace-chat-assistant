# infra

Shell scripts that set up and deploy Buddy on Google Cloud. They are bash, meant for Google
Cloud Shell. The step-by-step, including what to do in the Chat and Asana consoles, is
[`docs/RUNBOOK.md`](../docs/RUNBOOK.md).

| File | What it does |
|---|---|
| `config.env` | Every deployment setting, with placeholder values. No secrets: those live in Secret Manager |
| `setup.sh` | One-time setup, safe to re-run: service accounts, the KMS key, secrets, the image repository and Firestore auto-delete policies |
| `deploy.sh` | Builds once and deploys both services. Refuses to run with failing tests or uncommitted changes, then verifies the access rules |
| `scheduler.sh` | One-time: lets Cloud Scheduler call `buddy-bot` on weekday mornings for scheduled messages |
| `cloudbuild.yaml`, `ar-cleanup-policy.json` | The image build, and the rule that prunes old images |
| `migrate-invoices-to-receipts.sh` | A one-off data copy from when a module was renamed, kept as a record |
| `decommission-legacy.sh` | Removes the original bot's resources. Destructive: it prints its plan and needs `CONFIRM=yes` |

Before running anything, replace the placeholders in `config.env` with your own project,
people, sheets and spaces.
