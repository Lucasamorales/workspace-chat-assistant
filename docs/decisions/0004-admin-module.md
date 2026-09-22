# 0004 — `admin` module: granting module access from chat

Date: 2026-09-22 · Status: accepted (Robin) · Builds on: `0001-scope-and-security.md`

## Context

Access lives in `infra/config.env` and is read at startup, so letting a colleague use a module
means editing a file, committing and deploying. That is slow for something as ordinary as "give
Riley access to Asana", and it means access changes need someone who can deploy.

The obvious risk of moving it into chat is that Claude reads untrusted content all day — Asana
tasks, uploaded files, messages other people wrote. "Grant bob@ access to everything" appearing
inside a PDF must never become a grant.

## Decision

An `admin` module, usable only by people listed in `BUDDY_ACCESS_ADMIN`, that grants and revokes
**module access** from a DM. Access becomes the union of two sources:

| Source | Set by | Wins when |
|---|---|---|
| `infra/config.env` | editing the file, deploying | always in force; chat cannot remove it |
| Grants in Firestore | an admin, in chat, after approving a card | adds to config, never subtracts |

Config is the floor. A grant can only widen access, and revoking only removes grants Buddy made,
so nobody can lock the pilot out of its own modules from a chat message.

### Guardrails

1. **Admin is config-only.** `BUDDY_ACCESS_ADMIN` is never grantable — there is no path from chat
   to becoming an admin, or to giving anyone else that power.
2. **Protected modules are a constant in the source**, not a setting: `admin`, `leave`, `assistant`.
   Attempting to grant one is refused with a plain explanation. A test asserts each of them.
3. **Every change needs a click.** Grants and revocations go through the approval card, even for
   the admin who asked. This is what makes prompt injection a non-event: the worst a poisoned
   document achieves is a card the admin declines.
4. **Domain-locked:** only `@example.com` addresses, validated like config entries.
5. **DM only**, and invisible to everyone who is not an admin.
6. **Audited.** Every grant and revocation is stored with who did it, when, for whom, and any
   expiry, and is visible in `/access` as well as in Cloud Logging.

### Grants may expire

A grant can carry an optional end date ("until 30 November"), for freelancers and temporary cover.
Expiry is evaluated when access is checked, so a lapsed grant stops working on its own; expired
entries are shown in `/access` history until cleaned up. No expiry means until revoked.

### Talking to Buddy at all

`ALLOWED_USERS` gates Buddy entirely, so a module grant alone would leave someone still being told
Buddy is not switched on for them. Granting a module therefore also adds the person to a stored
allow-list, shown on the approval card. The Chat app's own visibility list in the Google console
stays manual until it goes company-wide at the merge.

### Revoking

Any admin can revoke any grant, whoever made it. The audit trail records both.

## Alternatives considered

- **A web page on `buddy-oauth`.** More familiar, but it needs its own authentication and becomes
  another public surface; chat already has Google's verified identity for every message.
- **Keeping config as the only source.** Safest, and what we have. Rejected because every access
  change needs a deploy, which pushes people towards over-granting "while we're in there".
- **Letting grants override config.** Rejected: an admin account that got compromised could lock
  everyone out, and the file would stop describing reality.

## Consequences

- The access policy gains a cache refreshed once per incoming event, so a change takes effect
  within seconds rather than at the next deploy. Checks stay synchronous.
- `infra/config.env` stops being the whole truth about access: `/access` is, and it shows both
  sources separately. The RUNBOOK says to read it there.
- Roles (`kudos.admin`, `leave.admin`) stay config-only for now. Adding them later is the same
  mechanism, but role grants deserve their own decision.
