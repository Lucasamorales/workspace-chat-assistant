# leave

Books and cancels out-of-office on a person's **own** calendar, and invites the team so everyone
can see it. Replaces the Sheet dialog in `legacy/ooo-appsscript/`. Reading "who's out" is the
separate, read-only `ooo` module.

DM only, and it works through Claude: you say "I'm off next Thursday", Buddy shows you exactly
what it is about to create, and nothing happens until you click **Approve**.

## Using it

| | |
|---|---|
| "I'm off next Thursday" | One full day |
| "Book me out 12–16 October" | A range; one approval section per block |
| "Off Friday afternoon" | Half day, using your shift's hours |
| "Cancel my leave on the 3rd" | Removes the `(OOO)` events in that range |
| `/leave` | Your shift and display name |
| `/leave shift UK_9_5` | Set your working hours |
| `/leave name Lucho` | What the calendar shows |
| `/leave check` | Proves Buddy can act on your calendar |

## The security model

This is the only module that acts **as** a person, so the fence matters more than the feature:

- **The calendar is always the Chat-verified sender's.** The subject comes from Google's signed
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
| `LEAVE_DEFAULT_SHIFT` | `ARG_8_5` | Until someone sets their own with `/leave shift` |

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
