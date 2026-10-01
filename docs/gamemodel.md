# Level Up — Collaborative Game Model

## Product idea

Level Up lets a persistent team create and evolve one or more mobile web game projects with an AI coding agent. Players choose a starting template, discuss improvements, vote on a direction, receive a tested new build, play it, and repeat. The experience teaches collaborative product development through rapid, visible iterations.

The website is the source of truth for participants, teams, projects, votes, rounds, releases, and credit usage. Goose is an execution worker: it receives a bounded brief and changes a project-owned game workspace through ACP.

## Participants

- **Account holder:** creates events or standalone sessions and supplies or purchases AI credit.
- **Facilitator:** manages the pace of a session and can moderate, pause, retry, or end it.
- **Team:** a persistent group of Nostr-authenticated people that may own multiple projects.
- **Project:** one evolving game and, in v1, its collaborative room. It owns template, phase, rounds, repository/release references, and stable play URL.
- **Build:** one generated, immutable project release/version; it is never another name for the project.
- **Player:** joins a team, contributes ideas, votes, and playtests its projects.
- **Agent:** turns discussion into feasible proposals and implements the selected work.

One person may be both account holder and facilitator.

## Team and project shape

A team outlives a workshop and can start several projects. A project is the v1 collaborative room; there is no separate scheduled-session UI in this spike. The domain can later attach facilitated sessions or events to a long-lived project without moving game ownership back onto the team or session.

Every curated template and generated successor must remain playable with keyboard and directional swipe input. Its pre-game surface presents concise controls for the current input context, updates after an input-mode change on hybrid devices, and keeps start/restart actions available without relying on user-agent detection.

Village Games ships as a complete five-day authored starter arc. Daily required quests advance the visible day, rotate residents and visitors, and preserve consequences from earlier work. Rowan's unique Lantern and Picnic Basket remain in inventory after use and unlock named later quests; the first-day economy funds the Lantern, while alternate quest order and shortage guidance prevent purchase dead ends. Village NPCs wander only within bounded home areas, stop while a conversation or shop interaction is open, and remain stationary when the player is close enough to act.

In the current WApp spike, players authenticate either with a NIP-07 signer or a Nostr identity generated and encrypted entirely in their browser. Both paths sign the same one-time server challenge. A verified, normalized Nostr hex pubkey maps to one stable internal account. For now only Pete's verified npub may create teams; every authenticated account may still redeem a QR/link invite. Optional restricted-preview mode can limit which npubs may sign in.

Public player presentation comes from the newest verified Nostr kind-0 profile available on the configured relays. Level Up persists a sanitized shared cache through its existing application persistence boundary and hydrates it into authenticated team and project snapshots. The client displays `display_name`, then `name`; when neither is available it uses a friendly deterministic player nickname and avatar, never an npub in ordinary player UI. Only HTTPS profile pictures are retained. Relay or cache failure never prevents authentication, invite redemption, or team/project entry.

The broader product may later add guest/display identities, but team membership in this spike is attached to the authenticated Nostr account so redemption is idempotent and survives restarts.

## Implemented team and invite flow

1. Pete's verified authenticated account may create a named team; any authenticated account may supply an invite, and one account may own or join several teams.
2. Team creation is rejected at the API boundary for every other npub and atomically creates the team, creator membership, and active reusable invite when authorised. Existing spike `game_sessions` and `session_members` rows remain compatibility containers only and do not represent a game.
3. A team lobby lists its current Nostr members and all projects. Only the account recorded as the team's creator can create a named project or delete old team projects from Avatar Menu > Manage My Games; other members can enter projects.
4. Every team member can always share the current high-correction QR or copy the fragment URL. New and rotated invites use a case-sensitive six-character alphanumeric public code. The code is retained as the invite's public lookup identifier while its SHA-256 digest remains the redemption credential check; legacy long hash-only links remain redeemable.
5. An invited visitor keeps `#join=<secret>` through NIP-07 login. The authenticated client explicitly redeems it, clears the fragment only after success/idempotent success, and shows that team's lobby.
6. Rotation revokes earlier active links. Multiple different accounts can redeem the current link; the same account can join only once.
7. The shared header returns from team and project views to the complete team chooser so an account can move among every team it owns or has joined.

## Core loop

```text
Team lobby -> create/open Project
  -> Project template selection
  -> Brainstorm
  -> Review requirement cards
  -> Prioritise with vote tokens
  -> Build and validate cumulative versions
  -> Iterate visually back to Brainstorm while versions remain playable
  -> Showcase
```

### 1. Template selection

Project members can view four curated, self-contained starter packages and vote for a starting point: **First-Person Shooter — Citadel Strike**, **Platformer — Skyline Sprinter**, **World Builder — Village Games**, and **Arcade Cabinet — Snake, Minotaur Maze & Tennis**. A template is a working mobile-first game rather than a blank project, so the first playable result arrives quickly.

Project creation first opens an untimed try-the-games stage. Every member can play every preview without a countdown or voting controls, so the group experiences the starting options before brainstorming or ranking them. At creation the server also persists the randomly assigned Round 1 Captain, early enough for that player to resolve the initial selection. When the group is ready, the organiser starts the server-authored 176-second (`02:56`) selection window. Every member then submits exactly two distinct favourites as an atomic replacement set. Visible top-three totals come from server snapshots. The organiser may close early; deadline reads also close expired voting. A unique leader is selected automatically, while a first-place tie moves to the Round 1 Captain's choice among tied leaders. Pete retains a separate owner/admin override; organiser status alone does not grant the choice. The chosen template is immutable and advances the project to the Round 1 brainstorm screen.

Arcade Cabinet is one project package rather than three templates. A team may evolve Snake, the Pac-Man-like Minotaur Maze, Tennis, several games together, or their shared cabinet menu and reward shell. Historical projects based on the retired standalone maze, snake, pong, and frogger records keep their original playable package and may continue evolving, but those records are not offered to new projects.

### 2. Initial setup and brainstorm

After the template is selected, the agent prepares a project workspace in the background while players brainstorm the theme, characters, objective, rules, and first changes. The first discussion lasts about five minutes.

In v2 `lvl_up` joins the brainstorm as a real Goose-backed collaborator. While players are connected to the project room, the server checks the ordered chat every admin-configured N seconds, defaulting to 30. An otherwise empty human conversation receives one durable `lvl_up` contribution containing exactly two distinct, concise starter ideas grounded in the selected template plus prior feedback and unbuilt backlog when present. A persisted seed lease, fixed idempotency key, and restart recovery allow only one successful seed across sockets, reconnects, timers, and retries. After that seed, the agent is eligible only when a new human contribution has arrived since the last bot suggestion; bot-only content cannot trigger another call. If no human-visible change is found, the server backs off for 10 seconds before checking again. Level Up commits later useful yes-and nudges into the same ordered stream and suppresses repeated suggestion text. If Goose setup, execution, or schema validation fails, the room stays open with durable actionable retry status instead of invented fallback copy. Seeds and nudges are advisory only: they do not create proposals, cast votes, close phases, or change the build brief.

The collaboration loop creates exactly one durable numbered round when the template is final and one successor when the authorised player uses **Brainstorm New Features** after Build starts. Members submit lightweight ideas with client event IDs; a brainstorm contribution may include typed or pasted screenshot image attachments shown as thumbnails in the same chat bubble. The server commits their order and streams resulting events to every connected project client. Bot suggestions are also durable ordered contributions, labelled `lvl_up`, and replay through the same WebSocket/HTTP catch-up path. A server-wide durable deadline runner closes brainstorming and invokes the Goose-backed proposal generator even with no connected client; the organiser may use the same path to close early. A persisted generation lease makes timer, read, reconnect, restart, and manual triggers idempotent while the agent is running. The application server sends the selected template, all ordered human brainstorm contributions, and the unbuilt requirement backlog to the proposal agent. Legacy persisted feedback may be read as optional context when continuing an old project, but no current workflow creates it. The application, not the model, owns the complete unbuilt requirement backlog carried forward from earlier voted cards.

Proposal output uses schema version 2. Every human contribution receives exactly one `include` or safe `reject` decision. Goose returns up to five newly discovered cards; Level Up then appends every still-unimplemented backlog card unchanged, with its prior proposal identity in provenance. New cards, carried cards, and the decision audit commit atomically. A failed setup, provider call, timeout, or validation keeps all inputs unchanged, records a player-safe error, and leaves an organiser retry action; production never fabricates local fallback cards.

The room UI keeps a visible round progress rail, current-player identity cue, live phase-update banner, and concise agent-boundary note so players can tell whether Level Up is waiting on people, LvlUP feedback, voting, or build activity. Requirement cards show the source idea snippets behind their numbered references so the agent output remains traceable to the team's discussion.

### 3. Proposal generation

At the end of the brainstorm, the proposal agent:

- reads only the current project's discussion and game state;
- combines duplicate or overlapping new suggestions while preserving every source reference and the combined intent;
- clarifies vague ideas without changing their intent;
- rejects or defers unsafe or infeasible requests; and
- returns the highest-priority one to five distinct requirement cards, ordered most important first and combining related ideas without filler.

Each card includes a short title, player-facing explanation, implementation scope, and testable acceptance criteria.

The runtime accepts at most 50 human contribution sources, keeps the first five valid new cards in agent priority order, and has a 200 KB agent-output ceiling. Every still-unimplemented backlog card is appended outside that cap and cannot be silently removed by proposal generation.

### 4. Voting and round brief

Each player has the owner-configured proposal vote allowance, defaulting to five tokens. The allowance is a whole number from 1 to 20 and is included in the authoritative round contract. Players may stack all tokens on one proposal, spread them across ideas, remove a token, and reallocate it while voting is open. Totals remain hidden until the voting period closes.

That round's persisted Round Captain explicitly opens Prioritise after the shared Review step. Pete retains a separate owner/admin override, while organiser status alone does not open voting. The organiser may still close voting early; the server deadline may also close it. Ties use one stable rule: vote tokens descending, first-token votes descending, second-token votes descending, proposal creation position ascending, then proposal ID ascending. This ordering is frozen with the internal brief and returned identically to every member. Closing Prioritise starts Build immediately; the frozen brief remains an internal contract rather than a separate player destination.

The resulting build brief contains every new and carried requirement card. Cards receiving votes in the current turn come first in deterministic vote order. After those, zero-vote leftovers use their cumulative vote totals from all prior rounds, so an older card retains the team's earlier preference even when nobody spends another token on it this turn. Voting prioritises work rather than excluding it.

The cards become an ordered feature queue rather than one opaque build blob. The highest-voted card is the active feature card; all lower-ranked cards remain visibly stacked underneath as queued work. The brief is frozen before building begins so the agent is not chasing a moving target.

### 5. Build and release

Each project owns one Git repository:

- `main` is the last accepted source state;
- `.worktrees/round-<n>` is the isolated workspace for the current round; and
- every successful round produces an immutable hosted version.

The target release pipeline is:

```text
create round worktree
  -> implement committed work
  -> attempt compatible stretch work
  -> deterministic package build/checks
  -> human play validation
  -> commit
  -> fast-forward main
  -> publish immutable version
  -> update stable play pointer
```

The target is a short implementation pass followed by deterministic packaging. Level Up freezes the checked primary candidate before an independent review returns `approved` or `changes_required`. Approval publishes the primary. Review timeout, provider failure, or invalid output is recorded as a review failure and falls through to the checked primary rather than becoming an implementation failure. `changes_required` permits exactly one corrective build from the frozen primary; a checked correction is published without another review, while a failed correction falls back to the checked primary. The previous stable release remains unchanged until the selected candidate passes its deterministic checks and publication completes. Human players validate gameplay from the packaged version.

For the current complete-loop milestone, brainstorm suggestions, requirement-card generation, and the build-run activity use the Goose ACP boundary whenever the managed runtime has an OpenRouter key, model, and valid Goose binary. No separate agent-enabled feature flag is required. If any of those agent steps cannot run, Level Up keeps the room in a recoverable failed or retryable state with the concrete setup problem instead of silently substituting fake output.

The build adapter remains replaceable. The production server runs one feature card at a time through one implementation request. Before distinct work steps, Goose emits an explicitly marked, player-safe progress summary as ordinary agent output. Level Up streams only those summaries and never raw internal reasoning or tool-call payloads. The room presents the active feature card in a left column, with the remaining queued cards stacked below it, and presents the live build cycle for that card to the right. The build cycle shows only work actually happening: agent review/editing and the deterministic package check. Gameplay validation belongs to the human playtest, not another agent loop. Do not invent preparatory or decorative stages just to fill the rail.

When a feature card validates, Level Up writes an immutable release under `runtime-data/releases/<project>/vN/`, attaches a “Play this feature” link to that card, updates the stable play pointer, and immediately starts the next queued feature card in the background when one remains. The Build view also keeps a version panel containing the starting game and every completed feature version available in the snapshot, with its requirement outcome/status and a direct play action. Delivery never pauses the feature queue to wait for a player choice. Each card can therefore produce its own playable version (`v2`, `v3`, and so on) rather than hiding all progress behind a single round-level release. Versions are cumulative by default: `v4` is an extension of `v3`, `v3` is an extension of `v2`, and every later build starts from the latest verified stable game unless a future user choice explicitly selects a different base version. Remaining feature cards stay queued or deferred with their visible status, then carry into the next brainstorm as requirement backlog unless new playtest feedback supersedes them.

As soon as Build starts, every player can use **Brainstorm New Features** in Game Versions to open the next idea round; no feature delivery is required first. After a release is delivered, **Play test** opens that version and **Wait for the next feature** keeps the live build progress in view. These choices change what the player does, not what the builder does. Starting or joining a brainstorm must not cancel, replace, reorder, or delay the already-selected background feature; newly brainstormed work enters a later proposal and vote cycle.

The production server gives Goose one narrow feature contract in an isolated,
multi-file project workspace. Its ACP session enables only the developer extension and a small allowlist of workspace tools, uses a feature-specific completion budget large enough for reasoning plus an action, and requests low reasoning effort from OpenRouter. Goose gets one implementation request, inspects and edits ordinary files, runs the documented package build/tests, and returns one compact evidence handoff. Level Up accepts plain or markdown-fenced valid handoffs and never sends a generic continuation request after completion. Level Up independently runs the deterministic package check and publishes paired immutable source and compiled release snapshots for human play validation; it does not ask an agent to validate or repair the completed feature. A no-change result is accepted only when the unchanged source and feature-specific evidence prove the outcome already exists. Legacy whole-HTML `levelup.game.edit` records remain readable but that response generator is no longer invoked by the production builder.

At any point during building or playtest, a player can report that the game is not running. That report interrupts the active build loop, records the failure against the current feature card/version, keeps the previous stable playable release available, and gives the organiser a retry or defer path. The agent cannot ignore the interruption and continue publishing as if the version were accepted.

Each project receives:

- an immutable URL such as `/projects/<project>/versions/v3/`; and
- a stable `/projects/<project>/play/` URL that resolves to the latest verified version.

### 6. Play and iterate

Completed releases remain available in Game Versions and open separately from the collaboration room. There is no standalone playtest destination, structured feedback form, feedback count, or organiser close gate. **Brainstorm New Features** is the sole product action for continuing iteration and can open the successor brainstorm as soon as Build starts, including from a legacy persisted `playtest` phase. The independent **Game is not running** report remains available during Build completion because it interrupts a broken release rather than collecting design feedback.

### 7. Showcase

Each project has a stable game URL plus a version timeline showing how its game evolved. A future facilitated session can end its active loop and present the latest verified release or revisit earlier versions without ending the team or project. Later rounds may ask players which version they like best and what to build from next; until that branch choice exists, the build base is always the current stable release.

## Application architecture

## Workshop onboarding and facilitation

Workshop players may create a deliberately throwaway Nostr identity without a passphrase. A fresh random wrapping key and the encrypted nsec remain in separate IndexedDB records on that browser and never reach Level Up's server. Returning visits auto-unlock. Version-1 passphrase vaults remain unlockable and migrate only after a successful legacy unlock; forgetting a player removes both records. Invite fragments remain pending until authenticated redemption succeeds.

New device players receive a curated two-word nickname that they may edit, an optional short bio, and explicit guidance not to enter a full name or personal details. Level Up does not collect a photo or avatar URL for this flow. It derives the same branded local avatar from the verified pubkey everywhere while retaining adjacent text labels.

Owner Group Mode persists a selected set of projects and coordinates only their initial play, template vote, and first-brainstorm launch. Each bulk command is idempotent and records a result per project, so one blocked team does not stop the others. Once the initial brainstorm is open, each project continues independently unless the owner pauses the group run.

At project creation, the server starts a persisted shuffled Round Captain cycle and assigns Round 1. The configured Level Up owner/admin is never eligible and is removed from historical assignments and stored orders even when that account is a member, creator, or organiser. Every remaining eligible player member captains exactly once before the server creates and persists a newly shuffled order; a non-owner organiser is a fallback only when there are no eligible players. Mid-cycle additions enter the next cycle and removals are skipped or safely replaced without resetting already-consumed places. If no non-owner candidate exists, the project has no captain. A round's captain resolves an initial tied template selection for Round 1 and opens that round's proposal vote; the next round's captain retains the existing discretionary authority to start that successor brainstorm. Ordinary contributions, votes, playtests, failure reports, voting closure/build transitions, and deadline transitions remain unchanged. Pete's owner override is an administrative command outside the cycle and never inserts the owner into its persisted order.

The player and facilitator application is a Vite-built React and TypeScript client. It uses Dexie/IndexedDB for cached project data, drafts, pending messages, and reconnect state. Postgres remains the target authoritative shared store. The current SQLite collaboration slice persists all numbered-round state and uses a cookie-authenticated WebSocket gateway for live convergence, with HTTP snapshots/catch-up after missed events. Authentication sessions are restart-safe SQLite records keyed only by a SHA-256 hash of a random opaque cookie token and bounded by expiry. The template-selection spike alone retains an explicitly bounded two-second snapshot refresh while a vote or tie-break is active; actions refresh immediately.

The frontend compiles to portable static assets. It does not depend on Next.js, Vercel, server-side rendering, or a framework-specific hosting platform.

## Agent execution boundary

For each agent task, the TypeScript application server creates an `ai_run`, records a frozen input brief, and asks a Goose ACP process to execute it inside the project's permitted workspace.

The integration should use ACP session and progress events rather than treating terminal text as the API. The website translates ACP updates into simple states such as queued, analysing, coding, testing, publishing, complete, and failed. OpenRouter is the model provider and the resulting token/cost data is written to the credit ledger.

The agent must not own business state. It cannot decide who is in a team, alter votes, charge an account, or publish an unverified build. Those decisions remain in the web application and deterministic release pipeline.

Structured proposal and conversation tasks may use bounded field-level correction in the same Goose session. Feature implementation is deliberately different: it receives one request, accepts a valid plain or fenced completion handoff, and never sends a generic continuation or agent-validation request. Player-visible failure copy remains short and safe; owner monitoring retains the redacted correction detail and chronological model turns.

Proposal input is intentionally compact: selected template text, allowed human contribution sequences and bodies, prior feedback text, and allowed backlog IDs/card content. Account IDs, npubs, timestamps, round IDs, and client event IDs are not model obligations. Proposal cards are the ordinary provenance authority. Level Up deterministically derives `include` and `retain` audit facts from each card's cited sources; the agent supplies explicit decisions only for sources it rejects or deletes. Missing reference arrays normalize to `[]` only when the corresponding allowed source set is empty. Foreign sources, duplicate coverage, unsafe output, size violations, and invalid state changes remain hard failures.

Starting proposal generation is asynchronous at the HTTP boundary. The close command claims and persists the generation lease, returns an accepted snapshot with `proposalGeneration.status = running`, and completes through the existing persisted snapshot, realtime event, and polling recovery paths. Retried close requests remain idempotent while the same lease is active.

The current Goose prompt/validator boundary accepts either the canonical JSON payload or an explicit Level Up schema-call envelope such as `{ "api": "levelup.proposals.submit", "payload": ... }`. The envelope is treated as a typed handoff into Level Up validation, not as permission for the agent to mutate app state directly. Invalid envelopes remain retryable agent-output failures rather than product fallbacks.

Live playtest diagnostics use structured, secret-safe managed-app logs and an owner-only in-app admin browser. Goose calls and local release builds emit `[levelup]` JSON records correlated by project ID, round number, stage, version, proposal ID where available, validation evidence, classified failure, and timing; prompt and response bodies never enter those logs. Every Goose ACP monitoring run is also persisted in the Level Up SQLite database from its initial running state through each transcript mutation and terminal outcome. The owner can inspect the exact compiled input after redaction, each provider model turn in chronological order, and the final validated or parsed Level Up schema/API payload as distinct values, alongside runtime metadata. Credentials, cookies, signed events, invite/private keys, provider keys, callback tokens, and runtime environment payloads are recursively removed before persistence and again before API serialization. Existing per-item and per-run byte ceilings remain explicit; run records are not automatically count-pruned, so rebuilds and restarts do not erase history. Older records do not fabricate transcript fields that were never captured.

## Template contract

Every game template should provide:

- a known build and test command;
- a mobile-first playable preview;
- a template-specific agent instruction file;
- clearly editable and protected areas;
- examples of safe changes;
- a deterministic package build/check plus a human playtest path; and
- a release output directory suitable for immutable hosting.

Content-heavy templates, such as living worlds, should keep characters, dialogue, quests, locations, and rewards in structured data so most rounds change content rather than the engine.

## V1 boundaries

- Games are single-player experiences shared by the team; live in-game multiplayer is deferred.
- The team-invite spike uses stable Nostr accounts. A device-local account is a full but deliberately throwaway Nostr identity: losing its browser storage makes it unrecoverable unless it was separately backed up outside Level Up.
- The agent may post short `lvl_up` suggestions during brainstorming, but it cannot advance phases, create proposal cards before closure, vote, or alter the build brief.
- Owner Admin mode is restricted to the configured owner npub and lets the owner browse projects and recent redacted agent runs, including their compiled model input, ordered model outputs, and final Level Up boundary payload; inspect and edit the Goose ACP prompt templates used by active agent stages; configure the live brainstorm suggestion interval, proposal vote allowance, and Goose max turns; and permanently delete any project or team through explicit owner-only endpoints. Project deletion removes its collaboration/build metadata and local artifacts while retaining its team. Team deletion atomically removes the team, its memberships/invites, every project, and all project-owned metadata, followed by path-scoped local artifact cleanup. Active realtime/build publication is stopped before either deletion. Proposal votes default to 5 with a range of 1 to 20; the default max-turn budget is 3 with a range of 1 to 5. It does not expose provider keys, private credentials, unredacted ACP traffic, or player-authority controls.
- One builder works on one round worktree at a time per project.
- Only verified releases become playable through the stable URL.
- Scheduled events and facilitated sessions around projects, plus organisations, classrooms, and leagues, are deferred.
- Safety controls limit filesystem access, commands, network destinations, generated content, resource consumption, and model spend.

## Recommended implementation shape

Use TypeScript for the standalone website, API, realtime session state, and ACP client. Run Goose as a separate managed process or service rather than embedding its Rust internals. This keeps the product code in one language while preserving a clean protocol boundary around the agent runtime.
