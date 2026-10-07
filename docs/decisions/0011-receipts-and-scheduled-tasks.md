# 0011 — Receipt reminders, and letting Buddy speak first

Date: 2026-09-29 · Status: accepted (Robin) · Unverified live: see "Still to check"

> **Renamed the same day:** the module was built as `invoices` and renamed `receipts` (Robin). The
> old name is retired everywhere — command, settings, storage — and what was saved under it is
> copied across once by `infra/migrate-invoices-to-receipts.sh`. Below, "invoices" means Google's
> own documents and page; the module is `receipts`.

## Context

Google Cloud's billing documents have to be downloaded by hand from Billing → Invoices every
month. Robin wanted Buddy to take care of it, and to be able to add other receipts the same way.

Two things Buddy could not do: get the PDFs, and say anything without being asked — `buddy-bot`
only accepted calls from Google Chat.

## What we tried first, and why it was dropped

**There is no API.** The Cloud Billing API manages accounts, projects and prices; nothing in it
returns invoices or statements. the company's account is paid automatically, so it gets monthly
*statements*, which Google doesn't email either (only invoiced accounts can have invoices emailed).

**A script on a PC driving Chrome** (`tools/invoice-fetcher`, built and removed the same day). It
reused a Google session signed into its own Chrome profile and ticked the row, pressed "Download
selected", saved to Drive and emailed the PDF. It worked for about 25 minutes. After that, a
Chrome under remote control — whether Playwright launched it or it only attached to a normal
Chrome — was sent to the sign-in page, while the same profile opened normally was still signed
in. That is Google protecting the session against theft, and working around a security control
on the company account is not something to build on: it would also break with the next change.

**A Chrome extension in the everyday browser** would avoid that, but needs a local helper to save
files and send email, a site setting to allow pop-ups, and its clicks might still be ignored. Too
much to keep working for one PDF a month.

## Decision

### Buddy reminds; people download

The `receipts` module knows each receipt's download page and when it's usually ready ("5th working
day", "day 1"). On that day at 09:00 it DMs the receipt's list with a button to the page; someone
downloads it and presses **Downloaded**, which closes the month for everyone. Unanswered, it
reminds again every two working days, three times at most. Receipts are added in chat by a
receipts admin — by command or just by asking, behind an approval card — so a new one needs no
deploy.

It holds no login, fetches nothing, reads no files. Its only data is the receipts and who marked
each month done.

### Scheduled tasks: a second, narrow way in

New module hook **`onSchedule(ctx, task)`** returns `[{ to: [emails], reply }]` and sends nothing
itself. Cloud Scheduler calls `POST /tasks/daily` on `buddy-bot` at 09:00 Buenos Aires, Monday to
Friday, signed with an OIDC token as `buddy-scheduler@…`; the gateway runs every module's hook and
delivers the notes by DM.

- **Still private.** `buddy-scheduler` is given `run.invoker` on `buddy-bot` only. The app checks
  the token's audience *and* that it was issued to that exact account (`createCallerVerifier`) —
  Google Chat's own token is refused on `/tasks`, and the scheduler's is refused everywhere else.
- **Off unless configured.** With `BUDDY_SCHEDULER_EMAIL` empty, `/tasks` doesn't exist.
- **Two checks per recipient.** A note reaches someone only if they may talk to Buddy *and* may use
  the module that wrote it.
- **DMs only, and only ones Buddy remembers.** A Chat app can't open a DM, and Google won't let an
  app find one from an email address: `spaces.findDirectMessage` takes `users/<email>` only for a
  user sign-in. The first real run (2026-10-07) failed on exactly that: "Service account
  authentication doesn't support access to user information using email aliases". So Buddy keeps,
  from each DM a person sends it, their Chat id and that DM's space (`core__people`), and delivers
  there; if that space stops working it asks Chat for the current one by id, which an app may do.
  Someone Buddy has not heard from is skipped and counted, with the reason. No directory lookup
  and no new permission: resolving emails would need one, for a case "say hello once" already covers.
- **Contained.** Each hook runs with the registry's timeout and try/catch; one failing module (or
  one failing receipt) doesn't stop the rest.
- **Safe to run twice.** A reminder is recorded as sent when it's handed over, so a second run the
  same day sends nothing.

This reverses the reasoning in 0006 for the costs rollup ("opening it to a scheduler would mean a
new invoker"): the invoker now exists, narrowly. The rollup can move onto it later (BACKLOG).

## Still to check (live)

- ~~`spaces.findDirectMessage` with the app's own credentials~~: checked 2026-10-07, and it does
  not work by email (above). Fixed by remembering people; that fix is itself unverified live.
- The first reminder that actually arrives: Friday 9 October at the earliest, for people who have
  written to Buddy after the fix is deployed.

## Consequences

- Downloading stays a person's job: about ten seconds a month per receipt, prompted.
- `buddy-bot` has a second invoker. It is checked as tightly as Google Chat.
- The same reminders work for anything with a download page, not just Google Cloud.
