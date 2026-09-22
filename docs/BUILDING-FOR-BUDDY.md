# Building something that will become a Buddy module

For tools built outside this repo — usually Apps Script — that we later fold into Buddy as a
module. Following this turns a port from "rewrite it" into "move the logic across and wrap it".

Two parts: **rules to paste into your AI coding assistant**, and a **handover checklist**.

---

## Part 1 — rules to paste into your assistant

> **Rules for this project: it will become a module in our Google Chat assistant, Buddy.**
>
> **Secrets**
> 1. Never put a private key, token, password or client secret in the source, in a Sheet, or in
>    a config tab. If the script needs credentials, use the runtime's own identity, or stop and
>    ask a human where the secret should live.
> 2. Never hard-code a person's credentials or act as a specific person by holding their key.
>
> **Shape of the code**
> 3. Keep the logic in plain functions that take plain values and return plain values. No
>    `SpreadsheetApp`, `CalendarApp`, `GmailApp`, `HtmlService`, `SpreadsheetApp.getUi()` or
>    `PropertiesService` inside them.
> 4. Put every Google API call in a thin layer of its own (one file, or functions with an
>    obvious prefix), so it can be swapped for a different client later. That layer should do
>    no business logic: fetch, write, return.
> 5. No global mutable state. Pass what a function needs as arguments.
> 6. Put IDs, emails, time zones and limits in one `CONFIG` object at the top of the file. Do
>    not scatter them through the code, and do not read them from a Sheet.
> 7. Keep the user interface (menus, dialogs, HTML, message strings) out of the logic. Return
>    data — a list, an object, a count — and format it separately.
>
> **Writes**
> 8. Separate deciding from doing: one function works out exactly what will change and returns
>    a description of it; another applies it. Buddy shows the description on an approval card
>    before anything happens.
> 9. Make every write safe to run twice. Check whether the thing already exists before
>    creating it, and say "already done" rather than creating a duplicate.
> 10. Never delete or change more than was asked for. If the request is "the 12th to the 16th",
>     do not widen the window "to be safe".
> 11. Report partial failures honestly: "did 3 of 5" beats logging an error and returning
>     success.
>
> **Dates and people**
> 12. Dates as `YYYY-MM-DD` strings, times with an explicit time zone. Never rely on the
>     script's own time zone, and never assume the reader is in the same country.
> 13. Identify people by work email address. Not by display name, not by row number.
>
> **Errors**
> 14. Throw errors with a sentence a colleague could act on ("the Sheet isn't shared with X"),
>     not `catch (e) {}` and not a raw API dump.
>
> **Don't build**
> 15. No approval buttons, no permission checks, no retry logic, no "who is allowed to use
>     this" list, no chat formatting, and no personality in the wording. Buddy provides all of
>     that, and duplicated versions have to be removed during the port.

---

## Part 2 — what to hand over

A short note alongside the code, answering:

| | |
|---|---|
| **What it does** | Two or three sentences, in plain words |
| **Who should use it** | Everyone, a team, or named people — and who may do the destructive parts |
| **What it touches** | Which Sheets, Calendars, Docs or APIs, with links or IDs |
| **Whose permissions** | Does it act as the person using it, or as a robot account? |
| **What it writes** | Exactly what gets created, changed or deleted |
| **How it is triggered today** | Menu, button, time trigger, form, chat message |
| **What must not change** | Column order, event titles, anything people or other scripts depend on |
| **Real examples** | Two or three genuine inputs and their expected results, for tests |

---

## How it becomes a module

For context, this is what happens on our side — knowing it explains the rules above.

A Buddy module is a folder with one exported object. The parts your logic maps onto:

| Buddy | What we put there |
|---|---|
| `commands` | Slash commands, e.g. `/kudos`, `/ooo` — your "read" functions |
| `handleMessage` | Reacting to a message without Claude, e.g. a kudos vote |
| `tools` → `describe` | Your "what will change" function — becomes the approval card |
| `tools` → `execute` | Your "apply it" function, run only after the person clicks Approve |
| `settings` | Your `CONFIG` object, moved to `infra/config.env` as `<MODULE>_*` |
| the Google API layer | Rewritten against the REST API as `buddy-bot`, which is why it must be separate |

Rules the module itself must follow are in the README ("Adding a module"): never import another
module, own dependencies, own storage prefix, own tests.

## Two real examples

**Kudos** ported easily. Vote parsing was string logic with no Google calls in it, so it moved
across nearly unchanged and got tests the same day. What we had to redo: the Sheet access, and a
value-matching rule that lived in a regular expression nobody could read.

**Leave automation** was harder, and every hour of it maps to a rule above:

- a service account private key sat in the script, giving anyone who could open the Sheet the
  ability to act as any person in the company (rules 1–2)
- the date logic was inside the dialog's submit handler, so it could not be tested (rules 3, 7)
- cancelling searched two days past the range and deleted leave nobody asked about (rule 10)
- submitting twice created duplicate events (rule 9)
- a failed delete was logged and still reported as success (rule 11)

None of those were hard to fix once found. Finding them cost far more than writing them would
have, and every one of them is a rule in Part 1.
