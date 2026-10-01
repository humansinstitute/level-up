# Level Up agent contract

Before planning or implementation, read `docs/gamemodel.md`, `docs/datamodel.md`, `docs/architecture_decisions.md`, and `docs/design.md`. Treat `docs/design.md` as authoritative for every user-facing layout, component, colour, typography, animation, and responsive change. Inspect the repository Git root and full worktree state before editing. Work on `main` unless Pete requests another branch, preserve concurrent work, and use Conventional Commits.

Do not modify `<games-library-repository>`; copy or adapt templates into this repository. Do not add Level Up business rules to Tower. Never expose credentials or restart, deploy, or reconfigure Tower, Autopilot, Flight Deck, or a managed WApp without Pete's explicit approval in the current conversation.

## Mandatory managed-app activation

When Pete requests a Level Up change intended for the running app, that request authorizes the coordinated Level Up-only activation unless he explicitly says not to activate it. After the code is reviewed, validated, and committed, always build the production bundle and restart the registered Level Up app through Autopilot's managed app runner. Then verify `/api/health`, verify the served HTML references the new assets, inspect the post-restart Level Up error log, and smoke-test the changed live behavior when authentication and tooling allow it.

Do not describe such work as complete, ready for Pete, or live before that build, restart, and smoke evidence exist. A worker may hand implementation back to its supervising manager without lifecycle authority, but the manager must complete activation before posting the user-facing completion. Never leave Pete testing stale code.

## Wingman app interaction rule

Level Up is commonly run inside the Wingman WM app/webview. Do not use browser
modal controls such as `window.confirm`, `window.alert`, or `window.prompt` for
product workflows. They may be suppressed or appear disconnected from the app
surface. Use Level Up-native React confirmation/dialog components for
destructive, permission, authentication, or other important decisions, with
visible Cancel/Confirm actions and status copy inside the application UI.

## Managed app logging

When Level Up is running as an Autopilot-managed WApp, runtime logs are written
under Autopilot's managed app logs directory, for example:

```bash
tail -f <autopilot-repository>/data/admin/apps/logs/<level-up-app>-out.log
tail -f <autopilot-repository>/data/admin/apps/logs/<level-up-app>-error.log
```

Use these logs for live playtest debugging. Keep application activity logs
structured and secret-safe: log event names, IDs, paths, status codes, phases,
sequences, and timings, but never request bodies, cookies, signed events, invite
secrets, private keys, API keys, callback tokens, or ACP/runtime env payloads.

## Agent runtime defaults

Goose ACP is the standard Level Up runtime path for brainstorm suggestions,
proposal generation, and feedback synthesis. Do not add or require separate
`LEVELUP_*_AGENT_ENABLED` feature flags. When `OPENROUTER_API_KEY`,
`LEVELUP_AGENT_MODEL`, and a valid `LEVELUP_GOOSE_BIN` are present, the managed
app should use the agent automatically. Missing key, model, or binary should be
reported as the concrete setup problem.

## Runtime compatibility and release safety

TypeScript types do not validate HTTP, WebSocket, IndexedDB, or persisted data at runtime. Treat every external or durable payload as `unknown` at the boundary and normalize or reject it before placing it in React state or calling array/string methods. Additive response fields must have safe defaults during rolling changes, and invalid required identity fields must produce a recoverable update message rather than a render crash.

When a client/server contract changes:

- update shared types, server serialization, client normalization, and HTTP/WebSocket recovery together;
- add a compatibility fixture for the immediately previous payload shape as well as a current-shape test;
- exercise the affected screen or workflow through its user-visible boundary, not only the repository method;
- keep aggregate/private fields scoped to the authenticated viewer in snapshots and realtime broadcasts;
- distinguish the first relevant application exception from unrelated browser-extension, relay, favicon, analytics, or CSP noise.

The running Bun server serves `dist/` directly. Never use `bun run build` merely to validate a change while the managed Level Up process is running: that can publish a new browser bundle against an old server and create version skew. Use `bun run check`, which writes its verification bundle to `.validation-dist/`. Only write production `dist/` as part of an explicitly approved activation, immediately followed by the coordinated Level Up-only restart and smoke test.

Before committing, run:

```bash
bun run check
git diff --check
```

For a client/server or persistence change, the smoke test must cover a fresh page load, the changed action, WebSocket reconnect/replay when applicable, and a previous-shape or pre-migration record. After an approved activation, verify `/api/health`, confirm the HTML references the intended asset build, and complete the affected flow in the live app before reporting success. If activation is not approved, report the pending restart and do not claim the live app is updated.

## Public source publication

Before publishing, follow `docs/publication.md`. Operational handoffs, screenshots,
runtime data, secrets, and private device records must remain untracked and ignored.
The public GitHub history is separate from the preserved local development history.
Never push the private development `main`, all branches, tags, or a mirror to GitHub.
