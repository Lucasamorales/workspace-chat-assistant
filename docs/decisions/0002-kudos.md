# 0002 — Kudos module decisions

Date: 2026-09-17 · Decided by: Robin

| # | Question | Decision |
|---|---|---|
| 1 | Self-votes | **Blocked.** |
| 2 | 5 kudos given per month / 3 to the same person per month | **Enforced when voting** (it's policy), not just reported afterwards. Leadership voters are exempt, as in the original audit. |
| 3 | Where votes count | Only the space **"Team - Kudos"**. |
| 4 | Leadership (cannot win rewards; exempt from giving limits) | charlie@, remy@, riley@, toni@, remy.lee@ example.com |
| 5 | Nominee identity | **Chat user IDs** stored alongside names. No Google Workspace directory access. Leadership emails are linked to Chat IDs once, by an admin tagging them. |
| 6 | Time zone for month/quarter/year boundaries | **America/Argentina/Buenos_Aires** |
| 7 | Announcements | Posted by Buddy to the same space the old webhook used |
| 8 | Testing | Against a **copy** of the Kudos Sheet (`YOUR_KUDOS_SHEET_ID`), in a test space. The real Sheet is untouched until cutover. |
| — | Kudos admins | robin@ and remy@ hold the Kudos `admin` role (admin-only commands) during testing. |
| — | Audit approvals | **Unchanged for now:** they stay with accounts@ as today. Revisit when building audits (K7–K9). |

## Consequences
- Raw Data columns A–F keep their current meaning; new columns G–H hold voter and nominee Chat IDs.
- Rows logged before Buddy have names only; audits fall back to exact display-name matching for them.
- The Apps Script web app and webhook are retired at cutover; announcements need a click inside Chat.
