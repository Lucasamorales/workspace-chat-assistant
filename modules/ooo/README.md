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

`buddy-bot@your-gcp-project.iam.gserviceaccount.com` needs read access to that calendar — as a
member of the group, or with the calendar shared "See all event details". Until then `/ooo` says
exactly that instead of failing obscurely. Buddy asks Google only for
`calendar.readonly`, so it cannot write even if the sharing were wider.

## Behaviour worth knowing

- **All-day end dates.** Google stores them exclusively, so 22nd–25th inclusive is kept as "end
  26th". The list shows the real last day.
- **De-duplication.** A leave usually appears twice, as the person's own block and as the invite
  to the team address. Same name and same dates is listed once.
- **Local days.** "Today" is the day the team is living in, not UTC's: at 23:30 in Buenos Aires
  it is still today, though UTC is already tomorrow.
- **Only `(OOO)` events are listed**, so anything else on the calendar is ignored.
