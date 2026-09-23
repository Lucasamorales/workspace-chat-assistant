# 0007 — Using a module by asking, without free-form Claude

Date: 2026-09-23 · Status: accepted (Robin) · Changes: `0001-scope-and-security.md`

## Context

`BUDDY_ACCESS_ASSISTANT` meant two things at once: *may use natural language* and *may chat with
Claude about anything*. Asana only works through Claude, so it was hidden from anyone without the
assistant — which meant giving someone Asana also gave them a general-purpose chatbot, a config
edit and a deploy (the `admin` module cannot grant `assistant`, by design).

That is the wrong trade. Asana is an ordinary work tool; free-form Claude is the expensive,
open-ended thing that should stay with the people meant to have it.

## Decision

Split the two meanings. A module may declare **`scopedConversation`**: it needs Claude, and it may
drive Claude **for itself alone**.

| Someone has | Claude does |
|---|---|
| `assistant` | anything — as now |
| a scoped module only (e.g. `asana`) | that module's tools, and declines everything else |
| neither | never runs; they get the "here's what I can help with" card |

For a scoped person, Claude is given only that module's tools — already true of how toolsets are
built — and told in the system prompt that it is there for that module alone, that anything else
should be declined in one line, and that this does not change whoever asks.

Today only `asana` declares it. `files` and `manual` deliberately do not: uploading a document or
asking about a policy is closer to free-form use, and widening those is a separate decision.

### Cost

A scoped person still costs money per request, so `MONTHLY_USD_CAP_SCOPED` (default $5) applies to
them instead of the full cap. `assistant` used to be the de facto spend control; the cap now is.

### Consequences

- **`asana` becomes grantable from chat**, with no config edit and no deploy, which was the
  friction that prompted this.
- **The restriction is a policy, not a wall.** A system prompt makes Claude decline off-topic
  requests; it is not a guarantee, and someone determined could talk around it. What is guaranteed
  is the tools: a scoped person's Claude has no manual, no leave, no files, and every write still
  needs an approval click. If a hard boundary is ever required, that means deterministic commands
  or a Chat dialog with no Claude in the loop at all.
- Anyone given a scoped module can reach Claude, so the module's access list is now a spending
  decision as well as a permission.

## Alternatives considered

- **Deterministic Asana commands or a dialog form**, with no Claude at all. A genuine hard
  boundary and no per-request cost, but it only ever does what we build forms for, and it needs
  Chat dialog plumbing Buddy does not have. Worth building later for repetitive work.
- **Making `assistant` grantable from chat.** Simplest, and wrong: it would hand out the expensive,
  unbounded capability through the same card as "let Riley see Kudos".
