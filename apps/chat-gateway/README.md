# apps/chat-gateway (`buddy-bot`)

The Google Chat endpoint. Chat posts every event here; this service verifies it came from
Chat, works out which module should handle it, and replies. It is deployed without public
access: only Google Chat's service account, and the scheduler's, may invoke it.

| File | What it is |
|---|---|
| `src/index.js` | Process entry point: builds the real clients (Firestore, KMS, Chat, Claude) and starts the server |
| `src/app.js` | The HTTP app: request verification and routing to the handler and to `/tasks` |
| `src/handler.js` | Handles one verified Chat event and returns the synchronous reply; slow work continues after it |
| `src/cards.js` | Every Chat card Buddy sends. Module text is escaped, never trusted as markup |
| `src/tasks.js` | Scheduled tasks, the only way Buddy speaks first |
| `src/voice.js` | The tone-of-voice guidance given to the model |

Tests are in `test/` and run with `npm test --workspace @buddy/chat-gateway`. They drive the
app with fake Chat events and stand-ins for Claude and Chat, so they need no credentials.
