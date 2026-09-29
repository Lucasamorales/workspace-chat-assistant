# 0011 — Invoices, and letting Buddy speak first

Date: 2026-09-29 · Status: accepted (Robin) · Unverified live: see "Still to check"

## Context

Google Cloud's invoice PDFs have to be downloaded by hand from Billing → Invoices every month.
There is no API for them: the Billing API returns costs, never the invoice documents. Robin wanted
them fetched automatically, emailed, and visible in Buddy with a command and a message when a new
one arrives. Robin only for now, with room to add others.

Two things Buddy could not do: reach anything that needs a person's Google login, and say
anything without being asked — `buddy-bot` only accepted calls from Google Chat.

## Decision

### The fetcher lives on a PC, not in Cloud Run

`tools/invoice-fetcher` runs weekly on a PC (Windows Task Scheduler, Mondays 10:00, catching up if
the PC was off). It reuses a Google session held in its own Chrome profile, which a person signs
into by hand. It saves new PDFs into a Drive folder through Drive for desktop, emails them, and
emails an alert with a screenshot when it can't.

Why not in Cloud Run: it would mean storing a person's Google session (or password) in the cloud
and automating sign-in. Google blocks that, it breaks the "never act as a specific person by
holding their key" rule, and a stolen session there would open the whole billing account. On the
PC the session sits where it already sits for that person, and the script never sees a password.

Rules it keeps (`docs/BUILDING-FOR-BUDDY.md`): one CONFIG; deciding (`plan.js`) apart from doing;
Google calls in one layer (`billing.js`); state written after every step so a run is safe to
repeat; partial failures reported as "fetched 1 of 2"; dates as `YYYY-MM-DD`; people by work email;
no password typed, no challenge answered, no link followed off Google, nothing deleted.

### Buddy reads the folder

The `invoices` module lists the folder's PDFs (`/invoices`) with `drive.readonly`, through a
keyless token for `buddy-bot` — the same way the manual reads its folder. It never touches
billing. The folder is shared as Viewer with `buddy-bot`, nothing more.

### Scheduled tasks: a second, narrow way in

New module hook **`onSchedule(ctx, task)`** returns `[{ to: [emails], reply }]` and sends nothing
itself. Cloud Scheduler calls `POST /tasks/daily` on `buddy-bot` once a day, signed with an OIDC
token as `buddy-scheduler@…`; the gateway runs every module's hook and delivers the notes by DM.

- **Still private.** `buddy-scheduler` is given `run.invoker` on `buddy-bot` only. The app checks
  the token's audience *and* that it was issued to that exact account (`createCallerVerifier`) —
  Google Chat's own token is refused on `/tasks`, and the scheduler's is refused everywhere else.
- **Off unless configured.** With `BUDDY_SCHEDULER_EMAIL` empty, `/tasks` doesn't exist.
- **Two checks per recipient.** A note reaches someone only if they may talk to Buddy *and* may use
  the module that wrote it. A module's notify list can never show anything to someone it couldn't
  show it to in a DM.
- **DMs only, and only existing ones.** A Chat app can't open a DM; people who have never messaged
  Buddy are skipped and counted.
- **Contained.** Each hook runs with the registry's timeout and try/catch; one failing module
  doesn't stop the rest.
- Task names are `[a-z][a-z0-9-]*`; only `daily` is scheduled today.

This reverses the reasoning in 0006 for the costs rollup ("opening it to a scheduler would mean a
new invoker"): the invoker now exists, narrowly. The rollup can move onto it later (BACKLOG).

### Who

`BUDDY_ACCESS_INVOICES=robin@` and `INVOICES_NOTIFY=robin@`. Adding someone is the usual access
rule (or an admin grant from chat) plus the notify list; emailing them the PDFs is the fetcher's
`mail.to`.

## Alternatives considered

- **Billing export to BigQuery**: costs, not invoices. Doesn't give the PDF.
- **Buddy holds a Google session**: rejected, see above.
- **The fetcher messages Chat itself** (a webhook): a second bot identity, a secret on the PC, and
  no access check. Reading a folder keeps one way in and one set of rules.
- **Riding an ordinary message, like the costs rollup**: an invoice announcement can't wait for
  someone to happen to write.

## Still to check (live)

- `spaces.findDirectMessage` with the app's own credentials, from a scheduled call.
- The billing page's real layout against `SELECTORS` (`npm run inspect`).
- Gmail app passwords allowed on the Workspace; if not, the fetcher needs another sender.

## Consequences

- One more thing to keep alive on a PC: if it is off for weeks, invoices arrive late — they are
  still in the billing console, and the next run catches up.
- The Google session in the Chrome profile is as sensitive as a password; it lives only in that
  Windows user's `%LOCALAPPDATA%`.
- `buddy-bot` has a second invoker. It is checked as tightly as Google Chat.
