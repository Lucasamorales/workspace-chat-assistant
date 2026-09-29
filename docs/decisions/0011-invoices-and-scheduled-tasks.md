# 0011 — Invoice reminders, and letting Buddy speak first

Date: 2026-09-29 · Status: accepted (Robin) · Unverified live: see "Still to check"

## Context

Google Cloud's billing documents have to be downloaded by hand from Billing → Invoices every
month. Robin wanted Buddy to take care of it, and to be able to add other bills the same way.

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

The `invoices` module knows each bill's download page and when it's usually ready ("5th working
day", "day 1"). On that day at 09:00 it DMs the bill's list with a button to the page; someone
downloads it and presses **Downloaded**, which closes the month for everyone. Unanswered, it
reminds again every two working days, three times at most. Bills are added in chat by an invoices
admin, so a new one needs no deploy.

It holds no login, fetches nothing, reads no files. Its only data is the bills and who marked each
month done.

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
- **DMs only, and only existing ones.** A Chat app can't open a DM; people who have never messaged
  Buddy are skipped and counted.
- **Contained.** Each hook runs with the registry's timeout and try/catch; one failing module (or
  one failing bill) doesn't stop the rest.
- **Safe to run twice.** A reminder is recorded as sent when it's handed over, so a second run the
  same day sends nothing.

This reverses the reasoning in 0006 for the costs rollup ("opening it to a scheduler would mean a
new invoker"): the invoker now exists, narrowly. The rollup can move onto it later (BACKLOG).

## Still to check (live)

- `spaces.findDirectMessage` with the app's own credentials, from a scheduled call.
- The first real reminder, on the 5th working day of the month after it is switched on.

## Consequences

- Downloading stays a person's job: about ten seconds a month per bill, prompted.
- `buddy-bot` has a second invoker. It is checked as tightly as Google Chat.
- The same reminders work for any bill with a download page, not just Google Cloud.
