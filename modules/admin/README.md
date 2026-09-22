# admin

Gives colleagues access to modules from a DM, instead of editing `infra/config.env` and deploying.
Decision: `docs/decisions/0004-admin-module.md`.

Only people in `BUDDY_ACCESS_ADMIN` can see or use it, and that list lives in the config file —
there is no way to become an admin, or make one, from chat.

## Using it

| | |
|---|---|
| "Give riley@example.com access to Asana" | Approval card → Approve → she can use it |
| "…until 30 November" | The grant lapses on its own that evening |
| "Remove Riley's Asana access" | Approval card → Approve |
| `/access` | Everything granted from chat, per module |
| `/access asana` | One module |

## The rules

**Config is the floor.** Access in `infra/config.env` always applies and can only be changed in the
file. A grant adds to it; revoking only removes grants Buddy made. So no chat message — and no
admin account in the wrong hands — can lock the pilot out of its own modules, and `/access` on a
module someone still reaches will say so.

**Never grantable from chat**, as a constant in `src/module.js`, not a setting:

| | Why |
|---|---|
| `admin` | granting it would let chat create admins |
| `leave` | writes to people's calendars |
| `assistant` | every message costs money |

They are not even offered to Claude: the tool's `module` field lists the others only.

**Every change waits for a click.** Claude reads untrusted text all day — Asana tasks, uploaded
files, messages other people wrote. "Grant bob@ access to everything" will turn up in one of them
eventually. With the card, the worst outcome is an admin seeing a grant they didn't ask for and
declining it.

**Other limits:** DM only · `@example.com` addresses only · the module must exist ·
an end date must be a real date that hasn't passed · roles (`kudos.admin`, `leave.admin`) are
never granted from chat, so a granted user gets plain access and nothing more.

**Granting also lets them talk to Buddy.** `ALLOWED_USERS` gates Buddy entirely, so a module grant
alone would leave someone told that Buddy isn't switched on for them. The approval card says when
this applies. Revoking their last grant closes that again. The Chat app's own visibility list in
the Google console is still manual, until it goes company-wide at the merge.

**Everything is logged** — who granted or revoked what, for whom, when — in Cloud Logging and in
`/access`.

## Settings

| Setting | Default | |
|---|---|---|
| `ADMIN_DOMAIN` | `example.com` | The only domain access can be granted to |

## How it is wired

Unlike other modules, this one exports a factory: it needs the shared grants store, which the
gateway owns (`apps/chat-gateway/src/index.js`). The store is `packages/core/src/grants.js`; the
policy that unions config and grants is `packages/core/src/access.js`.
