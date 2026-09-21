# OOO Apps Script (reference)

Remy's leave automation, kept here as the behaviour Buddy's `ooo` module must match. **Nothing
here runs.** The live copies are:

| Part | Where it lives | What it does |
|---|---|---|
| `ManualOOO.gs` + `create.html` + `cancel.html` | Apps Script bound to the *Leave automation* Sheet (`YOUR_LEAVE_SHEET_ID`) | Sheet menu → dialog → creates or cancels OOO events |
| `announcer.gs` | Apps Script Chat app | Answers "who's out today / tomorrow / this week" from the `wholeteam@` calendar |

The two HTML dialogs are not copied: they are the input form only (employee email, nickname, team
invite address, shift, up to four date rows of full / AM / PM), and Buddy replaces them with Chat
cards. The shift table and the event payloads in `ManualOOO.gs` are what matters.

## The key

`ManualOOO.gs` inlined a private key for `leave-bot@your-leave-project`, redacted here. It has
domain-wide delegation with the full `calendar` scope and calls `setSubject(userEmail)`, so anyone
who could open the Sheet's script could impersonate any person in the domain and read or write
their calendar. **Rotate it**, and delete it once Buddy takes over. Buddy never holds a key:
`buddy-bot` signs its own impersonation tokens through the IAM Credentials API.

## Behaviour to keep

- Personal event: `summary` = `<nickname> (OOO)`, `eventType: outOfOffice`, opaque, auto-declines
  new conflicting invitations with a message.
- Team event: same title, **transparent** (does not block the team calendar), team address as an
  attendee, `sendUpdates=none`. All-day for full days (end date exclusive, so +1 day), timed for
  half-days.
- Half-days come from the shift table: AM is `start`→`mid`, PM is `mid`→`end`, in the shift's own
  time zone (UK 9–17, ARG 6–15 / 7–16 / 8–17).
- Cancelling searches the employee's primary calendar for `OOO` in the range and deletes events
  whose title contains `(OOO)`.
- "Who's out" lists `(OOO)` events from the team calendar, all-day ones as `MMM d` (or a range)
  and half-days with ARG times.

## Bugs not to carry over

- **Cancel over-reaches:** `timeMax` is the end date **+2 days**, so an OOO starting the day after
  the range can be deleted.
- **The cancel dialog's `shift` field is ignored** — collected, sent, never used.
- **No de-duplication:** submitting the same leave twice creates duplicate events.
- **Silent partial failures:** a failed delete is logged but still reports success for the rest.
