# Level Up — Architecture Decisions

This document records decisions that materially shape the first implementation. Dates use the decision date rather than the eventual release date.

## ADR-001: TypeScript as the application language

- **Status:** Accepted
- **Date:** 2026-09-03

### Decision

Build the Level Up Vite/React client, API, realtime gateway, and agent-control worker in TypeScript. Run Goose as a separate process or service and communicate with it through stable ACP v1 rather than embedding or modifying Goose's Rust internals.

Use the official `@agentclientprotocol/sdk` package for the ACP client. OpenRouter remains the initial model provider behind Goose.

### Rationale

- Shared types can cover browser views, API contracts, realtime events, persisted records, and agent-run messages.
- TypeScript has an official ACP SDK with client, subprocess, HTTP, and WebSocket support.
- The product is primarily a web application; TypeScript minimizes language and tooling boundaries.
- Goose already supplies the native agent runtime, so rewriting that boundary in Go or Rust would add work without improving the first product.

### Consequences

- Go and Rust are not required for v1.
- Goose is deployed as an isolated worker/runtime with explicit workspace and permission limits.
- A native service can be introduced later for sandboxing or unusually demanding infrastructure without changing the application data model or ACP contract.

## ADR-002: Vite and React frontend with Dexie as a local cache

- **Status:** Accepted
- **Date:** 2026-09-03

### Decision

Use Vite, React, and TypeScript for the interactive client, with Dexie/IndexedDB for local persistence. Dexie is a client cache and outbox, not the cross-device source of truth.

Do not use Next.js. The frontend should build to ordinary static assets and remain deployable on any conventional web host without a Vercel dependency.

### Rationale

The player experience is closer to a stateful collaborative application than a progressively enhanced website. A single client moves through connected modes including lobby, template selection, timed brainstorm, proposal review, voting, build progress, playable version history, and showcase. The facilitator has related controls and team-wide status views.

React suits this because these modes share substantial state and reusable components. Dexie integrates directly through `dexie-react-hooks`, allowing cached records and pending messages to update React views without loading the whole local database into memory.

Alpine remains a good choice for small server-rendered surfaces, but using it for this client would require us to design more of the component, state-machine, and Dexie observation glue ourselves. Its smaller bundle is not the dominant constraint for a session application that already needs a persistent realtime connection and substantial interaction logic.

### Consequences

- Use Vite and React with TypeScript rather than a full-stack frontend meta-framework.
- Keep hosting portable: the production client is static HTML, JavaScript, CSS, and other assets served independently of the TypeScript API.
- Keep phase transitions in an explicit state model rather than scattering them across component-local booleans.
- Use Dexie for cached session/team data, drafts, the outgoing-message queue, and reconnect metadata.
- Do not introduce Redux or another global state library until ordinary React composition plus Dexie live queries proves insufficient.

## ADR-003: Server-authoritative realtime with reconnectable event streams

- **Status:** Accepted
- **Date:** 2026-09-03

### Decision

Use Postgres as the authoritative shared database and a WebSocket connection for low-latency, bidirectional session events. Dexie provides immediate local reads and offline/reconnect resilience but does not synchronize devices by itself.

### Message flow

```text
player submits message
  -> save locally as pending with client_event_id
  -> send over WebSocket
  -> server authenticates membership and validates content
  -> Postgres transaction assigns event_id and team sequence
  -> server acknowledges sender
  -> server broadcasts committed event to the team channel
  -> every client applies it to Dexie and its visible React view
```

Each connection retains the last committed team sequence it has applied. After reconnecting, the client refreshes the authoritative project snapshot and requests events after that sequence before resuming the live stream. `client_event_id` makes retries idempotent and prevents duplicate chat messages. An acknowledgement timeout closes the stale socket and drives that recovery path; outbox records are pinned to their originating round so they cannot leak into a successor round.

The same event channel carries phase changes, timers, proposals, vote closure, build progress, and release availability. Votes and phase transitions are always validated on the server; clients may render optimistic feedback but cannot authoritatively advance team state.

Brainstorm screenshot attachments use the same ordered contribution command/event in the SQLite spike. The browser may attach or paste bounded image data URLs, the server validates the image type and size before commit, and every client replays the thumbnail from the contribution snapshot/catch-up stream. A later object-storage-backed attachment path can replace the payload representation without changing the ordered contribution semantics.

### Rationale

- IndexedDB is restricted to one browser origin and does not synchronize separate devices without an additional service.
- A server commit followed by broadcast gives everyone around the table the same ordered record.
- Persisted sequences allow fast recovery from brief Wi-Fi interruptions without refreshing the entire session.
- A local outbox makes message entry feel immediate while still giving the server final authority.

### Consequences

- Order shared records by server-issued sequence/event ID, not device clocks.
- Show pending, sent, and failed states for locally submitted messages.
- Timers use a server deadline; clients render a local countdown and periodically correct drift.
- Use ordinary HTTP endpoints for initial snapshots, uploads, and administrative actions; reserve WebSocket events for live session changes.
- Do not attempt general-purpose two-way database replication in v1.

### Current collaboration-loop implementation

The SQLite collaboration slice implements this contract with a same-origin, cookie-authenticated Bun WebSocket endpoint per project. Opening a connection supplies the last applied sequence and receives an authoritative current-round snapshot plus later committed events. The socket is bound to that numbered round, so a connection opened before a phase transition cannot write into its successor. HTTP commands cover every transition and broadcast authoritative snapshots. A process-wide deadline recovery loop scans persisted round deadlines from startup onward, independent of connected rooms; connected-room timers improve immediacy but are not correctness infrastructure. A durable proposal-generation claim prevents concurrent deadline, read, reconnect, or early-close triggers from launching or committing more than one agent result. An interrupted lease is recoverable after restart, while a concrete agent failure remains visible for explicit retry instead of being hammered by reads. Connected-room `lvl_up` suggestions remain advisory. An empty human conversation uses a persisted seed claim and fixed round idempotency key; Goose must return exactly two structured starter ideas, which Level Up formats into one ordered contribution. Seed failure/restart state is additive in snapshots and retryable while the room remains empty. Later bot suggestions require a human sequence after the prior bot, so bot-only chat cannot recurse. Repeated bot suggestion text is suppressed, and failed agent calls never commit deterministic product output. A successor-round snapshot replaces the prior round live without refresh and causes the client to reconnect against the new round sequence. Legacy feedback history remains readable in normalized snapshots only for migration compatibility. Current clients create the successor through the Game Versions Brainstorm command after Build starts; no feedback submission or close command gates that transition.

The client presents that state stream through a persistent round progress rail and phase notice rather than requiring users to infer transitions from page structure. The V2 Playwright acceptance harness keeps all three browser contexts open through phase changes to prove the realtime path instead of relying on manual reloads.

Playable releases are cumulative in this slice. `projects.stable_play_url` is copied into the build record as the previous stable release, passed into the build adapter, and used as the source HTML for the next immutable version when present. This keeps accepted work from earlier versions in later builds while preserving old version URLs as immutable artifacts. Future product work may let users choose a different base version before building; until that branch-selection UI exists, the current stable release is the only build base.

### Agent schema-call boundary

Until Level Up exposes a dedicated ACP tool server, Goose agent stages may answer with either the direct validated payload or a schema-call envelope containing `api` plus `payload`/`arguments`. Level Up unwraps only known structured envelopes and then applies the same stage validators before committing anything. This keeps app state server-owned while moving the prompt contract toward Pete's preferred "call this app API with this schema" shape.

### Bounded same-session repair and asynchronous proposal close

All structured stages—brainstorm suggestion, proposal generation, build acknowledgement, game edit, and feedback synthesis—share one repair policy. One ACP session receives the frozen initial prompt. A failed parse or schema/application validation produces a bounded, field-level correction prompt in that same session; only a validated result completes the run. The owner setting is the total attempt ceiling, including the first answer. Provider/setup, permission, interruption, and timeout failures are not disguised as correctable schema errors. The final safe diagnostic is redacted into owner traces, while players receive curated retry guidance.

Proposal reconciliation no longer makes the model repeat successful provenance in both cards and complete decision arrays. Card references deterministically produce ordinary include/retain audit rows. Only exceptional reject/delete choices require explicit reasons. This reduces accidental inconsistency without weakening allowed-source, uniqueness, safety, size, or state-transition checks.

The organiser's HTTP brainstorm-close command persists the running lease and returns `202 Accepted` when generation is asynchronous. Completion publishes the existing round event and remains recoverable from the persisted round snapshot/poll path. This avoids Bun's short request lifetime becoming the agent's execution deadline and preserves idempotency across client timeout, reconnect, and retry.

## ADR-004: Tower-managed application database and stateless deployment

- **Status:** Accepted
- **Date:** 2026-09-03

### Decision

Deploy Level Up to CapRover as one independently hosted Docker application containing the compiled Vite frontend, a thin TypeScript API, the WebSocket realtime gateway, and agent-control integration. The application container is stateless at rest: a restart or replacement must not lose accepted product data.

Use Tower's existing generic WApp database API as the persistence boundary. Register a Level Up app identity and provision one isolated schema for the `(workspace_owner_npub, app_npub)` pair. For v1, all Level Up customers, events, and sessions share this service-owned app namespace and are partitioned by account, event, session, and team IDs in the Level Up tables. Per-customer Tower workspaces may be introduced later if hard schema isolation becomes a product requirement.

Level Up owns its versioned SQL migration files and submits them to Tower's migration endpoint with their versions and checksums. It uses Tower's bounded table CRUD/query endpoints rather than receiving direct Postgres credentials.

The CapRover deployment receives the Level Up app signing credential through protected runtime configuration. The TypeScript server uses it to create exact NIP-98 signatures for Tower requests. The credential must never be committed, compiled into the Vite bundle, logged, or sent to a browser. Browser users authenticate to Level Up; the Level Up server validates guests, memberships, permissions, and domain rules before acting through the app identity.

### Durable-state boundary

Tower's Level Up namespace stores the relational application state, including:

- accounts and billing ownership references;
- events, sessions, members, teams, and invitations;
- rounds, messages, proposals, votes, phase state, and ordered event records;
- AI-run status, model usage, cost records, and release metadata.

Not every durable byte belongs in Postgres:

- generated game source and its history belong in Git/Forgejo;
- immutable compiled game releases and large assets belong in object storage;
- Tower Postgres stores references, checksums, versions, validation status, and public/stable URLs for those artifacts;
- Goose worktrees, build output, and in-process WebSocket connection state are disposable working state and must be committed or published before cleanup.

Dexie remains a disposable browser cache/outbox. It improves responsiveness and reconnect behavior but is not required to reconstruct authoritative session state.

### Rationale

- Level Up gains an isolated Postgres schema, migrations, and bounded data access without adding Level Up-specific tables or routes to Tower.
- Tower retains control of tenancy and database credentials while the Level Up service retains its business rules and realtime behavior.
- A portable CapRover container can be replaced or scaled without moving application data into its filesystem.
- The browser never receives a privileged app credential or direct database access.

### Current constraints

- Tower allocates namespaces per `(workspace_owner_npub, app_npub)`; Level Up must not guess or directly address schema names.
- Typed migrations and table operations are app-signed. Provisioning/descriptor access may also be performed by an authorized Tower service or administrator.
- Tower's current generic API does not provide arbitrary SQL, cross-schema access, multi-operation transactions, joins/aggregates, or an app-table event stream.
- Level Up therefore serializes critical multi-step commands in its server, uses idempotency keys where retries are possible, and broadcasts committed changes through its own WebSocket gateway.
- If a future invariant cannot be implemented safely through the bounded API, add a generic Tower capability or move that invariant behind a purpose-built service; do not add Level Up-specific business logic to Tower.

## Initial implementation shape

```text
Vite + React + TypeScript client
  ├── Dexie cache/outbox
  ├── HTTP snapshot and command API
  └── WebSocket team event stream

TypeScript application server
  ├── authentication and membership
  ├── session/team state machine
  ├── chat, proposals, votes, and releases
  ├── app-signed NIP-98 -> Tower app DB namespace
  ├── WebSocket team broadcasts
  └── AI job queue

TypeScript agent worker
  └── ACP v1 -> isolated Goose runtime -> OpenRouter

Durable external stores
  ├── Tower Postgres namespace -> relational application state
  ├── Git/Forgejo -> generated game source and history
  └── object storage -> immutable releases and large assets
```

The backend remains authoritative even when every participant is physically in the same room, because their phones and laptops are independent clients with independent IndexedDB stores.

The frontend deployment is deliberately separate from the application server and carries no Next.js or Vercel runtime requirement.

## ADR-005: Temporary SQLite adapter for team and project spikes

- **Status:** Accepted for spike only
- **Date:** 2026-09-03

### Context

The managed Level Up app record was inspected before implementation. It had no environment entries and no attached WApp/Tower database binding. The administrative binding-list route was unavailable to the execution identity, and the app descriptor itself reported `wapps: []`.

### Decision

Keep `TeamRepository` as the application persistence boundary and implement the current team/membership/invite/project/template-selection/Round 1 slice with Bun SQLite. The configurable default is `runtime-data/levelup.sqlite`, beneath a Git-ignored directory. Deployments using this adapter must mount that path on durable storage. The CapRover packaging runs one application instance and sets `LEVELUP_DATABASE_PATH=/data/levelup.sqlite` with `/data` mapped to persistent storage; scaling this SQLite adapter beyond one instance is unsupported.

SQLite uses foreign keys and transactions for team creation, invite rotation, and redemption. New invites use a six-character, case-sensitive alphanumeric namespace. Each code is stored as a unique public lookup identifier so authorised team lobby reads can reconstruct the persistent share URL, while its SHA-256 digest remains the redemption verification value. Creation uses database-enforced uniqueness with bounded regeneration. Existing 32-byte base64url secrets remain hash-only and redeemable; a companion short invite is added lazily without revoking the legacy record. Rotation revokes all prior active records.

### Consequences

- Team, invite, project, catalogue, template selections, generic rounds, proposals, votes, briefs, build timelines, feedback, current round, and hashed authentication sessions survive a process restart.
- The adapter is intentionally narrow so a Tower generic-database implementation can replace it without moving business rules into Tower.
- ADR-004 remains the production authority decision. This is not approval for filesystem-backed production persistence or direct Postgres credentials.

## ADR-006: Browser-held Nostr identity and bounded public profiles

- **Status:** Amended by ADR-013 for shared profile caching
- **Date:** 2026-09-03

### Decision

Support both NIP-07 extensions and an optional device-local Nostr signer through one client signer interface. Both sign the existing server-issued login challenge and kind-0 profile templates; the server trusts neither path without normal event, author, challenge, and signature verification.

Generate device secrets in the browser with `nostr-tools`. Encrypt the raw 32-byte secret before writing it to Dexie using Web Crypto PBKDF2-SHA-256 with a random 16-byte salt and 310,000 iterations, then AES-256-GCM with a random 12-byte IV. Store an explicit format version, KDF name, bounded iteration count, salt, IV, ciphertext, public key, and timestamp only. Refuse device identity operations without Web Crypto or IndexedDB and never use plaintext fallback storage. Keep the unlocked key in module memory, zero mutable key buffers when practical, lock it on logout, and require an explicit confirmed action to forget the encrypted record.

Resolve public kind-0 profiles independently from authentication and team state. Query only `wss://relay.primal.net`, `wss://nos.lol`, and `wss://purplepag.es` with bounded waits, verify signatures and exact authors, cap event/content sizes, sanitize supported strings, and accept only HTTPS picture URLs. Cache verified public events with timestamps in a separate Dexie table, render the cache first, and refresh without blocking the lobby. Publishing succeeds after at least one relay acknowledgement and reports partial acknowledgement; every operation closes its relay pool.

The application CSP permits WebSocket connections only to those three relay origins and permits HTTPS images under `Referrer-Policy: no-referrer`. Script and style origins remain self-only.

### Consequences

- Level Up cannot recover a forgotten passphrase or lost browser-held identity. The creation UI must say so before generation.
- The private key remains outside the API, server logs, Tower, Postgres, team state, and public profile cache.
- A relay outage can make names stale or prevent a profile edit from publishing, but cannot block sign-in, team membership, or lobby rendering.
- Public profile edits remain portable Nostr kind-0 events rather than Level Up-specific account mutations.

The browser-only profile-cache portion of this decision is superseded by ADR-013. The signer/private-key and bounded relay-verification requirements remain accepted.

## ADR-013: Shared verified Nostr profile cache and friendly identity presentation

- **Status:** Accepted
- **Date:** 2026-09-23

### Decision

Persist verified, sanitized kind-0 events in Level Up's existing application persistence boundary, keyed by normalized pubkey. Accept only exact-author kind-0 events with a valid event hash/signature and bounded JSON/content; keep the newest `created_at` with event ID as the deterministic equal-time tie-break. Retain only supported bounded strings and HTTPS picture URLs.

Authenticated team and project snapshots carry cached teammate profiles as an additive field. A companion authenticated batch endpoint is capped at 32 pubkeys/events and intersects requests with current team co-membership, so it cannot become an open relay proxy or enumerate unrelated cached identities. Cache entries are fresh for six hours. Clients render server profiles first, mirror them to Dexie opportunistically, and perform missing/stale relay refreshes in the background. Signed profile create/edit events are submitted to the server cache without sending a private key, whether or not every relay acknowledges publication.

Ordinary player-facing UI displays verified `display_name`, then `name`, otherwise a deterministic friendly nickname and branded avatar. Raw or shortened npubs are confined to genuinely technical/admin identity diagnostics.

### Consequences

- A profile learned by one team member is reusable by every authorized teammate and survives application restarts.
- Relay, cache, and local IndexedDB failure remain non-blocking for login, invite redemption, and room entry.
- Snapshot fields are additive and previous payloads without `profiles` normalize to an empty list.
- Tower needs no Level Up-specific behavior; the cache moves with the same repository/persistence adapter as other Level Up data.

## ADR-007: Projects own games; teams own projects

- **Status:** Accepted
- **Date:** 2026-09-03

### Decision

A Team is a persistent membership and invitation boundary that may own many Projects. A Project is one evolving game and owns its selected template, collaboration phase, rounds, repository reference, builds/releases, and stable play URL. A Build is an immutable Project version, not the Project itself.

In v1, the Project is also the collaborative room. Do not add a separate scheduled-session UI. Future events or facilitated sessions may reference a long-lived Project, but cannot become the game's ownership root.

Preserve earlier SQLite `game_sessions` and `session_members` rows as compatibility containers during this additive migration. New team creation may continue populating them until the Postgres migration removes that implementation dependency, but product behavior must not imply that team creation creates a game or a one-and-only session.

Team creation is temporarily restricted at `POST /api/teams` to Pete's verified authenticated npub. The server derives that identity from the signed session and ignores any client-supplied identity claim. This policy does not limit invite redemption or the number of teams an account may own or join.

Project creation authority is the immutable ownership relationship in `teams.creator_account_id`, not the mutable presentation role on `team_members`. The client mirrors both restrictions as affordances, but API and repository checks remain authoritative.

### Consequences

- Project access is always authorized through current Team membership.
- Owner commands are checked against `teams.creator_account_id` on the server.
- Team lobbies enumerate Projects and create them independently of membership/invite creation.
- The team chooser enumerates every membership, and shared team/project navigation returns to it for switching.
- Round, AI-run, repository, stable URL, and release foreign keys target Projects in the accepted target model.

## ADR-008: Bounded snapshot refresh for the SQLite template-selection spike

- **Status:** Accepted for template selection only; Round 1 collaboration now uses ADR-003
- **Date:** 2026-09-03

### Decision

Keep template-selection state authoritative in SQLite behind `TeamRepository`. Project creation writes `0` start/deadline sentinels for an untimed try-the-games stage. An explicit organiser command later writes the configurable server duration (`TEMPLATE_SELECTION_SECONDS`, default `176`) into immutable start/deadline timestamps. Preview reads never expire and selection writes are rejected until that transition. Once voting starts, every read first applies deadline closure and every write validates membership, phase, and the server clock inside the repository transaction.

The client refreshes the complete Project snapshot every two seconds only while selection or tie resolution is active, and refreshes immediately after commands. It corrects its visible countdown from the snapshot's `serverTime` and never writes or extends a deadline. This is a deliberately bounded refresh fallback, not WebSocket realtime.

Template choices are an atomic two-ID replacement set. Rankings are visible and deterministic. Closure chooses a sole leader automatically or moves to an organiser-only tie choice restricted to first-place leaders; final template assignment is immutable.

### Rationale

At the time of the template-selection slice, the Bun `fetch` application exposed no WebSocket upgrade or durable event-sequence contract. Adding an ad hoc socket in that increment would have bypassed the accepted ordered/replayable design in ADR-003. Complete short-lived snapshots therefore remain the bounded template-voting mechanism. The later Round 1 kernel added the ordered/replayable gateway and does not extend this polling approach into collaboration.

### Consequences

- Devices converge within two seconds while the room is active, subject to connectivity.
- There is no offline mutation queue for template or proposal choices in this spike.
- A process restart preserves all shared Project state and non-expired opaque authentication sessions under the additive `auth_sessions` table.
- The six playable previews are copied/adapted into `public/templates` and have no runtime dependency on the source games checkout.

## ADR-009: Replaceable agent and build adapters for the first complete loop

- **Status:** Amended for v2 agent-led loop and playable local-release builds
- **Date:** 2026-09-03
- **Amended:** 2026-09-15, 2026-09-16

### Decision

Use replaceable `BrainstormSuggestionGenerator`, `ProposalGenerator`, build-run agent, game-edit agent, and `BuildAdapter` interfaces for the first complete collaborative loop. The production application server injects Goose ACP-backed brainstorm, proposal, build-run, and game-edit agents. In an empty conversation the brainstorm stage uses a version-2 schema with exactly two distinct starter-idea strings and commits them as one short `lvl_up` contribution behind a durable seed lease. Later suggestions run while clients are connected, at most once per owner-admin configured interval and only after a fresh human contribution since the last bot suggestion. No-change checks back off for 10 seconds, and repeated suggestion text is suppressed before persistence. Proposal generation runs at brainstorm closure. Agent steps run through the same pinned, isolated no-tools ACP boundary, return JSON only, and Level Up validates output shape and size before committing durable state. Proposal cards additionally validate referenced contribution sequences before committing proposal rows and the phase transition.

The silent/deterministic brainstorm and proposal generators remain as test/offline adapters only. If an agent step fails in the product path, Level Up surfaces a concrete setup/provider error and keeps the round retryable or failed without inventing suggestions, requirement cards, or build results.

The production build path first invokes the Goose build-run agent, then invokes the Goose game-edit agent through a `levelup.game.edit` schema-call contract. The game-edit payload must contain a complete self-contained `index.html`; Level Up validates that it is a bounded offline playable document before writing a release. As of the September 15 playable-validation hardening, local generated releases are also loaded in a headless browser before publish. Browser validation fails the committed edit when the page has console/page errors, expected startup or draw hooks are absent at runtime, the canvas is blank, visible controls/render surfaces are missing, the game does not respond visibly to time or input, or the game itself is not visibly changed from the previous playable source. The injected Level Up build panel is excluded from the visible-change proof. The selected template is the implicit base, the committed proposal publishes as `v2`, and the first compatible stretch proposal publishes as `v3` when the first edit leaves time in the five-minute local build budget. If the committed edit is invalid, the build fails; if only the optional stretch edit is invalid, the valid `v2` is kept and the stretch remains deferred. The adapter writes manifests, records included/deferred proposal IDs, serves the newest generated version at `/projects/<project>/versions/vN/`, and updates the project stable play pointer after validation. Deferred or otherwise unbuilt voted cards are copied into the successor round's `priorFeedback.requirementBacklog`, exposed in the brainstorm UI, and included in the next proposal-generation prompt so the model continues from the backlog. The deterministic simulated adapter remains available for tests and isolated development.

September 16 amendment: the build experience is moving from a round-level stage rail to a feature-card queue. The frozen top proposals become visible feature cards. The current card sits in the left column, remaining cards stack below it, and the right column shows only factual agent loops for the current card: review when an agent is reviewing scope, build when an agent is editing/building, and testing when Level Up is validating the playable result. Completed cards receive their own immutable playable link and the next queued card begins in the background.

September 17 amendment: feature delivery never introduces an approval gate before the next queued build. After delivery, players may playtest, wait with the build progress, or begin brainstorming more features; all three are concurrent user paths while the next frozen feature starts automatically. A new brainstorm cannot cancel, replace, reorder, or delay the active queue, and its ideas are candidates only for a later proposal/vote cycle. Players can still interrupt the active loop by reporting that the game is not running; that report must stop or mark the current feature loop before any further publish, preserve the prior stable release, and give the organiser a retry/defer path.

September 18 amendment: voting orders the entire generated proposal set; it no longer selects only the top three for building. Every generated card enters the frozen feature queue, including zero-vote cards, with fewer votes placing a card lower. If a card requests behavior already present or its safe playable result is materially unchanged, record a no-change completion, roll the stable game forward for that card, and advance automatically. Difference detection is diagnostic for this outcome, not a queue-blocking validation gate. Safety and playability validation remain mandatory.

September 22 build-speed amendment: the persistent workspace builder supersedes the legacy agent-driven validation and repair behavior. Goose receives one feature implementation request. Level Up accepts a valid compact handoff whether plain or markdown-fenced and must not issue a generic “continue implementing” prompt after completion. Level Up then runs only the deterministic package check, publishes the immutable candidate with `humanReviewRequired: true`, and leaves gameplay acceptance to the human playtest/report flow. Headless-browser evidence remains a diagnostic/test utility, not a production publish gate for this builder.

September 21 amendment: proposal review is coverage-preserving. Goose receives the complete human brainstorm and unbuilt backlog, and every source contribution sequence and backlog proposal ID must occur exactly once across the returned cards' provenance. This allows several overlapping sources to become one strengthened card while rejecting silent omission and near-duplicate source reuse. The application accepts at most 50 combined sources and up to 200 KB of output; excessive input/output fails recoverably instead of being sliced. Persisted proposal provenance adds `backlog_refs_json` with an empty-array migration default, and previous brief shapes still normalize `selected` from committed/stretch fields.

September 22 product correction: the agent orders changes by priority and Level Up keeps the first one to five valid cards. Related comments should be consolidated rather than becoming one card each. An otherwise valid sixth or later card no longer fails the run: it is discarded, and sources not represented in the retained five receive deterministic reject/delete audit decisions. Duplicate or foreign provenance inside retained cards remains invalid, and filler is still forbidden.

September 22 backlog correction: Goose now selects only the two-to-five newly discovered cards from the current brainstorm. Level Up appends every still-unimplemented card unchanged after model validation, so an old card cannot disappear because of a model cap or reconciliation choice. Voting in the current round orders every card that receives a new vote; remaining zero-vote backlog is ordered by cumulative vote tokens retained across rounds. Active and completed queue entries remain stable.

September 22 amendment: proposal generation publishes its persisted `running`
snapshot to every connected project member as soon as the generation lease is
claimed, and publishes the recoverable `failed` snapshot if the run terminates
without cards. Reconnect, reload, and HTTP catch-up hydrate those same durable
states; organiser-local pending state is only an immediate presentation hint.
Structured runs retain a syntactically valid truncated JSON prefix and request
only its missing suffix in the same Goose session before applying the complete
payload to the unchanged semantic validators. Provider activity refreshes a
bounded inactivity timer, while an independent total-run timer remains an
absolute cap. Proposal generation defaults to 180 seconds of inactivity and a
900-second total budget, enough for all five configured turns without making
ordinary elapsed time the primary failure signal. It stops as soon as the first
payload validates. The proposal-only output allowance defaults to 6,000 tokens,
and its compact prompt makes cited include/retain decisions implicit rather than
asking the model to repeat them. Both timeout reasons are recorded in
secret-safe run traces. Complete balanced embedded JSON may still be extracted from surrounding
prose or fencing, but partial proposal sets never commit.

The player-facing loop is five stages: Brainstorm, Review, Prioritise, Build, and Iterate. Review maps to generated proposal cards, Prioritise maps to voting, and vote closure freezes the internal brief and starts Build in one server command. Build includes delivery/playtest states and exposes every available cumulative version with its feature outcome. Iterate is presentation-only loop affordance back to Brainstorm and never becomes a route or persisted phase.

September 23 product correction: the standalone playtest-feedback destination is removed. Completed releases remain playable only through Game Versions, and its **Brainstorm New Features** action is the sole continuation into a successor round. The structured feedback submit and organiser-close HTTP routes are removed; the persisted `playtest` phase, feedback rows, summary records, and normalization fields remain readable only so older projects load safely and can use the same Brainstorm path. A completed final queued feature may remain internally labelled `playtest`, but it never waits on feedback. **Game is not running** remains the independent build-interruption command.

All live agent/build diagnostics are emitted as structured `[levelup]` JSON into the Autopilot-managed Level Up app logs, with project/round/stage/version correlation and secret redaction. This is the operational source for explaining failed builds during playtest until the normalized `ai_runs`/release tables move fully behind Tower-backed persistence.

Proposal voting uses the current owner-configured private vote-token allowance per member, defaulting to 5 and bounded to whole numbers from 1 to 20. The effective value travels in the authoritative round snapshot, with legacy payloads normalizing to 5. Tokens can be stacked on one proposal or spread across proposals, and the replacement payload may contain duplicate proposal IDs. Ties continue to resolve by token count descending, first-token votes descending, second-token votes descending, stable generated position ascending, then proposal ID ascending. The complete ordered set and rule text are frozen in the round brief before build starts.

### Consequences

- The experience now exercises Goose during live brainstorm suggestions, brainstorm-to-proposals, build-run acknowledgement, and game-source editing when the managed runtime has an OpenRouter key, model, and valid Goose binary, without giving Goose authority over membership, votes, phase rules, briefs, validation, or publishing.
- Brainstorm suggestions are visible, replayable bot chat entries and can be used as later proposal context, but they are not proposals until closure validates proposal cards.
- Missing or invalid credentials/model/binary now produce actionable errors and retry affordances; separate `LEVELUP_*_AGENT_ENABLED` flags are not part of the runtime contract.
- Tests and isolated development can still inject deterministic proposal generation.
- The first real builder makes the chosen response playable and versioned through ACP-backed HTML edits, but does not yet run Goose against a project worktree, commit source changes, or publish Forgejo-backed artifacts.
- A failed adapter validation moves the round to `failed` and cannot change the last playable release.
- Later real integrations replace interfaces rather than acquiring authority over membership, voting, briefs, validation, or releases.

## ADR-010: First real ACP integration is feedback synthesis

- Status: superseded for product flow; legacy compatibility remains in source
- Date: 2026-09-05

The v1 feedback-synthesis gate invoked isolated Goose through ACP after organiser feedback closure. V2 removes that gate from the runnable product loop: playtest closure creates the next brainstorm directly, and saved notes become context for brainstorm and proposal generation. Legacy summary persistence and prompt handling may remain to read old data or support tests, but current product behavior must not block a round on feedback synthesis.

## References

- [Official ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk)
- [Goose ACP CLI and server modes](https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/goose-cli-commands.md)
- [Dexie with React and `useLiveQuery`](https://dexie.org/docs/Tutorial/React)
- [React state-management guidance](https://react.dev/learn/managing-state)

## ADR-012: Persistent workspace feature builder and project queue

- **Status:** Accepted and implemented for the local SQLite runtime
- **Date:** 2026-09-21

Production feature builds now bypass the legacy `build_run` acknowledgement and
whole-HTML `game_edit` response. A project-scoped queue reconciles voted waiting
work by provenance while fencing one active lease. Goose runs one feature goal
in an isolated, path-validated multi-file package with the bundled developer
extension, a command and filesystem contract in package `AGENTS.md`, and a
build-specific provider budget. Goose receives one implementation prompt and a
valid plain or fenced compact handoff ends the agent run immediately. Level Up
performs the deterministic package check and publishes paired immutable source
snapshots and compiled release directories marked for human review. It does not
send generic continuation, agent-validation, or repair prompts, and headless
browser validation is not a production publish gate for this builder. Legacy
prompt stages and release records remain readable but are not the production
builder boundary.

September 23 review-fallback amendment: after the primary implementation passes the deterministic package check, Level Up freezes it before invoking a fresh, read-only independent reviewer. An `approved` verdict publishes that primary candidate. Reviewer timeout, provider failure, or invalid structured output is retained as review failure evidence and publishes the checked primary candidate; it cannot overwrite implementation/package success. A `changes_required` verdict permits exactly one corrective build based on concrete findings. A checked correction publishes without another review. If correction or its package check fails, publication falls back to the frozen checked primary. The stable pointer changes only after the selected candidate and immutable evidence publish successfully.

The reviewer receives a disposable copy of the frozen candidate and must return
the explicit structured status `approved` or `changes_required`; reviewer file
mutations are never publication input. Terminal delivery evidence is retained in
the immutable manifest/checkpoint, the round feature snapshot, and the durable
project feature queue. Missing delivery evidence on older queue rows is valid.


### ADR-010 implementation evidence and pinned isolation

Pin Goose 1.43.0 with `@agentclientprotocol/sdk` 0.16.0. `FeedbackWorker` polls the durable SQLite queue independently of connected browsers. It runs inference outside transactions, does not automatically repeat interrupted paid calls, and stops only owned child processes. Three manual attempts are allowed. HTTP retry includes the expected attempt number so an old retried request cannot start another paid attempt after a newer failure.

Version-specific inspection and a real Goose/local-provider preflight confirmed that OpenRouter reads `OPENROUTER_API_KEY` directly (the generic `GOOSE_PROVIDER__API_KEY` guidance is not used for this pinned provider). Each attempt gets a private temporary `GOOSE_PATH_ROOT`, empty cwd, explicit environment, no hints, no session naming/compaction, and zero enabled extensions. Goose still exposes its internal scheduler tool: the client verifies chat mode, applies and verifies `never_allow`, and sets `OPENROUTER_PARAMETERS` to `tools: []` and `tool_choice: none`. Unknown tools or missing isolation methods fail before prompting. ACP filesystem/terminal/permission requests are declined. This is pinned application/tool isolation, not an OS network sandbox. The local preflight asserts that the provider request has no tools and uses the expected credential; it is not evidence of paid OpenRouter model success.

The real adapter keeps only final assistant message chunks, requires `end_turn`, rejects extra JSON fields/invalid IDs/oversize output, and publishes escaped structured text. Semantic faithfulness still needs human review of a paid contradictory/malicious/sparse fixture run. Run-specific implementation and activation evidence is retained privately, outside the published source repository.


A real adversarial provider stub also demonstrated that Goose can retry empty/tool-only responses internally. Each attempt therefore owns a loopback-only provider gateway: authenticated with the child credential, fixed OpenRouter upstream, explicit model/output-token/tool checks, no redirects, bounded request concurrency, and a finite forwarded-completion budget. Goose model inventory is limited to the configured model. Structured stages keep their no-tools boundary. Feature builds instead create a session with only the bundled developer extension and an explicit workspace-tool allowlist, advertise a separate 32,768-token completion budget (owner-configurable from 8,000 through 256,021), and ask OpenRouter for low reasoning effort so reasoning does not consume the action channel. Two consecutive reasoning-only `length` completions abort with a classified retryable failure. This guard is internal to the Level Up process, requires no shared service reconfiguration, and prevents unexpected repeated paid requests before ACP cancellation arrives.

## ADR-011: Owner-only admin prompt editor

- **Status:** Accepted
- **Date:** 2026-09-15

### Decision

Add an Admin mode that is available only to Pete Winn's owner npub
(`npub1jss47s4fvv6usl7tn6yp5zamv2u60923ncgfea0e6thkza5p7c3q0afmzy`) and
displays project/process-loop inspection, recent redacted Goose ACP run traces,
the editable Goose ACP prompt templates for active Level Up stages, and runtime
loop controls. Active stages include brainstorm suggestion, proposal generation,
build-run activity, and game editing. Legacy feedback-synthesis prompt text may
remain editable for old data and tests, but it is not an active v2 product stage.

The server enforces this access check on `/api/admin/agent-prompts`,
`/api/admin/settings`, `/api/admin/projects`, and `/api/admin/agent-runs`; the
client only hides or shows the entry as a convenience. Prompt defaults remain
compiled with the source code, while runtime overrides are stored in
`runtime-data/agent-prompts.json` or `LEVELUP_AGENT_PROMPTS_PATH`. New Goose runs
render the current saved template immediately before invocation.

Every template must retain `{{inputJson}}`. Level Up replaces that placeholder
with the frozen stage input JSON and rejects templates that remove it.

The brainstorm suggestion interval is saved through the same owner-only admin
surface as a bounded whole number of seconds from 5 to 600. Saving it reschedules
connected brainstorm rooms without giving the admin surface authority over
player messages, votes, phases, briefs, validation, or publishing.

The proposal vote allowance is saved through that settings surface as a bounded
whole number from 1 to 20, defaulting to 5 for absent or legacy settings.
Replacement validation reads the current setting, while every round snapshot
publishes the effective allowance so clients do not infer it.

Goose max turns is saved in the owner-only admin settings file as a bounded whole
number from 1 to 5, defaulting to 3. New Goose runs read the current value at
invocation time, pass it as `GOOSE_MAX_TURNS`, and apply the same budget to the
loopback provider gateway so the admin setting is both visible and enforced.

Agent-run monitoring is durably persisted in additive SQLite
`agent_run_traces` and `agent_run_trace_turns` tables. Persistence begins before
the ACP call and is refreshed for session, model-turn, success, and failure
mutations so running, failed, and interrupted work survives managed-app rebuilds
and restarts. Existing per-item and per-run transcript byte ceilings remain;
there is no automatic count-based deletion. Legacy `ai_runs` data remains
compatible but is not promoted into a transcript when the historical bodies do
not exist.

The owner-only run analysis records the compiled ACP prompt, provider responses
as ordered model turns at the attempt-local gateway, and the final payload after
Level Up parsing/validation. This narrowly supersedes the earlier preview-only
diagnostic rule. Recursive redaction is applied before retention and again at
admin API serialization, with per-body and per-run byte ceilings and explicit
truncation markers. The transcript remains unavailable to project snapshots,
player APIs, realtime broadcasts, and managed-app body logs. Legacy
trace shapes remain readable as metadata with transcript sections marked
unavailable; Level Up does not reconstruct absent history.

OpenRouter model choice is also owner-managed at this boundary. The version-2
admin settings file stores a bounded allowlist of unique `provider/model` IDs
and exactly one default. `LEVELUP_AGENT_MODEL` seeds both values when settings
are absent or version 1. Each editable prompt record independently stores either
default-model mode or one specific allowed model; legacy records are default
mode. Removing a default or specifically assigned model is rejected rather than
silently rerouting a stage.

Each Goose invocation snapshots a fresh config after resolving its stage model.
Consequently a saved default or stage override affects the next invocation,
while an in-flight process retains its original model. The resolved model is
used consistently by Goose, the attempt-local OpenRouter gateway, structured
activity logs, and the redacted run trace. The existing pinned Goose version,
empty extension set, denied tool inventory, provider gateway, and max-turn
enforcement are unchanged; model settings never contain provider credentials.

### Consequences

- Pete can browse current projects, see their latest process-loop state, inspect
  recent redacted Goose run inputs, ordered model turns, final boundary payloads,
  and runtime metadata, and adjust live prompt
  wording, Goose max turns, and the brainstorm suggestion cadence
  without changing source code, subject to a Level Up app restart only when the
  running app has not yet picked up this code.
- Prompt editing does not grant Goose business authority over teams,
  membership, votes, phases, briefs, validation, or releases.
- Pete can maintain up to 24 allowed OpenRouter model IDs, choose the default,
  and bind each active or legacy-editable prompt stage to default or a specific
  allowed model without restarting for later invocations.
- The override file is local runtime state for the current SQLite adapter and
  should move behind the same durable application persistence boundary as the
  rest of Level Up when Tower-backed persistence replaces runtime-data files.

## Device-local auto-unlock and workshop coordination

New workshop accounts use a random browser-generated AES wrapping key instead of a human passphrase or shared application secret. IndexedDB stores the wrapping key separately from the encrypted identity record, and create/migrate/forget transact across both stores. This provides honest zero-friction device persistence, not a security boundary: same-origin code and anyone with access to that browser profile can access both halves. Missing halves are explicit recoverable states. Neither key nor nsec crosses the network. Existing PBKDF2 records retain their old unlock route and are rewritten to version 2 only after successful decryption.

Facilitation is Level Up application state, not Tower state. SQLite owns Group Mode selection/status/audit/results and Round Captain assignments. Bulk commands isolate each project, skip known state-ineligible calls, and use a unique request ID as their idempotency fence; replay reads that request's exact outcomes. The server resolves one authoritative owner/admin npub through the existing auth/config boundary and passes it into the repository; client identity claims and duplicate hard-coded server values have no role in eligibility. Captain cycles persist a deterministic shuffled non-owner eligible-player order and cursor, reshuffling only after every current-cycle player has captained once. Round 1 is assigned transactionally with project creation so initial template-tie authority exists before voting, and each numbered round's assignment authorizes opening that round's proposal vote. The next-round assignment continues to authorize the discretionary successor-brainstorm transition after Build begins. Repair removes the owner from current/historical assignments and stored order before selecting the next unconsumed candidate; no candidate means no captain. Authorization is enforced before each command transition. Owner override remains an explicit administrative command outside the cycle and cannot mutate the cycle to include the owner; organiser status alone grants neither tie resolution nor proposal-vote opening.

Monitoring distinguishes facts from unavailable telemetry. Joined count, phase, captain, stable release, and persisted agent state are shown when known. Connected count remains unavailable until the realtime hub exposes a trustworthy aggregate; the UI says so rather than inferring it.
