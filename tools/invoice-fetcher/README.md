# invoice-fetcher

Runs on a PC, once a week: opens the Google Cloud billing console in its own Chrome profile,
saves any new invoice PDF into the Drive folder Buddy reads (through Drive for desktop), and emails
it. When it can't — the Google session expired, the page changed — it emails an alert saying what
to do, with a screenshot.

It exists because Google has no API for invoice PDFs. Everything that needs a Google login stays on
this PC; Buddy only reads the Drive folder ([`modules/invoices`](../../modules/invoices/README.md)).

Not part of the Buddy image: its own `package.json`, its own tests, never deployed to Cloud Run.

## What it never does

- **Never types a password or answers a sign-in challenge.** You sign in yourself, once, in a
  normal Chrome window (`npm run login`). It only reuses that session.
- **Never follows a link off Google.** Downloads are only taken from Google hosts, and must be real
  PDFs.
- **Never deletes or replaces anything.** A file already in the folder is left as it is.
- **Keeps no secret in a file.** The Gmail app password is in Windows Credential Manager.
- **Never runs headless.** Google took a headless Chrome on the signed-in profile for a stolen
  session and signed it out. Runs use a real Chrome window placed off-screen; you may see Chrome
  in the taskbar for a minute on Monday mornings. Leave it, it closes itself.

## Set up (once, on the PC)

Needs Node 22+, Google Chrome, and Drive for desktop signed in with the account that owns the
invoices folder.

1. **The Drive folder.** In Drive, make a folder (e.g. `Buddy invoices`), share it as **Viewer**
   with `buddy-bot@your-gcp-project.iam.gserviceaccount.com`, and copy its id from the URL
   (`drive.google.com/drive/folders/<id>`) into `INVOICES_FOLDER_ID` in `infra/config.env`.
2. **Install.** In `tools/invoice-fetcher`:
   ```powershell
   npm install
   ```
3. **Local settings.** Create `config.local.json` here (not committed), pointing at where Drive for
   desktop shows that folder:
   ```json
   { "outputDir": "G:\\My Drive\\Buddy invoices" }
   ```
   Anything in `config.js` can be overridden the same way, e.g. `"mail": { "to": "robin@example.com,someone@example.com" }`.
4. **Sign in.** `npm run login` opens Chrome with the fetcher's own profile. Sign in with the
   Google account that can see billing account `XXXXXX-XXXXXX-XXXXXX`, check the invoices show,
   close the window.
5. **Email.** Make an app password for the sending account (Google account → Security → App
   passwords; needs 2-Step Verification, and Workspace must allow app passwords), then save it:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\set-password.ps1
   npm run test-email
   ```
6. **Check the page.** `npm run inspect` opens the page, lists every document it can download,
   and saves a screenshot and a dump of the page to the log folder. If it found none, adjust
   `SELECTORS` in `src/billing.js` from the dump.

   the company's account gets monthly **statements**, listed in a payments.google.com frame with a
   checkbox per row and one "Download selected" button: the fetcher ticks one row, downloads,
   unticks, and finds each row again by its text so it can't save one month under another's name.
7. **Try it.** `npm run dry-run` says what it *would* fetch and changes nothing. Then `npm run run`
   for real. The first run takes **only the latest** document; older ones are remembered as
   "before we started" and never fetched. After that, each new month's arrives on its own.
8. **Schedule it.** Mondays at 10:00, or as soon as the PC is back if it was off:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\schedule.ps1
   ```

## Commands

| | |
|---|---|
| `npm run login` | Sign in again (after a "sign in to Google again" alert) |
| `npm run inspect` | See what the page offers, to fix the selectors after a "page looks different" alert |
| `npm run dry-run` | What would be fetched; changes nothing, sends nothing |
| `npm run run` | The weekly run |
| `npm run test-email` | Check the email works |
| `npm test` | The tests (no browser, no network) |
| `.\schedule.ps1 -Remove` | Stop the weekly run |

## Alerts

| Subject | Means | Do |
|---|---|---|
| sign in to Google again | The session expired or was signed out | `npm run login` |
| the billing page looks different | No invoices found, or suspiciously many "new" ones | `npm run inspect`, adjust `SELECTORS` |
| could not save to Drive | The folder isn't there | Start Drive for desktop; check `outputDir` |
| a download failed | Something came back that isn't a PDF | Nothing if it's once; `inspect` if it repeats |
| the run failed | Anything else | Read the log |

If the email itself can't be sent, only the log knows: `%LOCALAPPDATA%\buddy-invoice-fetcher\logs`.
Buddy will still announce any invoice that reached Drive.

## Where things are on the PC

`%LOCALAPPDATA%\buddy-invoice-fetcher\` holds `chrome-profile\` (the Google session — treat it like
a password), `state.json` (which invoices were saved and emailed; **don't delete it**, or everything
is fetched and emailed again) and `logs\`.

## Handover (docs/BUILDING-FOR-BUDDY.md)

| | |
|---|---|
| **What it does** | Saves new Google Cloud invoice PDFs to a Drive folder and emails them, weekly |
| **Who should use it** | Robin; others get the PDFs by being added to `mail.to`, and see them in Buddy through `BUDDY_ACCESS_INVOICES` |
| **What it touches** | Billing account `XXXXXX-XXXXXX-XXXXXX` (read), the invoices Drive folder (write), Gmail SMTP (send) |
| **Whose permissions** | The Google account signed into its Chrome profile; the sending account's app password |
| **What it writes** | New PDF files in the folder, `state.json`, logs. Nothing is ever changed or deleted |
| **How it is triggered** | Windows Task Scheduler, Mondays 10:00 |
| **What must not change** | File names (`Google Cloud <statement|invoice> YYYY-MM-DD [number].pdf`): people rely on them |

## Code

| | |
|---|---|
| `config.js` | The one CONFIG, and what a run can't do without |
| `src/plan.js` | Deciding: what's new, file names, dates, state updates, what the emails say |
| `src/billing.js` | The browser: open the page, detect sign-in, find and download PDFs. `SELECTORS` live here |
| `src/files.js` | Disk: state, saving into Drive safely, the log |
| `src/mail.js`, `src/secret.js` | Sending, and reading the app password from Credential Manager |
| `src/run.js` | One run, with everything passed in |
| `src/cli.js` | The commands above |
