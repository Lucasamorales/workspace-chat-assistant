# invoices

Google Cloud's invoices, where to find them, and a Chat message when a new one lands.
**Robin only for now** (`BUDDY_ACCESS_INVOICES`); anyone can be added later, and admins can grant it
from chat (`/access invoices` shows who).

Decision: `docs/decisions/0011-invoices-and-scheduled-tasks.md`.

## Where the invoices come from

Google has no API for invoice PDFs. A script on a PC, [`tools/invoice-fetcher`](../../tools/invoice-fetcher/README.md),
opens the billing console in its own Chrome profile once a week, saves any new PDF into a Drive
folder through Drive for desktop, and emails it. **This module only reads that folder**, with
`drive.readonly`: it never touches Google billing and never holds anyone's Google login.

```
PC (weekly) ── billing console ──► PDFs ──► Drive folder ◄── buddy-bot reads (Viewer)
                                  └──► email to Robin              │
                                                                   └── /invoices, daily DM
```

## Using it

| | |
|---|---|
| `/invoices` | The latest ten, newest first, each a link to the PDF in Drive |
| `/invoices check` | Can Buddy read the folder, how many invoices, who is told about new ones |

## The daily message

Once a day (12:00 Buenos Aires, Cloud Scheduler → `/tasks/daily`), the module looks for PDFs it
hasn't announced and returns one message — "A new Google Cloud invoice" or "3 new…", with a button
to see them all — for everyone in `INVOICES_NOTIFY`. The gateway delivers it by DM, and **only to
people who can use the module and talk to Buddy**: being on the notify list alone shows nobody
anything. Someone who has never opened a DM with Buddy is skipped (Chat apps can't start one).

- **Switching it on** announces only the last 7 days, not the whole history.
- **With nobody to notify** it keeps no state at all, so turning the list on later still
  announces the latest week.
- **An invoice is announced once**, even if a delivery fails: it stays in `/invoices`, and a
  repeat every day would be worse.

## Settings

| | |
|---|---|
| `INVOICES_FOLDER_ID` | **Required.** The Drive folder the fetcher saves into, shared as **Viewer** with `buddy-bot@your-gcp-project.iam.gserviceaccount.com` |
| `INVOICES_NOTIFY` | Who is told about new invoices (work emails, comma-separated). Empty: no messages |
| `INVOICES_TIMEZONE` | For the dates shown. Default `America/Argentina/Buenos_Aires` |
| `BUDDY_ACCESS_INVOICES` | Who can use it (config floor; `/access` can widen it) |

The daily message also needs the scheduler (`infra/scheduler.sh`, then `BUDDY_SCHEDULER_EMAIL`).

## Stores

`m_invoices__invoices/state`: whether it has run, the ids of the last 500 PDFs it has seen, and
when it last checked. Nothing about the invoices' contents: Buddy never opens the PDFs.

## Adding someone

1. Add their email to `BUDDY_ACCESS_INVOICES`, or an admin asks Buddy in a DM ("give riley@ access to invoices") and approves the card.
2. To have them told about new invoices too, add them to `INVOICES_NOTIFY`.
3. To have them emailed the PDFs, add them to `mail.to` in the fetcher's `config.local.json`.
4. Deploy (steps 1–2). They must have opened a DM with Buddy once for the daily message to reach them.

## Code

| | |
|---|---|
| `src/module.js` | The command, and deciding what is new (`onSchedule`) |
| `src/drive.js` | The only Google calls: list the folder's PDFs, read the folder's name |
| `src/token.js` | A `drive.readonly` token for `buddy-bot`, keyless |
| `src/present.js` | Everything the module says |
