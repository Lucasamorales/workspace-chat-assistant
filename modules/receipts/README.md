# receipts

Reminds people when a receipt is ready to download, with a button to the page. Google Cloud first;
any receipt with a download page can be added. Robin and accounts@ for now
(`BUDDY_ACCESS_RECEIPTS`); admins can grant it from chat (`/access receipts` shows who).

Decision: `docs/decisions/0011-receipts-and-scheduled-tasks.md`.

**Called `invoices` until 2026-09-29.** That name is retired: `/invoices`, `BUDDY_ACCESS_INVOICES`,
`INVOICES_*` and the word "invoices" no longer do anything. What was saved under it is copied
across once by `infra/migrate-invoices-to-receipts.sh`.

Buddy never logs into anything, never downloads anything and never touches the files: it knows
when each receipt is usually ready, says so, and stops once someone has it.

## How a month goes

1. On the day a receipt is due (say the 5th working day), at 09:00, Buddy DMs everyone on that receipt's
   list: *"🧾 Google Cloud: this month's receipt should be ready"*, with **Open Google Cloud**,
   **Receipts folder** (if set), **✓ Downloaded** and **Remind me tomorrow**.
2. You open the page and download it yourself, then press **✓ Downloaded**. That closes the month
   for everyone on the list, and records who did it.
3. If nobody presses anything, Buddy reminds again two working days later, three times at most,
   then leaves it showing as pending in `/receipts`. **Remind me tomorrow** moves the next one to
   the next working day without using one up.
4. Next month starts over.

Working days are Monday to Friday in `RECEIPTS_TIMEZONE`. Public holidays aren't known, so a
holiday can make a reminder a day early.

## Without commands

Made for someone in accounts, who shouldn't need to learn any syntax:

- **To see the receipts,** type **receipts** (or **recibos**) in a DM, or press **Receipts** on Buddy's
  welcome card. That's free: no Claude. The card has each receipt's **Open** button, **✓ Downloaded**
  for anything due, and, for admins, **+ Add a receipt**.
- **To add, change or stop a receipt, just say so:** *"Add Adobe, it's ready on the 1st, here's the
  page: https://account.adobe.com/billing"*, *"Figma is ready on the 3rd working day now"*, *"stop
  reminding me about Figma"*. Buddy shows an approval card with what it understood — the link, the
  rule and the next real date (*"1st of the month · next: 1 Oct"*), and on a change what it was
  before — and saves nothing until **Approve**. **+ Add a receipt** explains what to say.
- **Questions** like *"what's still to download this month?"* are answered from the list.

Buddy understands "Nth working day" and "day N" of the month. Anything else ("the first Monday",
"around the 5th") it turns into the closest of those and says so on the card. A request missing
something (no link, say) gets a question back instead of a card.

Adding, changing and stopping receipts are offered only to receipts admins, and refused again when
they run. Talking to it costs a small Claude call on Sonnet (`MODULE_TUNING`
`receipts:claude-sonnet-5:low`) for people who only have scoped modules; people with the
assistant run on the default model. Sonnet rather than Haiku because the people using it phrase
things loosely ("the Adobe one moved to around the 3rd") and it is used a few times a month, so the
price difference is cents.

## Commands

Everything above can also be typed:

| | |
|---|---|
| `/receipts` | Every receipt: when it's due this month, whether it's done and by whom, a link to each |
| `/receipts done <receipt>` | Mark this month's as downloaded (what the button does); works before the reminder too |
| `/receipts later <receipt>` | Remind again the next working day |
| `/receipts add Name \| https://link \| 5th working day \| who@…, who@…` | Admins: add a receipt, or change one with the same name. "Who" defaults to you |
| `/receipts remove <receipt>` | Admins: stop reminding about a receipt |
| `/receipts preview <receipt>` | Admins: see the reminder card, without it counting as sent |

"When it's ready" can be `5th working day`, `3rd business day`, `day 1` or `15th of each month`.
A day the month doesn't have means its last day.

To set up Google Cloud:

```
/receipts add Google Cloud | https://console.cloud.google.com/billing/XXXXXX-XXXXXX-XXXXXX/invoices?organizationId=000000000000 | 5th working day
```

## Who

- **Sees receipts and presses the buttons:** `BUDDY_ACCESS_RECEIPTS`.
- **Adds, changes and removes receipts:** `BUDDY_ROLE_RECEIPTS_ADMIN`.
- **Is reminded:** each receipt's own list. Buddy delivers only to people on it who can use the
  module *and* talk to Buddy, so a receipt's list can never reach past the access rule.
- **Must have written to Buddy once, in a DM.** Buddy delivers a reminder to the DM it remembers
  from the person's own messages: an app can't start a chat, and Google won't let it find one from
  an email address. Someone it has not heard from is skipped, and the log says why
  (`scheduled message not sent … has not messaged Buddy yet`). Any one message fixes it for good.

## Settings

| | |
|---|---|
| `BUDDY_ACCESS_RECEIPTS` | Who can use it (required, like every module) |
| `BUDDY_ROLE_RECEIPTS_ADMIN` | Who can add and remove receipts (required, like every role) |
| `RECEIPTS_FOLDER_ID` | Optional: the Drive folder receipts are saved into, shown as a link. Buddy never reads it |
| `RECEIPTS_TIMEZONE` | Default `America/Argentina/Buenos_Aires` |

Reminders need the scheduler (`infra/scheduler.sh`, then `BUDDY_SCHEDULER_EMAIL`). Without it,
`/receipts` still works; nothing is sent.

## Stores

| | |
|---|---|
| `m_receipts__receipts` | One per receipt: name, link, when it's ready, who is reminded, who added it |
| `m_receipts__months` | One per receipt per month: who pressed Downloaded and when, the days reminders went out |

Month records stay when a receipt is removed: they're the record of who downloaded what.

## Code

| | |
|---|---|
| `src/schedule.js` | When a receipt is due and whether to remind today: plain functions over dates |
| `src/receipts.js` | Storage, and checking what an admin types |
| `src/present.js` | Everything the module says |
| `src/tools.js` | What Claude can do when asked in words, and what each approval card shows |
| `src/module.js` | The commands, the "receipts" shortcut and the daily check (`onSchedule`) |
