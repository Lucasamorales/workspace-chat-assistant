# Module: kudos

Peer recognition by company value, logged to the Kudos Google Sheet. Replaces the voting part
of the Apps Script "Buddy" (`kudos.gs`). Audits and announcements come next (backlog K7–K9).

## Voting
In a Kudos space: `@Buddy kudos to @Eve for thinking big and @Leo for owning it`

- Values: **Own it**, **Think big**, **Go beyond**, **Be curious** (whole phrases, common verb forms).
  A value written after a name applies to that person; otherwise a value anywhere applies to all.
- Handled directly, without Claude. Messages that tag people without a value or the word "kudos"
  go to Claude as normal.
- Only in spaces listed in `KUDOS_SPACES`; DMs get the original "Nice try!" reply.
- Policy (decision 0002): no self-votes; max **5** given per month and **3** to the same person
  per month, except for leadership voters. Months use `KUDOS_TIMEZONE`.

## Sheet (`Raw Data` tab)
| A | B | C | D | E | F | G | H |
|---|---|---|---|---|---|---|---|
| Date | Voter | Value | Nominee | Space | Raw text | Voter Chat id | Nominee Chat id |

A–F are unchanged from Apps Script. G–H are new; older rows have them empty and are matched by
name. Buddy only appends rows. The Sheet must be shared as **Editor** with
`buddy-bot@your-gcp-project.iam.gserviceaccount.com`.

## Commands
| Command | Who | What |
|---|---|---|
| `/kudos` | everyone with access | Received and given this month |
| `/kudos check` | admin | This space's id, whether votes count here, Sheet access and headers |
| `/kudos leadership @A @B …` | admin | Set who can't win rewards (stored by Chat id) |

## Settings
| Setting | Required | Default |
|---|---|---|
| `KUDOS_SHEET_ID` | yes | — |
| `KUDOS_SPACES` | for voting | none (no space accepts votes) |
| `KUDOS_LEADERSHIP` | | — (emails; exempt from giving limits) |
| `KUDOS_TIMEZONE` | | `America/Argentina/Buenos_Aires` |
| `KUDOS_RAW_TAB` | | `Raw Data` |
| `KUDOS_MAX_PER_MONTH` / `KUDOS_MAX_PER_PERSON` | | 5 / 3 |

Access: `BUDDY_ACCESS_KUDOS`; admins: `BUDDY_ROLE_KUDOS_ADMIN`.

Tests: `npm test --workspace @buddy/module-kudos`
