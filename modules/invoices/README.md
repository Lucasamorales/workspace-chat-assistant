# invoices

Reminds people when a bill is ready to download, with a button to the page. Google Cloud first;
any bill with a download page can be added. **Robin only for now** (`BUDDY_ACCESS_INVOICES`);
admins can grant it from chat (`/access invoices` shows who).

Decision: `docs/decisions/0011-invoices-and-scheduled-tasks.md`.

Buddy never logs into anything, never downloads anything and never touches the files: it knows
when each bill is usually ready, says so, and stops once someone has it.

## How a month goes

1. On the day a bill is due (say the 5th working day), at 09:00, Buddy DMs everyone on that bill's
   list: *"🧾 Google Cloud: this month's bill should be ready"*, with **Open Google Cloud**,
   **Invoices folder** (if set), **✓ Downloaded** and **Remind me tomorrow**.
2. You open the page and download it yourself, then press **✓ Downloaded**. That closes the month
   for everyone on the list, and records who did it.
3. If nobody presses anything, Buddy reminds again two working days later, three times at most,
   then leaves it showing as pending in `/invoices`. **Remind me tomorrow** moves the next one to
   the next working day without using one up.
4. Next month starts over.

Working days are Monday to Friday in `INVOICES_TIMEZONE`. Public holidays aren't known, so a
holiday can make a reminder a day early.

## Commands

| | |
|---|---|
| `/invoices` | Every bill: when it's due this month, whether it's done and by whom, a link to each |
| `/invoices done <bill>` | Mark this month's as downloaded (what the button does); works before the reminder too |
| `/invoices later <bill>` | Remind again the next working day |
| `/invoices add Name \| https://link \| 5th working day \| who@…, who@…` | Admins: add a bill, or change one with the same name. "Who" defaults to you |
| `/invoices remove <bill>` | Admins: stop reminding about a bill |
| `/invoices preview <bill>` | Admins: see the reminder card, without it counting as sent |

"When it's ready" can be `5th working day`, `3rd business day`, `day 1` or `15th of each month`.
A day the month doesn't have means its last day.

To set up Google Cloud:

```
/invoices add Google Cloud | https://console.cloud.google.com/billing/XXXXXX-XXXXXX-XXXXXX/invoices?organizationId=000000000000 | 5th working day
```

## Who

- **Sees bills and presses the buttons:** `BUDDY_ACCESS_INVOICES`.
- **Adds, changes and removes bills:** `BUDDY_ROLE_INVOICES_ADMIN`.
- **Is reminded:** each bill's own list. Buddy delivers only to people on it who can use the
  module *and* talk to Buddy, so a bill's list can never reach past the access rule. Someone who
  has never opened a DM with Buddy is skipped (Chat apps can't start one).

## Settings

| | |
|---|---|
| `BUDDY_ACCESS_INVOICES` | Who can use it (required, like every module) |
| `BUDDY_ROLE_INVOICES_ADMIN` | Who can add and remove bills (required, like every role) |
| `INVOICES_FOLDER_ID` | Optional: the Drive folder bills are saved into, shown as a link. Buddy never reads it |
| `INVOICES_TIMEZONE` | Default `America/Argentina/Buenos_Aires` |

Reminders need the scheduler (`infra/scheduler.sh`, then `BUDDY_SCHEDULER_EMAIL`). Without it,
`/invoices` still works; nothing is sent.

## Stores

| | |
|---|---|
| `m_invoices__bills` | One per bill: name, link, when it's ready, who is reminded, who added it |
| `m_invoices__months` | One per bill per month: who pressed Downloaded and when, the days reminders went out |

Month records stay when a bill is removed: they're the record of who downloaded what.

## Code

| | |
|---|---|
| `src/schedule.js` | When a bill is due and whether to remind today: plain functions over dates |
| `src/bills.js` | Storage, and checking what an admin types |
| `src/present.js` | Everything the module says |
| `src/module.js` | The commands and the daily check (`onSchedule`) |
