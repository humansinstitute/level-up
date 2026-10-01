# Level Up — Game Build Method

## Status

Design direction accepted for future implementation. This document describes the target game-source, checkpoint, and release model; it does not claim that the current single-file build adapter already implements it.

This design was reconciled against the live five-stage loop implemented by commits `c097ba2` and `f53d78e`. That fixed state is the starting point, not a discarded prototype.

## Current fixed state

The running product uses this player-facing loop:

```text
Brainstorm -> Review -> Prioritise -> Build -> Iterate back to Brainstorm
```

- **Review** presents the generated requirement cards.
- **Prioritise** lets players allocate votes and then moves directly into Build.
- **Build** works through the ordered feature queue. Every completed feature produces a cumulative immutable playable version.
- The Build screen exposes the starting game and all completed versions across rounds, with feature notes and direct play links.
- **Iterate** is a loop cue rather than a separate destination; players can return to Brainstorm while versions remain playable.

The target build system extends this state. It must retain the five-stage loop, cumulative feature versions, Build version panel, notes, and play links.

The project owns one continuously reprioritised feature queue. Building is background project activity rather than a phase that prevents brainstorming or play. When Prioritise completes, the highest-ranked eligible queued feature starts if no feature is already active. An active feature keeps running until it succeeds, fails, is interrupted as broken, or the organiser explicitly defers it. A later vote may reorder waiting features, but cannot silently replace active work.

## Purpose

Level Up must let a team evolve a game with an AI agent without allowing unfinished work to replace the last playable game. It must also preserve multiple complete versions so players can play, compare, revisit, or later continue from an earlier point in the game's history.

The build method therefore separates the editable game project from its immutable playable releases.

## Core concepts

- **Project source package:** the multi-file TypeScript/Vite game project owned by one Level Up project.
- **Base version:** the latest verified source snapshot from which an active feature starts.
- **Candidate workspace:** a temporary isolated copy in which Goose implements the selected feature set.
- **Feature version:** an immutable source and compiled release created when one feature validates during Build.
- **Checkpoint:** every verified feature version; it is a safe, immutable point the team can play or revisit while later work continues.
- **Release:** the immutable compiled output of a feature version, stored at its own playable URL.
- **Current playable:** a pointer to the team's preferred release. Changing this pointer never changes or deletes a release.
- **Project feature queue:** the single ordered list of active and waiting work, reconciled whenever a new Prioritise vote closes.

Goose edits candidate source. It never edits an existing release and never writes directly over the current playable game. Every successfully validated feature automatically creates a checkpoint and becomes the base for the next queued feature.

## Continuous feature queue

```text
maintain one project-wide prioritised feature queue
  -> if no feature is active, claim the first eligible queued feature
  -> build it in an isolated workspace from the latest verified version
  -> keep the active feature running unless explicitly deferred or interrupted
  -> validate and publish an immutable cumulative checkpoint
  -> automatically claim the next eligible queued feature
  -> reconcile waiting feature priority whenever a later vote closes

in parallel at any time
  -> start or join a new Brainstorm / Review / Prioritise cycle
  -> playtest the latest or any completed version
```

A feature version is the smallest published playable unit and is automatically a checkpoint. The builder does not wait for players to finish playtesting or brainstorming before taking the next eligible feature. Those activities affect later queue ordering through the next proposal and vote cycle.

For example:

```text
v3  Existing verified game
v4  v3 + pets
v5  v4 + changing weather + day/night cycle
v6  v5 + treasure quests
```

Every version remains independently playable while the queue continues. Players may open `v4` while weather is building for `v5`, and may begin a new brainstorm without cancelling that work.

## Build screen interaction

Build is an ordered list of the prioritised feature cards, not a single opaque build job. The active feature remains visually prominent, queued features remain visible underneath it, and the version-history panel remains visible alongside the queue.

The interaction rules are:

1. Closing Prioritise enters Build and starts Feature 1 automatically.
2. While a feature is running, the screen shows only real review, build, and validation activity for that feature.
3. When the feature validates, its cumulative checkpoint, notes, and play link appear in the version-history panel.
4. If an eligible queued feature exists, it starts automatically from that checkpoint.
5. **Run a new brainstorming session** is available while Build is active. It starts the collaboration loop without cancelling, replacing, or pausing the active feature.
6. **Playtest** is available for the latest or any completed version while building continues.
7. **Defer active feature** is an explicit organiser action. It stops the active agent safely, preserves the previous checkpoint, marks the feature deferred, and advances to the next eligible item.

If no queued feature remains, Build shows that the builder is waiting for prioritised work while Brainstorm and existing versions remain available.

### Reprioritisation rules

Each closed Prioritise vote atomically reconciles the waiting portion of the project queue:

- the active feature retains its lease and position until terminal or explicitly deferred;
- completed features remain immutable history and do not re-enter the queue;
- retained backlog features receive their new relative rank from the latest vote;
- newly approved features enter at their voted rank;
- a formerly next-up feature may move lower when other work receives more support;
- duplicate or combined cards retain provenance so the queue does not build the same intent twice; and
- safe explicit deletion/defer decisions remove work from the eligible queue without deleting its audit history.

Queue reconciliation is server-authoritative and idempotent. Starting Brainstorm alone does not change priority; the queue changes only when the corresponding Prioritise result commits.

## Feature build agent loop

A feature build is a persistent, goal-driven agent session against one narrow requirement card. It is not a one-shot request for Goose to guess and return the complete finished game.

The frozen feature contract supplies:

- the selected base version and source snapshot;
- one active feature card with its player-visible outcome, implementation scope, and acceptance criteria;
- the project workspace and permitted commands;
- protected behavior that must remain intact;
- build, test, and browser-playability commands; and
- the output and evidence required before Level Up may publish a version.

Within one isolated candidate workspace, Goose may repeatedly:

```text
inspect source and current behavior
  -> form or revise an implementation plan
  -> edit a bounded part of the project
  -> build and run focused tests
  -> inspect failures and browser evidence
  -> repair or improve the implementation
  -> repeat until the feature contract is satisfied or a clear failure is reached
```

The session completes successfully only when deterministic Level Up validation confirms the feature. An agent statement that the work is complete is evidence to inspect, not authority to publish.

### Build-specific budgets

Schema-oriented stages such as proposal generation may retain a small response-repair allowance. Feature implementation needs a separate budget because its turns include inspection, edits, tool calls, tests, browser checks, and repairs rather than merely correcting a JSON payload.

- A feature build may have a high safety ceiling, initially up to 100 agent turns.
- The ceiling is a guardrail, not a target and not permission to loop without progress.
- Game builds use a stage-specific elapsed-time budget sized for the intended five-to-seven-minute build, with a larger final safety cap. They must not inherit the generic two-minute structured-agent timeout.
- Token, cost, output-size, process, and workspace limits remain in force independently of the turn ceiling.
- The owner can stop a build, and Level Up can interrupt it when a player reports that the game is not running.

Useful progress should keep the session alive within its final cap. Repeated activity without source, test, or diagnosis progress must not.

### Empty responses and no-progress handling

A zero-byte or otherwise empty provider response is a provider/transport failure, not a valid implementation turn and not evidence that the feature is impossible.

Level Up should:

1. record the empty provider attempt in the run trace;
2. retry promptly under a small provider-retry allowance rather than waiting for the wall-clock deadline;
3. fail over to an allowed fallback model when configured and the repeated-empty threshold is reached; and
4. end in a clear retryable failure if bounded retry/failover cannot produce a usable response.

The loop also tracks meaningful progress, including source diffs, new diagnostics, changed test outcomes, completed acceptance checks, and new browser evidence. Repeating materially identical edits, failures, or commentary consumes the no-progress allowance and eventually stops the run with a classified failure. A 100-turn ceiling must never become 100 empty calls or 100 repetitions of the same failed approach.

### Progress and recovery

Each feature session persists enough state to survive a browser disconnect and explain what happened:

- active goal and acceptance criteria;
- base version and candidate workspace identity;
- current agent phase and last meaningful progress time;
- provider attempts and agent turns as separate counters;
- files changed and validation commands attempted;
- latest safe failure classification;
- elapsed time, token usage, and cost; and
- final source snapshot, release, or retryable failure.

The Build screen translates this into player-facing activity such as reviewing, building, testing, repairing, and validating. It should not expose raw chain-of-thought or invent progress stages. Reconnects read the persisted run instead of starting a duplicate feature session.

### Transitional and target boundaries

The current adapter asks Goose for one complete replacement `index.html` through a structured JSON response. Extending that request to 100 turns would make the existing boundary more expensive without making it a sound development workflow.

The target loop therefore runs Goose with tool access inside the multi-file candidate workspace. Goose edits files normally and returns a small structured completion handoff containing status, notes, and evidence references. Level Up—not Goose—reads the workspace, runs final validation, commits the source snapshot, and publishes the immutable release.

## Continuation

Passing deterministic validation publishes a feature version as a checkpoint and advances the stable build base. Players may play or compare any prior release, but the builder continues linearly from the latest verified checkpoint. A future **Build from here** capability may branch from an older checkpoint; ordinary playtesting does not change the build base.

## Source and release history

Every successful feature version creates two linked records:

1. A durable source snapshot, represented internally by a Git commit or equivalent content-addressed source object.
2. An immutable compiled release containing the complete deployable game bundle and assets.

The release record should identify at least:

- project and version;
- source checkpoint identifier;
- base checkpoint and base release;
- included feature IDs and their order;
- build and validation evidence;
- release artifact location and checksum;
- creation time and status; and
- whether the release is currently preferred or was superseded.

A checkpoint marker identifies the verified release and when it became the base for further work. It need not duplicate the source or compiled artifact.

The stable play URL resolves to a release record. Advancing or rolling back that pointer is a metadata operation, not a rebuild and not a destructive overwrite.

## Failure rules

- A failed candidate never replaces the latest verified checkpoint or preferred playable release.
- A failed feature may be repaired within the same candidate, retried, or explicitly deferred.
- Earlier successful versions remain playable when later work fails.
- Only deterministic validation makes a version the next build base.
- Failed candidates remain as bounded diagnostic build records, but they are not shown as ordinary playable versions.
- Published source snapshots and releases are immutable.
- Cleanup may delete disposable workspaces only after their relevant source, diagnostics, and release records are durable.

## Why the default is not feature branching

Long-lived branches for every feature would allow parallel experiments, but they also introduce merge conflicts, integration builds, and decisions that are disproportionate to the normal Level Up loop.

Sequential checkpoints provide most of the value with much less machinery:

- every accepted step is playable;
- each active feature has a known verified base;
- the cause of a regression is bounded to one feature candidate;
- there is no mandatory final integration merge; and
- players see a comprehensible history rather than a source-control graph.

Independent feature branches remain a possible advanced mode for parallel teams or competing experiments. They are not required for the default product.

## Player-facing language

Implementation details such as branches, commits, worktrees, and artifact stores should normally remain hidden. The product can use:

- **Workshop** — the temporary place where Level Up is building;
- **Playable version** — a tested cumulative version the team can open during Build;
- **Checkpoint** — a verified feature version that is safe to build from;
- **Version trail** — the history of all playable versions, including checkpoint markers;
- **Current playable** — the release opened by the main Play action; and
- **Build from here** — use a chosen checkpoint as the base for future work.

This makes the development process visible and teachable without requiring players to understand Git.

## Game package direction

The checkpoint model is independent of source layout, but it is intended to replace whole-file guessing with an ordinary multi-file game project. A representative package is:

```text
game/
├── game.json
├── index.html
├── src/
│   ├── main.ts
│   ├── state.ts
│   ├── world.ts
│   ├── entities.ts
│   ├── renderer.ts
│   ├── input.ts
│   └── systems/
├── content/
├── assets/
└── tests/
```

Goose works against this package using normal file edits. Level Up owns orchestration, permissions, feature selection, validation, checkpoint creation, release publication, and the current-playable pointer.

## Product boundary

The game package owns gameplay code, content, assets, and game-local state. Level Up continues to own teams, projects, rounds, ideas, proposals, votes, the project feature queue, checkpoints, releases, validation, and credit usage.

Persistent or multiplayer games may use a constrained game-data API, but game-specific business logic must not be added to Tower. Tower remains the persistence capability boundary for Level Up records rather than becoming the game engine.

## Initial implementation boundary

The first implementation of this design should support:

- one canonical source history per project;
- one active candidate build per project;
- one continuously reconciled project-wide feature queue;
- automatic claiming of the highest-priority eligible feature when no feature is active;
- active-feature stability across later brainstorm and vote cycles unless explicitly deferred;
- atomic reprioritisation of waiting work after each later Prioritise result;
- immutable source and compiled releases for every successfully validated feature;
- an automatic checkpoint for every successfully validated feature;
- concurrent Brainstorm, Review, Prioritise, and playtesting while the builder remains active;
- explicit defer/interruption as the only ordinary way to stop an in-progress feature;
- a persistent, build-specific Goose session for each active feature;
- a separate feature-build turn ceiling of up to 100 turns rather than the generic structured-response repair limit;
- stage-specific elapsed-time, cost, no-progress, provider-retry, and failover limits;
- persisted progress and reconnect-safe recovery for the active feature session;
- a stable current-playable pointer with rollback;
- a visible Build version trail containing the starting game, cumulative versions, feature notes, play links, and checkpoint markers; and
- retained failure diagnostics without exposing failed candidates as playable releases.

Parallel feature branches, merging independently developed candidates, and branching permanently from an older checkpoint are later capabilities rather than prerequisites for the sequential checkpoint loop.
