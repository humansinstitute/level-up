# Level Up design system

This document is the visual and interaction source of truth for Level Up. Read it before changing any user-facing layout, component, copy hierarchy, colour, animation, or responsive behavior. Product and architecture decisions remain authoritative in `gamemodel.md`, `datamodel.md`, and `architecture_decisions.md`; update this document when the accepted visual language changes materially.

## Design intent

Level Up should feel like a friendly collaborative game workshop: tactile, block-built, energetic, and clear enough to operate around a table on phones. It is playful without becoming toy-like, and technical system state is translated into ordinary player language.

The visual signature is:

- deep charcoal rooms with warm paper work surfaces;
- chunky, square-edged cards and voxel-like offset shadows;
- lime for forward progress, orange for facilitation and emphasis, rose for destructive/error states, and sky for supporting identity accents;
- bold display headings paired with compact monospaced labels;
- one obvious primary action and an honest waiting state in every phase.

Preserve this signature across screens. New surfaces should look like part of the same workshop, not a new mini-site.

## Colour tokens and approved pairings

Use semantic CSS tokens. Palette colours are not interchangeable text colours.

| Role | Token | Value | Use |
| --- | --- | --- | --- |
| Dark canvas | `--surface-canvas` | `#171713` | Page background |
| Dark panel | `--surface-dark` | `#25251e` | Cards and rooms on the canvas |
| Light work surface | `--surface-light` | `#fffdf3` | Proposal, brief, and structured work panels |
| Text on dark | `--text-on-dark` | `#f9f2dd` | Primary dark-surface text |
| Muted text on dark | `--text-muted-on-dark` | `#b8b3a3` | Supporting dark-surface text |
| Text on light | `--text-on-light` | `#171713` | Primary light-surface text |
| Muted text on light | `--text-muted-on-light` | `#5d5b52` | Supporting light-surface text |
| Accent on dark | `--accent-on-dark` | `#d7f64a` | Progress, focus, and small labels on dark |
| Accent on light | `--accent-on-light` | `#566300` | Small labels and links on light |
| Facilitation | `--orange` | `#ff8a3d` | Organiser actions and emphasis on dark |
| Error | `--rose` | `#ef5e63` | Failure/destructive emphasis on dark |
| Supporting accent | `--sky` | `#87c8bf` | Avatars and decorative identity accents |

Required surface pairs:

- dark canvas/panel → `--text-on-dark`, `--text-muted-on-dark`, or `--accent-on-dark`;
- light/paper panel → `--text-on-light`, `--text-muted-on-light`, or `--accent-on-light`;
- lime/orange primary control → `--text-on-light`;
- never place paper text or lime text on a paper/white surface.

The core pairs exceed WCAG AA: ink on paper is approximately 16:1, lime on the dark panel 12.6:1, muted text on the dark panel 7.3:1, and the dark lime accent on the light surface 6.5:1. Meet at least 4.5:1 for normal text and 3:1 for large text and non-text interactive boundaries. Do not rely on font weight, shadows, or a border to rescue a failing text/background pair.

Every component that changes its background must set or inherit the matching semantic foreground in the same rule. Check nested headings, labels, links, details, placeholders, disabled states, and icons—not only body copy. The proposal screenshot attached to the September 3 review is the canonical failure example: a light work surface inherited the dark-room paper foreground, making every proposal nearly unreadable.

## Typography and hierarchy

- Use the existing system sans stack for player-facing headings and prose. Do not add a web-font dependency without an explicit product decision.
- Use the monospaced stack for eyebrows, counts, phases, connection state, timestamps, and compact system labels only.
- Page title: bold, tight, responsive with `clamp()`, and never truncated when it names the project or team.
- Section title: one clear level below the page title; avoid competing jumbo headings inside a room.
- Body copy: comfortable line height between 1.45 and 1.7 and a readable measure around 45–75 characters.
- Uppercase plus wide tracking is reserved for short labels. Never use it for paragraphs or instructions.
- Link meaning must remain visible without colour alone; retain underline or an explicit arrow/action treatment.

## Spacing, shape, and depth

- Base spacing rhythm is 4px. Prefer 8, 12, 16, 24, 32, and 48px steps.
- Minimum touch target is 44×44px. Primary phase actions should be at least 52px tall on mobile.
- Outer app cards may use 20–26px rounding. Work panels and game cards stay square or lightly rounded; do not mix many radius styles in one surface.
- Use borders to establish structure and voxel-like offset shadows to indicate elevation or commitment. Avoid soft glass effects on essential content.
- Decorative ambient colour must sit behind content and must not alter the computed contrast of text or controls.

## Layout and responsive behavior

- Design mobile-first from 320px upward. No horizontal scrolling for ordinary content.
- Collapse multi-column forms, build stages, and card grids to one column before labels or controls become cramped.
- Use `minmax()` grids for repeatable cards; avoid fixed card widths that create clipped text.
- Preserve the action order and information hierarchy between mobile and desktop. Responsive layouts may rearrange space, not meaning.
- Keep the current phase, connection state, primary action, and waiting explanation visible without requiring players to interpret decorative UI.
- Respect safe areas, dynamic viewport height, zoom up to 200%, and reduced-motion preferences.
- On coarse-pointer Village Games layouts, group directional controls on the left and the contextual action on the right. Keep both groups inside safe areas with 44px minimum targets, retain swipe input, and avoid covering the central play area in portrait or landscape.
- Page shells and dialogs remain vertically scrollable when the visual viewport shrinks. Form controls use scroll margins, mobile-safe text sizing, and in-dialog actions that remain reachable while the on-screen keyboard is open. Opening a form or dialog must not autofocus a field and unexpectedly summon the keyboard.

## Reusable component rules

Prefer existing components and shared class variants before creating screen-specific markup. When a pattern appears twice, extract or extend a reusable component rather than cloning it.

Canonical patterns are:

- `AppHeader` for identity, team navigation, profile actions, and the Avatar Menu > Manage My Games entry;
- dark room/card and light work-panel surface variants;
- `section-heading` plus `eyebrow` for hierarchy;
- primary, secondary/text, organiser, and destructive button variants;
- shared form labels, inputs, textareas, status text, and focus treatment;
- phase badge, countdown timer, connection badge, and waiting state;
- proposal/result card, member row/avatar, build step, and shared conversation bubble.

The shared conversation bubble is the canonical repeated pattern for brainstorm ideas and future chat. It is avatar-led and compact, with one author heading, a wrapping content region, and a small metadata/delivery region. Brainstorm bubbles may include pasted or uploaded screenshot thumbnails directly under the text, using stable 4:3 crops that open the full image. Committed records show their authoritative sequence plus `sent`; browser-local records use visibly distinct `pending` or `failed` states, and failed records provide 44px-minimum Retry/Dismiss actions. The bubble resolves the server-hydrated sanitized HTTPS public profile first and falls back to the deterministic friendly player nickname/avatar when its name or image is unavailable. It never uses an npub as ordinary author copy.

A reusable component owns all of its states: default, hover, focus-visible, active, selected, disabled, pending, failed, empty, and narrow-screen behavior where applicable. Avoid styling by incidental DOM position when a semantic class or component variant is clearer. Do not make a decorative badge resemble a disabled navigation button.

The team chooser always preserves invite joining and lists every team the account owns or has joined. Only Pete sees the actionable team-creation form while that policy is active; other accounts see concise restriction copy in the same dark card. Team and project views expose `All teams` in `AppHeader`. Project creation appears only for the team creator; members see neither the creation component nor an organiser-only substitute message.

Every Team page keeps the complete paper `Scan to join` surface visible after reload and navigation: high-correction QR, current six-character code in the live-origin fragment URL, and a labelled copy action. All members may share it; only the team creator sees Rotate. The QR retains its quiet paper border and the link remains readable and selectable at phone widths.

## Interaction and accessibility

New projects open on an untimed `Try the games` state before template voting. Show all playable preview cards and their play links, with no countdown badge, ranking, or favourite controls. The organiser gets one clear, layout-safe `Start Voting` action after the gallery; other members get a waiting explanation. The introduction says that players should try the games before selecting one to build on and improve. Only after that action may the countdown, live top three, two-favourite controls, and early-close action appear. Starting voting must update every client through the existing bounded project refresh without requiring a page reload.

Every app surface ends with the quiet linked credit `Vibed with Love by Otherstuff.ai`. Verified Nostr kind-0 display names and HTTPS pictures take precedence wherever available. The branded deterministic avatar and curated nickname are the friendly fallback for any player whose verified public profile is unavailable; they never replace an available verified extension profile and ordinary UI never substitutes identity text.

- Every phase exposes one obvious next action for the authorised player or a specific waiting explanation.
- Use semantic buttons, links, headings, lists, forms, labels, and live regions before adding ARIA.
- Keyboard focus must be visible with a 3px outline and must not be clipped by overflow.
- Colour is never the only signal for selection, status, success, or failure; pair it with copy, iconography, shape, or state labels.
- Error copy says what happened and what the player can do next. System implementation details belong in logs, not the primary UI.
- Images require useful alternative text when informative and empty alternative text when decorative.
- Motion communicates state but cannot be required to understand it. Preserve the reduced-motion override.

## Change and review checklist

Before committing a visual change:

1. Identify the semantic surface and use its approved foreground tokens.
2. Reuse or extend the canonical component; document a genuinely new pattern here.
3. Inspect the affected state at 320px, a common phone width, and desktop width.
4. Check default, interactive, selected, disabled, empty, loading, and error states that the change touches.
5. Verify normal text ≥ 4.5:1, large text and interactive boundaries ≥ 3:1, keyboard focus, 200% zoom, and reduced motion.
6. Add a focused regression check for any bug being fixed. Contrast regressions should assert semantic surface/foreground pairing and receive visual inspection.
7. Run `bun run check` and `git diff --check`. The isolated build rule in `AGENTS.md` still applies.

After an explicitly approved activation, smoke-test the real route and phase on the managed URL. A source screenshot or passing unit test is not evidence that the live colour cascade is correct.


## lvl_up bot conversation entries

The shared conversation bubble also supports server-authored `bot` and `system` identities. `lvl_up` has a persistent BOT label and the bundled version-1 voxel avatar (`/avatars/lvl-up-voxel.webp?v=1`); a deterministic inline robot replaces failed images. Adjacent visible names make the avatar decorative. Bot/system bubbles do not show human sent/retry labels.

During brainstorming, `lvl_up` suggestions appear inline in the ideas conversation with the same compact bubble shape and ordered metadata as player ideas. They should read as lightweight prompts, not phase controls or proposal cards. Keep them visually part of the chat stream rather than a separate assistant panel.

When the human conversation is empty, the inline empty state says that `lvl_up` is preparing two starter ideas while the durable seed is running. A failed seed keeps the contribution form usable, shows player-safe retry status, and explains that Level Up will retry while the room stays open. The successful seed is one ordinary `lvl_up` bubble containing two clearly numbered concrete ideas; do not render a separate assistant card or two synthetic chat authors.

Brainstorm copy must say that the server deadline closes the room automatically. The organiser action is labelled as an early close, not as a required continuation step. While proposal generation runs, replace the brainstorm workspace for every player with a dedicated paper progress surface that says proposal cards are being prepared. The initiating organiser sees it immediately on submission, before the authoritative running snapshot arrives, and every other connected player receives that running snapshot over the project WebSocket without refreshing. It uses a restrained card-making animation and varied friendly status lines at roughly ten-second intervals, without claiming exact backend stages or percentages; its live status is polite and its motion becomes static under reduced-motion preferences. Completion remains server-authoritative. If the agent fails, restore the brainstorm surface with the preserved ideas/backlog, player-safe concrete error copy, an organiser retry action, and a clear waiting explanation for everyone else.

Game Versions owns post-delivery play and iteration. Do not render a separate completion or playtest panel, structured feedback fields, feedback counts, waiting copy, or organiser close action. Its Brainstorm action opens or returns to the successor brainstorm without a feedback gate; legacy playtest snapshots use the same path. Bot bubbles use paper/ink, the dark lime accent for the author, and muted-on-light metadata. Continuation on a paper surface uses ink text/border, never orange text on paper.

Requirement cards are reviewed before voting in a dense, readable list that may grow beyond five cards without clipping or pagination-based omission. Each card's reflected-sources section lists both current idea snippets and earlier backlog card identity when present, making merged cards visibly traceable. Voting controls must make the effective saved vote-token allowance obvious without explanatory marketing text: players can add, remove, stack, and reallocate tokens, with the current per-card count and saved/available count visible and submitted as one private replacement set. The UI reads that allowance from the round contract and treats absent legacy values as 5.

When prior voted cards were not built, the next brainstorm shows them as a compact `Unbuilt requirement cards` backlog panel on a warm paper surface before the live ideas form. Keep each backlog card scannable: original rank/status, title, and player-facing change only. Proposal review should label the combined list as new ideas plus carried backlog; it must not imply that the agent rewrote or filtered the old cards.

The build view uses a two-column workshop layout on desktop and a single-column stack on mobile. The active feature card owns the left column: it shows the selected requirement, player-facing change, status, and, after packaging, a clear `Play this feature` link for human validation. Every generated proposal appears in the queue, ordered by vote rank; fewer or zero votes place a card lower but never remove it. Remaining queued feature cards appear as a compact stacked visual below the active card, preserving their order without competing for attention. The right column shows the active build cycle for that card only. Build-cycle entries must correspond to real implementation or deterministic package-check work; do not present agent-driven gameplay validation or decorative stages. When the active card is packaged or completes with no material change, the card keeps its version link and outcome label while the next queued card becomes active in the background.

Delivery status distinguishes implementation, independent review, correction, and publication outcomes. If review infrastructure fails, say that the checked primary candidate was published and that the review failure was recorded; never present it as a failed implementation. If one requested correction fails, say that the checked primary candidate was used as fallback. A successful one-correction path says that review findings were addressed once and the checked correction was published. Keep this as concise status copy on the feature card rather than adding another phase or approval gate.

While the Build loop is active, a compact dark thinking bubble sits beneath that loop and streams the newest player-safe activity updates. Prefer explicitly marked summaries authored by the working LvlUP agent before distinct work steps, with phase-based fallback copy when no safe summary is available. It may describe inspecting the workspace, editing game files, checking the brief, repairing an implementation pass, or running validation, but must never expose raw model reasoning, prompts, credentials, paths, commands, or tool payloads. Retain only a short recent history, announce updates politely to assistive technology, and reduce the animated activity cue to a static cue when reduced motion is requested.

Each real Review, Build, and Test entry shows its elapsed wall-clock duration. The active entry ticks in seconds; completed entries retain their final duration from recorded loop transition times so players and operators can compare where build time was spent. Missing legacy timestamps display an honest unavailable marker rather than an invented duration.

Build, playtest, and failed-build states omit the large project hero. The shared header, progress rail, agent-stage note, version panel, and build workspace already carry the project, phase, play, identity, and recovery context; the active work must begin above the fold instead of repeating that context in a second oversized title block.

The progress rail uses exactly five player-facing labels: `Brainstorm`, `Review`, `Prioritise`, `Build`, and `Iterate`. Iterate is styled as a non-interactive loop cue back to Brainstorm; it is never a button, link, route, or current application screen. Internal brief freezing and playtest state stay within the Build presentation. Every round phase uses the full available project width with a persistent 70/30 workspace: the active workflow on the left and a warm-paper Game Versions utility rail on the right. The rail puts its full-width brainstorm action first, followed by completed immutable releases newest-first and the starting game last. It can collapse to a compact restore control or pop out as an in-app floating rail without relying on browser popup windows. Each row includes the version, requirement/feature, concise outcome status, and a 44px-minimum play link. During Brainstorm the action returns to the current conversation; from Build onward it opens or returns to the successor brainstorm. During Review and Prioritise it remains visible but honestly indicates that the next brainstorm becomes available when Build starts. At 900px and below the utility rail and workflow stack to one column without changing their reading order.

Do not add a separate delivered-feature action card to Build. Game Versions already provides direct play links for every release and the single `Brainstorm New Features` action, while the build workspace already exposes live progress. Prior-round play notes belong in the Brainstorm context and must not be repeated on Build. Keep the active-build indicator visible from brainstorm so players understand that ideation is happening alongside, not instead of, the frozen build queue.

During building and playtest, every player has a visible `Game is not running` report action. The action should be reachable without hunting through menus, explain that it interrupts the current agent loop, and collect a short optional note. Only the configured Level Up owner/admin has a distinct `Cancel current build` action while an agent run is active; ordinary organisers and players never see it and cannot invoke it through the API. The enabled control uses the destructive-button vocabulary and an in-app confirmation, aborts only the owned active run, defers that feature, preserves the stable release, and allows the frozen queue to continue. An interrupted build state uses the rose/error treatment, links back to the last stable playable release when one exists, and gives the organiser explicit retry/defer controls. Build failure panels should state the concrete agent/setup, interruption, or browser-validation problem, link players to the previous stable playable release when one exists, and offer the organiser a retry action without implying that fake output was generated. No new motion is introduced.

At phone widths (up to 600px), round phases use the compact `AppHeader` plus a single-line project/round/phase-or-timer strip; the oversized round hero compresses into that strip. The five stages remain a semantic ordered list but fit in one horizontal, non-interactive row. Phase notices may remain dismissible, while the explanatory agent-stage panel is omitted when the active workspace already carries that state. Nested room/work-panel padding contracts so Brainstorm conversation, proposal preparation, generated cards, and the active Build feature begin in the first viewport.

The phone Brainstorm composer uses two columns: the textarea owns the flexible left column, and a narrow right column stacks Attach above Send with 44px-minimum targets. Review and Prioritise cards lead with option/vote state, title, player change, and vote controls; secondary implementation and evidence content stays subordinate and compact. Generated Review must state plainly that cards are ready rather than leaving proposal-generation language visible.

Game Versions defaults to a compact 44px-minimum opener on phone widths and opens in place after the current workflow. Build therefore begins with the active feature rather than a full versions rail; players can still reach versions and the Brainstorm action without hunting through menus. Project-room buttons, links, summaries, and upload controls use scoped `touch-action: manipulation` to prevent accidental double-tap activation zoom while preserving page pinch zoom and browser accessibility zoom; the viewport must never set a maximum scale.

The Level Up shell and bundled playable games suppress incidental interface text selection and use `touch-action: manipulation` on ordinary surfaces and controls. Inputs, textareas, selects, and editable content retain native text editing and selection; game canvases may keep narrower touch-action rules only where their documented swipe or drag control needs them. No surface cancels document-level `touchmove`, so vertical page scrolling remains native.

## Owner admin mode

Group Mode is a dedicated owner-admin tab. Its compact panel uses the existing dark-room and paper-control vocabulary: workshop name, a checkbox row per project, truthful preflight copy, one Save & preflight action, then explicit initial-stage actions. Each action shows its eligible/selected project count and is disabled when no selected project can accept it; mixed selections explicitly skip ineligible projects while preserving per-project outcomes. Results stay attached to their project and failures use the existing rose treatment. Pause and Resume never appear as simultaneous choices.

Each selected-project operations row shows team/project, joined count, connected count or an explicit unavailable label, phase, Round Captain, agent state, stable-release availability, and exact new-tab project/failure links with `rel="noreferrer"`. Recovery actions appear only when their server preconditions are currently true.

Round Captain is a text badge beside the ordinary player identity, never colour alone. Before Build it identifies the current round's temporary captain and explains that this player resolves a tied starter-game result for Round 1 and opens proposal voting for that round. From Build onward it identifies the next round's captain for the existing discretionary successor-brainstorm action. Non-captains see a specific waiting message naming the captain through the same verified-profile or friendly-fallback presentation. Generated player avatars are deterministic voxel faces derived from pubkey and always paired with a friendly nickname. A verified HTTPS profile picture takes precedence; an npub never appears in this ordinary player surface.

The configured owner/admin never receives the Round Captain badge. When no non-owner candidate exists, player and monitoring surfaces say that there is no eligible player captain and that the owner override is available; they do not label the owner or organiser as the captain or expose the captain action to ordinary members.

Admin mode uses the same dark room shell as the lobby/project surfaces. It has
four top-level tabs: `Monitoring`, `Group Mode`, `Models`, and `Prompts`. Monitoring is the default
operational view; prompt editing and runtime loop controls live in the Prompts
tab so they do not compete with diagnostics.

Monitoring includes an owner-controls list for every team and a destructive action on every project row. Each action opens a Level Up-native alert dialog that names the target, says deletion is permanent, describes the affected child records, and offers explicit Cancel and Delete actions. While deletion is running both dismissal and repeat submission are disabled; completion or failure is announced in the existing polite status region.

The Models tab is a paper work panel with a monospaced, newline-delimited
OpenRouter allowlist, a default-model select populated from that list, concise
validation/status copy, and one Save action. It stacks without horizontal
scrolling at 320px. Removing a model that is still the default or assigned to a
prompt reports the conflict in the existing live status region.

The Monitoring tab lists current projects, their team, current round
phase/sequence when present, a selectable list of recent redacted Goose runs for
the selected project, and one details pane for the selected run. The run list is
a scannable operational index, not a stack of detail cards. The detail pane
shows stage, status, client, model, configured max turns, duration, prompt/output
byte counts, token/cost summary, Goose session ID, classified error code when
present, and sanitized correlation fields. Beneath that compact summary it
shows three explicit transcript concepts: the compiled model input, numbered
chronological model turns, and a visually accented final Level Up schema/API
payload. Bodies use monospaced, preserved JSON/text formatting inside bounded
scroll regions and native keyboard-accessible disclosures. Byte size and
truncation are visible in every disclosure; absent legacy data says it was not
captured, and an empty model result is not confused with missing history. The
layout remains one column at narrow widths and gives the transcript the flexible
desktop column. It must remain dense and operational rather than marketing-like.
All displayed bodies are recursively redacted; secrets, cookies, authorization
headers, signed events, invite/private keys, provider keys, callback tokens, and
runtime environment payloads never appear.

The Prompts tab contains the compact dark control band for the live brainstorm
interval, proposal-vote allowance, and Goose max turns, plus the paper work panel for editable prompt
templates. Stage selection is a compact dark sidebar on desktop and stacks above
the editor on mobile. The interval, proposal-vote allowance, and max-turn controls are bounded number
inputs with the existing primary button style; they should remain visually
secondary to the prompt editor but easy to scan.

The editor must show the stage, whether it is using the compiled default or a
custom prompt, a default-versus-specific allowed-model select with its effective
resolved model, the required `{{inputJson}}` placeholder state, Save, Reset to
default, and the compiled default in a disclosure. Keep all prompt text in a
monospaced textarea, avoid modal browser prompts, and use the existing
primary/text button variants.
