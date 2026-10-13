# apps/oauth-gateway (`buddy-oauth`)

The only public service. It serves the "connect your account" pages: two routes per OAuth
module (start and callback) and the static avatar images, and nothing else.

It never accepts a user id from the browser. Identity comes from a signed, single-use session
that was created inside Chat, where Google has already verified who is asking
(`packages/core/src/oauth-flows.js`).

| File | What it is |
|---|---|
| `src/index.js` | Process entry point |
| `src/app.js` | The Express app: the OAuth routes, security headers and static assets |
| `public/` | The avatar images shown in Chat cards |

Tests are in `test/` and run with `npm test --workspace @buddy/oauth-gateway`.
