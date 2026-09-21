# leave

Records out-of-office: the block on the person's **own** calendar, plus the invite that shows the
team. Replaces the Sheet dialog in `legacy/ooo-appsscript/`. Reading "who's out" is the separate,
read-only `ooo` module.

**This is the accounts team's module.** They book leave for everyone, which is why booking *for
another person* is the main path rather than the exception. People without the `admin` role can
only book their own.

DM only, and it works through Claude: you say what's happening, Buddy shows exactly what it is
about to create, and nothing happens until someone clicks **Approve**.

## Using it

| | |
|---|---|
| "Book Remy out 12–16 October" | A range on a colleague's calendar; one approval section per block |
| "Riley is off Friday morning" | Half day, using **her** shift's hours |
| "Remy is UK 9–5" / `shift: UK_9_5` | Sets a colleague's hours; remembered from then on |
| "Cancel Charlie's leave on the 3rd" | Removes the `(OOO)` events in that range |
| "I'm off next Thursday" | Your own leave, for anyone with access |
| `/leave` | Your shift and display name |
| `/leave shift UK_9_5` · `/leave name Lucho` | Your own hours and calendar name |
| `/leave check` | Proves Buddy can act on your calendar |

## Booking for colleagues

The name and hours come from **the person the leave is for**, never from whoever is booking — an
ARG booker must not stamp ARG hours on a London colleague's half-day. Each person's shift and
display name are remembered the first time they're given, so the accounts team types them once.

If a half-day is asked for and that person's hours aren't known yet, Buddy asks which shift they
work instead of guessing. Full days are unaffected: they run 00:00–23:59 whatever the shift.

The team invite can be skipped ("no team invite"), exactly as blanking the address did in the
Sheet dialog.

## The security model

This is the only module that acts **as** a person, so the fence matters more than the feature:

- **The calendar is always the Chat-verified sender's, unless the asker holds `admin`.** The subject comes from Google's signed
  request, never from the tool call — so Claude cannot be talked into booking on someone else's
  calendar, whatever a message says. Anyone else requires the `admin` role
  (`BUDDY_ROLE_LEAVE_ADMIN`), and the approval card names whose calendar it is either way.
- **No key exists.** `buddy-bot` asks Google's IAM Credentials API to sign each assertion,
  authenticating with the identity Cloud Run gives it. The Apps Script it replaces carried a
  private key in the source; there is nothing here to leak or rotate.
- **One scope:** `calendar.events`. It can create and delete events, and nothing else — not
  sharing, not settings, not other Google services.
- **Every write is approved**, and both booking and cancelling are logged with who asked, whose
  calendar it was and which dates.

## Settings

| Setting | Default | |
|---|---|---|
| `LEAVE_TEAM_EMAIL` | `wholeteam@example.com` | Required. Invited so the team sees the leave |
| `LEAVE_DEFAULT_SHIFT` | `ARG_8_5` | For full days and for people whose shift isn't known yet |

Shifts: `UK_9_5` (9:00–17:00 London), `ARG_6_3`, `ARG_7_4`, `ARG_8_5` (Buenos Aires). Half-days
use the shift's own time zone, so a UK morning is 09:00–13:00 London wherever Buddy runs.

## What it creates

Same two events as the Apps Script, for the same input:

- **On the person's calendar:** `<name> (OOO)`, `eventType: outOfOffice`, opaque, auto-declining
  new conflicting invitations. This is the part that only works on their own calendar.
- **For the team:** the same title, **transparent** so it blocks nobody, with the team address as
  an attendee. Full days are all-day events; Google's exclusive end date is handled.

Nothing is emailed to the company: both are created with `sendUpdates=none`.

## Bugs from the old script that are fixed here

- **Cancelling stops at the last day asked for.** The script searched two days past the end and
  could delete leave you never mentioned.
- **Booking the same leave twice does nothing the second time.**
- **A failed delete is reported**, instead of being logged and counted as success.
