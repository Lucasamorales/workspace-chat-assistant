# ooo

Answers "who's out of the office". **Read-only**: it opens one calendar and lists the `(OOO)`
events it finds. Booking and cancelling leave is the separate `leave` module, which is the only
code allowed to write to anyone's calendar.

Replaces the announcer half of Remy's Apps Script (`legacy/ooo-appsscript/announcer.gs`).

## Using it

| | |
|---|---|
| `/ooo` | Who's out today |
| `/ooo tomorrow` / `week` / `next week` / `month` / `next month` | Other periods |
| `/ooo check` | Proves Buddy can reach the calendar — run this first after setup |
| "Who's off next week?" | The `who_is_out` tool, for people who can also chat with Claude |

Help and welcome cards get **Out today** and **Out this week** buttons.

## Access

Everyone at example.com (`BUDDY_ACCESS_OOO`). There are no roles: the module cannot
change anything, so there is nothing to restrict beyond reading the calendar.

## Settings

| Setting | Default | |
|---|---|---|
| `OOO_CALENDAR_ID` | `accounts@example.com` | Required. The calendar holding the leave |
| `OOO_TIMEZONE` | `America/Argentina/Buenos_Aires` | Which day "today" means, and how half-day hours are shown |
| `OOO_TIMEZONE_LABEL` | `ARG` | Suffix on half-day times |
| `OOO_READ_AS` | *(unset)* | Read the calendar by acting as this one account (see below) |

## How it reads, and why

Workspace only lets an outside address (our service account) see **free/busy** on a calendar, which
has no names — useless for "who's out". So `ooo` reads the calendar by acting as the one account in
`OOO_READ_AS`, using the delegation `buddy-bot` already holds for `leave`. That is a workaround,
recorded as an amendment in `docs/decisions/0003-ooo.md`, and it is fenced:

- **The account comes from settings only**, validated as one ordinary address. Nothing a user, a
  message or Claude says can change it — the `who_is_out` tool takes a period and nothing else.
- **The read-only scope is asked for first.** The writable one is used only while the delegation
  lacks `calendar.events.readonly`, and every fallback is logged with the fix.
- **There is no write path.** The reader is a frozen object with `list` and `describe`; no create,
  delete or patch exists. Requests are built inside the module: always GET, always the configured
  calendar, never a caller-supplied method, body or URL.
- **Every read is logged** with the account acted as.

Unset `OOO_READ_AS` the day the calendar can be shared with `buddy-bot` directly — the module then
uses its own access and holds no delegation at all.

## Behaviour worth knowing

- **All-day end dates.** Google stores them exclusively, so 22nd–25th inclusive is kept as "end
  26th". The list shows the real last day.
- **De-duplication.** A leave usually appears twice, as the person's own block and as the invite
  to the team address. Same name and same dates is listed once.
- **Local days.** "Today" is the day the team is living in, not UTC's: at 23:30 in Buenos Aires
  it is still today, though UTC is already tomorrow.
- **Only events tagged OOO are listed** — "Ian OOO", "Ella (OOO)" and "OOO - Lenny" all count,
  "Woooo party" does not. The tag and any separator are stripped from the name shown.
