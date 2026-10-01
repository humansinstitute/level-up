# Level Up — Data Model

## Purpose

Level Up hosts persistent teams that build one or more game projects. A project is one evolving game and the v1 collaborative room. Sessions and events may later schedule or facilitate activity around a project, but they do not own the game.

Postgres is the authoritative database for this model. The Vite/React client may mirror selected records into Dexie for fast reads and reconnect resilience, but IndexedDB is not a second authority and does not add separate server-domain tables. Browser-local identity vault records are an explicit security exception: they are device credentials outside the Level Up server data model, not shared application state.

## Core relationships

```text
Account
└── Teams (many-to-many membership)
    ├── Team Members
    ├── Team Invites
    └── Projects
        ├── Template Selections
        ├── Rounds
        │   ├── Messages
        │   ├── Proposals
        │   └── Votes
        ├── AI Runs
        └── Releases / Builds
```

The current SQLite schema retains `game_sessions` and `session_members` created by the earlier team-invite spike. They are compatibility containers so existing teams, memberships, and invites migrate without destructive rewriting; new product logic must not interpret one such row as a team's one-and-only game. The target Postgres model may normalize these away or repurpose sessions only as optional facilitation records.

## Tables

### `accounts`

Registered people who can join teams and participate in projects. Current policy permits only Pete's verified npub to create teams; project creation derives from team ownership.

- `id`
- `nostr_pubkey` — unique normalized 64-character hex public key in the current spike
- `nostr_npub` — presentation encoding, not the identity key
- `display_name`
- `openrouter_key_ref` — encrypted secret reference, never the raw key
- `created_at`, `updated_at`

The account row is identical for extension and device-local signers. The server receives a pubkey and signed events only; it never receives, stores, recovers, or has a reference to a device account's secret key.

### `nostr_profile_cache`

A bounded shared cache of public Nostr kind-0 presentation events. It is keyed by normalized 64-character hex pubkey and stores the verified event ID, event `created_at`, bounded event JSON, and server receipt time. An incoming record is accepted only after kind, exact-author, event-hash, signature, JSON, and byte-limit validation. Equal or older events cannot replace the current row. Sanitized reads expose only supported bounded strings and HTTPS picture URLs.

Authenticated team/project snapshots include cached profiles only for that team. The authenticated batch endpoint accepts at most 32 pubkeys and intersects them with the caller's current teammate set; signed-event updates use the same bound and ignore non-teammate authors. Entries are fresh for six hours. Clients render them first, optionally mirror them to Dexie, and refresh only missing/stale profiles without blocking entry.

## Browser-only records

Dexie maintains browser-local stores that are not authoritative team state:

- `identities` contains at most one device vault record. Legacy format version 1 contains the KDF identifier, bounded PBKDF2 iteration count, random salt, random AES-GCM IV, ciphertext, public key, and creation timestamp and still requires its passphrase. Auto-unlock format version 2 contains the cipher identifier, random IV, ciphertext, public key, and creation/migration timestamps.
- `identityUnlockKeys` contains the version-2 random 256-bit AES wrapping key. It intentionally shares the same origin and browser profile as the ciphertext, so this split supports zero-friction recovery and transactionally consistent lifecycle operations; it does not protect against malicious same-origin code or anyone with browser-profile access. The decrypted Nostr secret exists only in module memory while unlocked and never becomes a server field, URL value, HTML value, or localStorage item.
- `profiles` mirrors verified public kind-0 events from the shared server cache by pubkey with a fetch timestamp. It is an optional fast local cache, safe to discard, and is never the shared source of truth.
- `roundOutbox` stores client event ID, project and round identity, idea body, creation time, and pending/sent/failed delivery feedback. It may retry an idempotent command only against its originating round but never determines committed ordering or phase. Previous records without round identity are normalized into an actionable failed state instead of being resent into a later round.

Logging out locks the in-memory key while retaining both version-2 records. Create, legacy migration, and forget use one IndexedDB transaction spanning both stores. If an older interrupted write nevertheless leaves only one half, the client reports an explicit recoverable incomplete-record state and offers Forget rather than treating it as a valid identity. Neither logout nor forget changes authoritative team membership, which remains attached to the stable Nostr pubkey.

## Owner admin records

The current SQLite/runtime-data implementation includes an owner-only prompt
override file at `runtime-data/agent-prompts.json` unless
`LEVELUP_AGENT_PROMPTS_PATH` points elsewhere. It is not browser state and is
served only through authenticated admin APIs restricted to Pete Winn's npub:
`npub1jss47s4fvv6usl7tn6yp5zamv2u60923ncgfea0e6thkza5p7c3q0afmzy`.

The file stores:

- `schemaVersion`
- `prompts[stage_id].template`
- `prompts[stage_id].updatedAt`

Supported active stage IDs are `brainstorm_suggestion`, `proposal_generation`,
`build_run`, and `game_edit`. Legacy `feedback_summary` prompts may exist for compatibility
with older runs, but they do not drive the v2 product loop. Every saved template
must include the exact
`{{inputJson}}` placeholder; Level Up replaces that placeholder with the frozen
stage input immediately before invoking Goose ACP. Removing or corrupting the
placeholder is rejected so the quoted input boundary remains explicit.

The current SQLite/runtime-data implementation also includes an owner-only
settings file at `runtime-data/admin-settings.json` unless
`LEVELUP_ADMIN_SETTINGS_PATH` points elsewhere. It stores schema version,
`brainstormSuggestionIntervalSeconds`, `agentMaxTurns`, `proposalVoteAllowance`, and `updatedAt`. The
interval defaults to 30 seconds and is bounded to whole-second values from 5 to
600 seconds. Goose max turns defaults to 3 and is bounded to whole-number values
from 1 to 5. Proposal vote allowance defaults to 5 and is bounded to whole-number
values from 1 to 20; absent legacy fields normalize to 5.

The current owner admin surface exposes the newest project/process summaries and
durable redacted Goose ACP run monitoring from the same SQLite database. The
additive `agent_run_traces` table stores run identity, stage/client/model/turn
budget, status and timing, byte and usage metadata, Goose session, safe error,
sanitized correlation fields, bounded compiled input, final boundary payload,
and explicit truncation state. Ordered bounded model outputs live in
`agent_run_trace_turns` keyed by run and turn number. Each current-shape trace stores stage, client
name, model, configured max turns, status, timestamps, duration, prompt/output
byte counts, aggregate token/cost data when Goose reports it, Goose session ID,
classified error code/detail, sanitized correlation fields, the compiled prompt
submitted to ACP, one numbered entry per provider completion in chronological
order (or an ACP final-output fallback when no provider gateway event exists),
and the final validated/parsed payload Level Up accepted at its schema/API
boundary. Each body is independently bounded, the whole transcript has a
per-run byte ceiling, and every clipped value carries an explicit truncation
flag. Recursive sanitization runs before SQLite persistence and again before
owner API serialization; credential/header/cookie fields, signed events,
provider or private keys, invite secrets, callback/access tokens, and runtime
environment payloads are replaced with redaction markers. Bodies never enter
managed-app activity logs. A row is inserted when a trace starts and updated on
every session, turn, success, or failure mutation, so running and interrupted
work remains useful after restart. Run rows have no automatic count-based
pruning; archival can be introduced later only as an explicit documented
policy. Legacy `ai_runs` rows remain untouched and are not presented as
monitoring transcripts because missing bodies must not be fabricated.

### `events`

Future optional scheduling umbrella for related facilitated sessions. It does not own projects.

- `id`
- `owner_account_id -> accounts.id`
- `name`
- `description`
- `starts_at`, `ends_at`
- `status` — `draft`, `active`, `complete`, `cancelled`
- `created_at`, `updated_at`

### `sessions`

Future optional facilitated timebox around a long-lived project. It does not own the game. The SQLite `game_sessions` table currently remains only as a compatibility container for earlier team rows.

- `id`
- `event_id -> events.id` — nullable
- `creator_account_id -> accounts.id`
- `billing_account_id -> accounts.id`
- `name`
- `join_code`
- `status` — `draft`, `lobby`, `active`, `showcase`, `complete`
- `settings_json` — timers, team limits, enabled templates, model budget
- `starts_at`, `ends_at`
- `created_at`, `updated_at`

### `session_members`

Everyone admitted to a session. Registered facilitators reference an account; guest players do not need one.

- `id`
- `session_id -> sessions.id`
- `account_id -> accounts.id` — nullable
- `guest_identity` — nullable generated identity or public key
- `display_name`
- `avatar`
- `role` — `organiser`, `facilitator`, `player`
- `joined_at`

The current team-invite slice uses unique `(session_id, account_id)` membership and roles `organiser` or `player`. Both columns are non-null because this slice requires Nostr authentication.

### `teams`

- `id`
- `session_id -> sessions.id` — compatibility-only in the SQLite spike
- `name`
- `join_code`
- `created_at`, `updated_at`

The current slice also records `creator_account_id` as the authoritative team owner. Project creation and invite rotation compare the authenticated account directly with this field rather than trusting a membership role.

### `game_templates`

The curated server-owned catalogue. Four records are selectable for new projects: Citadel Strike, Skyline Sprinter, Village Games, and the single multi-game Arcade Cabinet package.

`selectable` is a durable boolean catalogue flag. Startup reconciliation updates the canonical metadata and marks the four current starters selectable on both fresh and existing databases. Retired standalone Minotaur Maze, Neon Trail, Pocket Pong, and River Hop records remain non-selectable so foreign keys, historical project previews, releases, and build bases continue to resolve. Catalogue responses, rankings, tie resolution, and new favourite validation use selectable records only; hydration of an already selected project may resolve either selectable or legacy records.

- `id`
- `title`
- `description`
- `theme_prompts_json`
- `preview_url`
- `visual`

### `projects`

One evolving game owned by a team.

- `id`
- `team_id -> teams.id`
- `name`
- `phase` — template selection states plus compatibility value `round_1_brainstorm`, which now means the generic collaboration loop is active; the current numbered round owns its actual phase
- `selected_template_id -> game_templates.id` — nullable until finalisation, immutable afterward
- `selection_started_at`, `selection_deadline_at` — server-authored millisecond timestamps; both are `0` during the untimed try-the-games stage and become immutable real timestamps when the organiser starts voting
- `selection_closed_at` — nullable until early/deadline closure
- `repository_ref` — nullable future repository identity
- `stable_play_url` — nullable until a verified build is published
- `created_at`, `updated_at`

### `project_template_selections`

The current two favourites for one project member. No selection may be written during the untimed try-the-games stage. Once voting starts, replacement is transactional: the server deletes that member's prior pair and inserts the new pair only after validating membership, phase, start/deadline, catalogue membership, and exactly two distinct IDs.

- `project_id -> projects.id`
- `account_id -> accounts.id`
- `template_id -> game_templates.id`
- `created_at`, `updated_at`

Primary key: `(project_id, account_id, template_id)`. The API returns complete rankings and a top-three projection, ordered by vote count then stable title/id ordering.

### `project_creation_requests`

Maps `(team_id, idempotency_key)` to the created project so a retried organiser command cannot create duplicates.

Deleting a project is normally an organiser-only command. The configured owner/admin has a separate server-authorised override for any project. Project-owned rows, including this idempotency map, template selections, rounds, round events, feedback, legacy summary runs, agent traces, feature queue/run rows, and build/release metadata, are deleted transactionally with the project so the team remains while the retired game room is removed. Local workspace, source-snapshot, and release directories are path-validated and removed after the database commit. Owner team deletion applies the same project cleanup to every child project, then deletes team membership, invites, and the compatibility session atomically.

### `team_members`

Many-to-many membership between authenticated accounts and teams.

- `team_id -> teams.id`
- `account_id -> accounts.id` in the current and accepted persistent-team model
- `joined_at`

The current slice stores `account_id` directly and enforces unique `(team_id, account_id)`. It also mirrors membership into legacy `session_members` only to preserve compatibility with existing spike data.

### `team_invites`

Reusable team admission credentials.

New records carry a unique, case-sensitive six-character `short_code` drawn from ASCII letters and digits. It is the public share identifier returned with member-authorised lobby reads so the QR and copy link survive navigation and reload; `secret_hash` remains the value used to verify redemption. The database uniqueness constraint is authoritative and creation retries collisions only a bounded number of times. Pre-change rows may keep `short_code = NULL` and their longer hash-only secret remains redeemable; the first lobby read adds a companion active short-code invite without revoking that legacy link. Rotation revokes every older active row before creating one new short-code invite.

- `id`
- `team_id -> teams.id`
- `secret_hash` — unique SHA-256 digest; plaintext is never persisted
- `short_code` — nullable unique public lookup identifier for current six-character invites
- `status` — `active` or `revoked`
- `creator_account_id -> accounts.id`
- `expires_at` — nullable
- `created_at`, `updated_at`

Legacy secrets contain 32 cryptographically random bytes encoded as base64url. Current codes contain exactly six cryptographically selected alphanumeric characters and preserve case. Redemption accepts both exact shapes and treats malformed, unknown, expired, and revoked values as the same opaque error. A successful redemption inserts both session and team membership atomically; uniqueness makes retries idempotent.

### `rounds`

One discussion-to-release iteration for a project.

- `id`
- `project_id -> projects.id`
- `number`
- `phase` — persisted implementation states `brainstorm`, `proposals`, `voting`, `brief`, `building`, `playtest`, or `failed`. Player-facing stages map to Brainstorm, Review, Prioritise, and Build; `brief` is a compatibility/transient internal state and `playtest` remains within Build. Iterate is a visual loop cue, not a persisted phase.
- `brief_json` — frozen winning proposal and ordered stretch work
- `started_at`, `deadline_at`, `closed_at`, `completed_at`
- `last_sequence` — authoritative per-round event sequence

Unique constraint: `(project_id, number)`.

The SQLite adapter uses additive `collaboration_*` tables so the bounded Round 1 schema can remain intact as migration input. It inserts Round 1 when template selection becomes final and a unique successor when the authorised Brainstorm action is used after Build starts. `UNIQUE (project_id, number)` and transactional transitions make retries and restarts safe. A round also stores its voting deadline, frozen brief, optional legacy prior-feedback context, carried requirement backlog, and authoritative event sequence. Proposal generation adds `proposal_generation_status`, a retry-safe attempt count, lease timestamp, safe error copy, and `proposal_reconciliation_json`. The reconciliation document is schema version 2 and stores one explicit decision per backlog proposal and human contribution. Cards, reconciliation, completion status, and the proposals phase transition commit in one transaction; interrupted `running` leases return to recoverable work on process startup.

### `messages`

- `id`
- `round_id -> rounds.id`
- `session_member_id -> session_members.id`
- `body`
- `attachments_json` — bounded optional image attachments for brainstorm screenshots, currently persisted as validated browser image data URLs in the SQLite spike
- `created_at`
- `moderation_status`

The SQLite adapter currently names this table `round_contributions`, references `author_account_id` directly, and adds `client_event_id` plus the committed round `sequence`. `UNIQUE (round_id, client_event_id)` prevents retry duplication and `UNIQUE (round_id, sequence)` fixes server order. Screenshot attachments are additive and optional; older contribution rows normalize to an empty attachment list.

The current `collaboration_contributions` table also stores nullable bot presentation metadata through `author_kind` (`member` or `bot`) and `author_label`. Human/player submissions default to `member`. Periodic `lvl_up` brainstorm suggestions are committed as `bot` contributions with the same sequence, replay, and catch-up semantics as player ideas, so all clients see the same advice in the same chat position. When a round has no human or bot conversation contributions, a schema-validated pair of starter ideas is formatted into one contribution with the fixed client event ID `lvl-up-seed-<round-id>`. Additive round fields persist seed status, safe error, attempt count, and lease time; startup converts an interrupted lease to retryable failure. After a successful seed, another bot suggestion is eligible only when at least one human contribution has a higher sequence than the latest bot contribution, and normalized duplicate bot text is suppressed. When the brainstorm agent call fails, Level Up surfaces retryable setup/execution status instead of committing invented chat.

### `round_events`

Ordered committed changes used for WebSocket replay and HTTP catch-up in the current slice.

- `round_id -> rounds.id`
- `sequence`
- `type` — currently `contribution_committed` or `phase_changed`
- `payload_json`
- `created_at`

Primary key: `(round_id, sequence)`.

### `collaboration_proposals`

The agent-generated, achievable choices distilled from a round's discussion.

- `id`
- `round_id -> rounds.id`
- `title`
- `description`
- `implementation_scope`
- `acceptance_criteria_json`
- `idea_refs_json` — contribution sequences reflected by the card
- `backlog_refs_json` — prior proposal IDs reflected by the card; additive and `[]` for previous-shape rows
- `position` — stable generation order used by deterministic tie-breaking
- `created_at`

The active product path keeps the first one to five valid requirement cards in agent priority order. It preserves non-repeated provenance across retained cards and creates deterministic reject/delete decisions for uncited sources, including sources that occur only after the fifth returned card. The bounded policy permits up to 50 combined sources and 200 KB of agent output; genuinely malformed output remains recoverable for retry.

The schema-version-2 agent payload covers newly discovered cards and may omit ordinary contribution decision arrays. The validator derives included contribution decisions from unique card provenance, while explicit `reject` decisions remain required for omitted human sources. Level Up appends every still-unimplemented backlog card unchanged after model validation and records a deterministic `retain` decision for each one. Persisted `proposal_reconciliation_json` remains complete for auditability.

Structured agent validation errors carry a stable safe correction string separately from the public error code. Repair diagnostics identify the affected field and allowed correction without embedding request bodies, credentials, provider exceptions, or hidden reasoning. Redacted `agent_run_traces.error_detail` stores the final diagnostic for owner inspection; successful repair attempts remain visible as ordered turns in the same trace/session.

### `collaboration_votes`

- `id`
- `proposal_id -> proposals.id`
- `session_member_id -> session_members.id`
- `vote_rank` — token position from `1` through the effective owner-configured allowance
- `created_at`

Unique constraint: `(round_id, session_member_id, vote_rank)` in the target model. The current SQLite table stores `vote_rank` and enforces token replacement transactionally. Application logic lets each player keep zero to the current configured allowance of private vote tokens while voting is open; tokens may stack on the same proposal or be spread across proposals. Round snapshots carry the effective allowance, and previous payloads without it normalize to 5.

Vote totals are omitted from snapshots during `voting`. On closure the server counts one point per token. It ranks by token total descending, first-token votes descending, second-token votes descending, proposal position ascending, then proposal ID ascending and freezes the complete proposal set in `brief_json`. The first card is committed and every remaining card is ordered stretch/queue work, including zero-vote cards.

### `collaboration_builds`, `collaboration_feature_builds`, `collaboration_feedback`, and `auth_sessions`

The build record stores adapter status, whether the adapter is simulated, current stage, the full visible timeline, included/deferred proposal IDs, package-check status, release URL, previous stable release URL, and failure details. The current production adapter writes Goose-edited compiled packages under `runtime-data/releases/<project>/vN/` and stores the newest immutable `/projects/<project>/versions/vN/` URL in `release_url`. For a new project the selected template is treated as the implicit base and the first committed requirement publishes as `v2`. After that, every build input carries `previousStableUrl`, and the adapter loads that packaged source checkpoint for the next edit, so later versions remain cumulative. Release manifests record the deterministic package check and `humanReviewRequired: true`; gameplay acceptance comes from the human playtest and “game is not running” report flow rather than an agent or headless-browser acceptance loop. A package-check failure never replaces the last stable play pointer. Any voted requirement card not included in the build result is serialized into the successor round's prior-feedback context as `requirementBacklog` so later proposal generation can continue from the team's backlog instead of requiring players to restate old cards.

The accepted next build model normalizes that round-level build into per-feature-card build records. Every generated proposal receives one record in deterministic vote order, including lower-vote and zero-vote proposals. A `collaboration_feature_builds` row should store:

- `id`
- `round_id -> rounds.id`
- `proposal_id -> collaboration_proposals.id`
- `queue_position` — `1` for the active top card, higher values for the visible stacked queue
- `status` — `queued`, `reviewing`, `building`, `testing`, `succeeded`, `no_change`, `failed`, `interrupted`, or `deferred`
- `current_agent_loop` — nullable visible loop label such as `review`, `build`, or `test`; only set while real work is active
- `steps_json` — the factual agent/test events emitted for this feature, not decorative filler
- `release_url` — nullable immutable playable version for the card
- `failure` — nullable classified failure/interruption reason
- `report_count` and `latest_report_json` — player “game is not running” reports that interrupted or challenged the active loop
- `started_at`, `completed_at`, `updated_at`

The current SQLite `collaboration_builds` table remains compatibility storage until the feature queue is implemented. During the transition, snapshots may derive a temporary feature queue from `brief_json`, `included_json`, `deferred_json`, and the existing build timeline, but new UI should be designed around the per-feature shape above. Each completed feature may also carry additive delivery evidence: implementation check outcome; review outcome (`approved`, `changes_required`, or `failed`); review findings/failure; correction outcome (`not_required`, `checked`, or `failed`); correction failure; and whether the atomically published candidate was `primary` or `corrected`. Legacy feature rows without this evidence remain valid.

Publishing a successful feature atomically advances the next eligible queued feature to active work when one exists. Post-delivery player navigation (`playtest`, `wait`, or `brainstorm`) is presentation state and must not mutate queue order or stop that transition. A successor brainstorm may run concurrently with the active feature build; its new ideas cannot enter the active frozen queue and are eligible only for a later proposal/vote cycle.

Closing proposal voting atomically freezes the ranked brief and initiates the Build state; clients do not navigate to a standalone brief screen. Snapshots retain the brief for deterministic queue metadata and backward compatibility.

Every round snapshot also exposes an additive project-wide `versionHistory`, derived from all persisted prior and current round briefs plus their completed feature builds. Each entry carries its originating round, proposal identity and player-facing requirement notes, outcome (`succeeded` or `no_change`), immutable release URL, and completion time. Previous snapshots without this field normalize to an empty list; clients must not infer project history only from the current round's feature queue.

A validated but materially unchanged feature is recorded as `no_change`, receives a release/version reference that rolls the current stable source forward, and advances the queue exactly like `succeeded`. It is not treated as a failed build. Unsafe, malformed, blank, broken, or unresponsive output still fails and never replaces the stable game.

`collaboration_feedback` is retained only for read/migration compatibility with already persisted structured notes and legacy summary records. Current UI and HTTP APIs neither create feedback nor expose a feedback-close command. When a legacy `playtest` round continues through **Brainstorm New Features**, any old notes may still populate optional prior-round context; their absence never blocks successor creation.

Restart-safe sessions store only a SHA-256 hash of the random opaque cookie token, public account identity, expiry, and creation time. Logout deletes the durable record and expired records are rejected and pruned.

### `ai_runs`

Legacy source support exists for `feedback_summary` runs, fenced attempts, and durable bot messages from the removed v1 gate. The active v2 product loop no longer creates a summary run before the next brainstorm.

Source implementation update: brainstorm suggestions, proposal generation, build-run acknowledgement, and game-edit activity now use the pinned Goose ACP boundary when the application server is configured for it. New runs use the owner-admin `agentMaxTurns` setting, defaulting to 3 and bounded to 1-5; the attempt-local provider gateway enforces the same completion-call budget. The current SQLite brainstorm suggestion path commits validated bot `collaboration_contributions`; the proposal path commits only validated `collaboration_proposals` and the phase event; the build path requires a successful Goose build-run response plus validated `levelup.game.edit` HTML before publishing a local playable release. Agent failure surfaces a concrete setup or provider error and does not fall back to deterministic product output. Durable suggestion/proposal/build telemetry in `ai_runs` remains part of the target model below.

Tracks every brainstorm-suggestion, proposal-generation, or game-building invocation.

- `id`
- `project_id -> projects.id`
- `round_id -> rounds.id` — nullable for initial setup
- `kind` — `setup`, `brainstorm_suggestion`, `proposals`, `build_run`, `build`, `repair`, `validation`, `feedback_summary` (legacy)
- `goose_session_id`
- `provider` — for example `openrouter`
- `model`
- `status` — `queued`, `running`, `succeeded`, `failed`, `cancelled`
- `input_json`, `output_json`
- `prompt_tokens`, `completion_tokens`, `cost_amount`
- `started_at`, `completed_at`

### `releases`

An immutable, playable build produced for a project.

- `id`
- `project_id -> projects.id`
- `round_id -> rounds.id`
- `version`
- `git_commit`
- `immutable_url`
- `stable_url`
- `validation_status` — `pending`, `passed`, `failed`
- `validation_json`
- `published_at`

Unique constraints: `(project_id, version)` and `(project_id, round_id)`.

### `project_feature_queue` and `feature_agent_runs`

The SQLite runtime now stores the continuous queue independently of a frozen
round build. `project_feature_queue` records project, originating round and
proposal, a provenance key, waiting priority, cumulative votes, votes from the
latest round, terminal or active status, an
idempotent lease/run identity, base checkpoint, release URL, classified failure,
and timestamps. A partial unique index permits only one active row per project.
Reconciliation updates only waiting rows; active and completed rows are stable.
Current-round votes order the head of the waiting queue. Cards without a vote
in the latest round then use cumulative votes across all rounds, with stable
prior ordering as the final fallback.

`feature_agent_runs` is the durable recovery shape for workspace identity,
Goose session, phase, provider attempts, meaningful turns, empty attempts,
no-progress count, last progress time, changed files, safe diagnostics, usage,
recovery state, and completion. The terminal `project_feature_queue` row also
stores additive `delivery_json`, preserving the distinct checked implementation,
review verdict or review failure, one-correction outcome, selected candidate,
and safe findings/failures after the round snapshot changes. Previous rows with
no delivery document normalize to `null`. Source checkpoints and compiled
artifacts remain immutable filesystem objects referenced by the queue/release metadata.

The SQLite complete-loop slice does not yet use a normalized `releases` table. Its generated-release metadata is currently split between `collaboration_builds.release_url`, `projects.stable_play_url`, and the release manifest file written beside the generated `index.html`. The normalized table remains the target once the build pipeline moves from local template mutation to project worktrees, commits, and hosted artifacts.

### `credit_ledger`

An auditable record of AI credit usage.

- `id`
- `billing_account_id -> accounts.id`
- `session_id -> sessions.id`
- `ai_run_id -> ai_runs.id`
- `amount`
- `currency`
- `balance_after` — optional for prepaid credits
- `created_at`

## Important rules

### Workshop facilitation records

`group_runs` stores the owner-created workshop name, status, initial coordinated stage, creator, and timestamps. `group_run_projects` stores its ordered project selection. `group_action_audit` fences commands by a caller request ID and records the actor. `group_command_results` stores success, state-ineligible skip, or classified failure independently for every selected project. Duplicate replay queries outcomes by `(group_run_id, request_id)`, never by timestamp.

`round_captains` has at most one assignment per `(project_id, round_number)`. Round 1 is assigned when the project is created, before template voting can produce a tie; every later collaboration round has its own assignment. `round_captain_cycles` persists the current cycle number, shuffled account order, and next cursor. A deterministic SHA-256-seeded Fisher-Yates shuffle makes tests reproducible while the stored order, not browser randomness, is authoritative. The repository receives the configured owner/admin npub from the server auth/config boundary and excludes every matching account from candidate queries, historical migration, stored order, assignment repair, and snapshots. Eligible non-owner player members are preferred; a non-owner organiser is used only when no eligible players exist. Each eligible account appears exactly once before a new shuffled cycle. A member added mid-cycle joins the next cycle; a removed member is skipped, and a removed or newly recognized owner captain is replaced from the unconsumed order. With no non-owner candidate, both assignment and cycle are absent and the owner override remains an external command. Captain identity is serialized only to project members or the owner monitoring surface. Before Build, the player snapshot exposes the current round's captain; once Build starts it exposes the next round's captain for the existing successor-brainstorm action.

Client vault schema version 2 stores an AES-256-GCM identity record in `identities` and its random 256-bit device-local wrapping key in `identityUnlockKeys`. Legacy PBKDF2 records remain a valid version-1 union member until successful passphrase migration.

- A session belongs either directly to its creator or optionally to an event; an event is never required.
- Project access always derives from current team membership; knowing a project ID is insufficient.
- `POST /api/teams` accepts only Pete's verified authenticated npub; request-body identity fields have no authority. Invite redemption remains available to other authenticated accounts, and an account may have many memberships.
- Only `teams.creator_account_id` can create or delete a project or close template voting early. Only the persisted Round 1 Captain can resolve a first-place template tie through the player command; the configured owner/admin has a separate override.
- A project has at most one active build run at a time.
- Template voting accepts exactly two distinct catalogue entries per member and rejects writes at or after the server deadline.
- Closure is idempotent. A unique leader advances directly; tied first-place leaders advance only through the Round 1 Captain's choice limited to that tied set, with the separate owner/admin override retained.
- Round contribution order and phase transitions use one server-issued sequence. A repeated client event returns its original committed contribution without another event or broadcast.
- An empty brainstorm conversation receives at most one successful `lvl_up` seed contribution containing exactly two validated starter ideas. Its durable claim survives races and becomes retryable after interruption. After that, `lvl_up` suggestions require a fresh human contribution since the last bot suggestion. The normal connected-room loop uses the owner-admin configured interval, defaulting to 30 seconds; no-change checks wait 10 seconds before trying again, and repeated bot suggestion text is not committed.
- Only current team members can read or contribute to a project round. Only the organiser may close brainstorming early. A process-wide deadline scan owns autonomous expiry and startup recovery; reads remain a defensive catch-up path. A persisted claim permits only one proposal agent run to commit, and a failed run is retried explicitly rather than on every read.
- Once `selected_template_id` is set it is immutable in this spike.
- Each player maintains up to the current owner-configured proposal vote allowance as one atomic replacement set while voting is open; duplicate proposal IDs are valid so votes can be stacked. The default is 5 and the validated range is 1 to 20.
- Only the persisted captain for that numbered round can open proposal voting through the player command; the configured owner/admin has a separate override. Closing voting and starting Build retain their existing organiser/deadline authority.
- Only a release that passes validation can become the project's stable play version.
- AI cost is charged to the session's `billing_account_id`, regardless of whether the session is standalone or part of an event.
- Organisations and persistent child/player accounts are deliberately outside v1; both can be added later without changing the team/project/round core.
- Public kind-0 display metadata is shared cached presentation data and never overrides server-authoritative account, membership, role, or team state. Ordinary presentation never falls back to an npub.
- Group Mode commands are owner-authenticated, request-idempotent, audited, and commit independent per-project outcomes. A bulk failure never rolls back successful sibling projects.
- Round Captain authority is checked at the command boundary; hiding the action in the client is presentation only.


## Legacy feedback summary persistence (SQLite compatibility)

`SummaryStore` creates `ai_runs`, `ai_run_attempts`, and `bot_messages` additively. Run input is an exact versioned JSON snapshot plus SHA-256 hash: project/template, source round, every attributed feedback record, frozen brief, and simulated release including included/deferred IDs. One `(round_id, kind)` logical run has at most three manually started attempts; a unique attempt token and expiring lease fence completion. Provider/model, session ID, safe errors, timestamps, accepted output and reported usage are persisted. Unreported usage/cost stays null.

The current loop does not expose `feedback_summary` as a round phase. The Game Versions Brainstorm action creates the unique successor without requiring feedback, and legacy summary records remain readable only for old data or tests.

HTTP/WS snapshots may still normalize old summary message and feedback history, but current UI and commands do not render or mutate it and do not expose organiser retry/skip controls for a summary gate. Inputs, leases, tokens, provider credentials and stderr never enter these payloads.
