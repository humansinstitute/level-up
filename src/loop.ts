import { SummaryStore, type SummaryInput } from "./summary-store";
import type { FeedbackSummary, SummaryMessage, SummaryRunView } from "./feedback-summary";
import { SummaryError, agentErrorMessage } from "./feedback-summary";
import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { activityLog } from "./activity-log";
import { adminSettings } from "./admin-settings";
import { ProjectFeatureQueue } from "./feature-queue";

export type RoundPhase = "brainstorm" | "proposals" | "voting" | "brief" | "building" | "playtest" | "failed";
export type BuildStage = "preparing" | "analysing" | "coding" | "testing" | "publishing" | "complete" | "failed";
export type FeatureBuildStatus = "queued" | "reviewing" | "building" | "testing" | "succeeded" | "no_change" | "failed" | "interrupted" | "deferred";
export type FeatureAgentLoop = "review" | "build" | "test";

export interface RoundContribution {
  id: string; roundId: string; authorAccountId: string; authorNpub: string; body: string;
  clientEventId: string; sequence: number; createdAt: number; authorKind?: "member" | "bot"; authorLabel?: string;
  attachments?: RoundContributionAttachment[];
}
export interface RoundContributionAttachment {
  id: string; kind: "image"; filename: string; contentType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  dataUrl: string; sizeBytes: number;
}
export interface Proposal {
  id: string; roundId: string; position: number; title: string; playerChange: string;
  implementationScope: string; acceptanceCriteria: string[]; ideaReferences: number[]; backlogReferences?: string[];
}
export type BacklogDecisionOperation = "retain" | "modify" | "combine" | "delete";
export interface BacklogDecision { backlogProposalId: string; operation: BacklogDecisionOperation; resultingCardKey: string | null; reason: string }
export interface ContributionDecision { contributionSequence: number; operation: "include" | "reject"; resultingCardKey: string | null; reason: string }
export interface ProposalReconciliation { schemaVersion: 2; backlogDecisions: BacklogDecision[]; contributionDecisions: ContributionDecision[] }
export interface RankedProposal extends Proposal { rank: number; votes: number; firstPlaceVotes: number; secondPlaceVotes: number; thirdPlaceVotes: number }
export interface FrozenBrief { committed: RankedProposal; stretch: RankedProposal[]; selected: RankedProposal[]; frozenAt: number; tieBreakRule: string }
export interface BuildStep { stage: BuildStage; status: "pending" | "active" | "complete" | "failed"; at: number | null; detail: string }
export interface FeatureBuildStep { loop: FeatureAgentLoop; status: "active" | "complete" | "failed"; at: number | null; detail: string }
export interface BuildActivityUpdate { phase: "inspecting" | "editing" | "testing" | "repairing"; message: string; at: number }
export interface BuildReport { id: string; accountId: string; proposalId: string | null; note: string; reportedAt: number; loop: FeatureAgentLoop | null }
export interface FeatureBuild {
  proposalId: string; queuePosition: number; status: FeatureBuildStatus; currentAgentLoop: FeatureAgentLoop | null;
  steps: FeatureBuildStep[]; releaseUrl: string | null; failure: string | null; reportCount: number;
  latestReport: BuildReport | null; startedAt: number | null; completedAt: number | null;
  activity?: BuildActivityUpdate[];
  delivery?: FeatureDeliveryOutcome;
}
export interface FeatureDeliveryOutcome { implementation:"checked"; review:"approved"|"changes_required"|"failed"; correction:"not_required"|"checked"|"failed"; selectedCandidate:"primary"|"corrected"; reviewFindings:string[]; reviewFailure:string|null; correctionFailure:string|null }
export interface BuildRun {
  id: string; status: "running" | "succeeded" | "failed" | "interrupted"; currentStage: BuildStage; simulated: boolean;
  steps: BuildStep[]; includedProposalIds: string[]; deferredProposalIds: string[]; startedAt: number;
  completedAt: number | null; validated: boolean; releaseUrl: string | null; failure: string | null;
  featureBuilds?: FeatureBuild[]; activeFeatureProposalId?: string | null; reportCount?: number;
  latestReport?: BuildReport | null; previousStableUrl?: string | null;
}
export interface MemberFeedback {
  id: string; authorAccountId: string; authorNpub: string; worked: string; improve: string; nextIdea: string;
  clientEventId: string; submittedAt: number;
}
export interface RoundFeedbackHistory { roundNumber: number; feedback: MemberFeedback[] }
export interface ProjectVersionHistoryEntry {
  roundNumber: number; proposalId: string; title: string; playerChange: string;
  status: "succeeded" | "no_change"; releaseUrl: string; completedAt: number | null;
}
export interface RequirementBacklogItem {
  proposalId: string; sourceRoundNumber: number; sourceRank: number; title: string; playerChange: string;
  implementationScope: string; acceptanceCriteria: string[]; status: "queued" | "deferred" | "failed" | "interrupted";
}
export interface FeedbackContext { roundNumber: number; worked: string[]; improve: string[]; nextIdeas: string[]; requirementBacklog?: RequirementBacklogItem[] }
export interface RoundSnapshot {
  summaryRun?: SummaryRunView | null; summaryMessages?: SummaryMessage[];
  id: string; projectId: string; number: number; phase: RoundPhase; startedAt: number; deadlineAt: number;
  votingDeadlineAt: number | null; closedAt: number | null; serverTime: number; lastSequence: number;
  contributions: RoundContribution[]; proposals: Proposal[]; selections: string[]; rankings: RankedProposal[] | null;
  proposalVoteAllowance: number;
  brief: FrozenBrief | null; build: BuildRun | null; feedback: MemberFeedback[]; feedbackHistory: RoundFeedbackHistory[]; priorFeedback: FeedbackContext | null;
  versionHistory?: ProjectVersionHistoryEntry[];
  activeBuild?: { roundNumber: number; brief: FrozenBrief; build: BuildRun } | null;
  proposalGeneration?: { status: "idle" | "running" | "failed" | "complete"; error: string | null; attempts: number };
  brainstormSeed?: { status: "idle" | "running" | "failed" | "complete"; error: string | null; attempts: number };
  proposalReconciliation?: ProposalReconciliation | null;
}
export type RoundEventType = "summary_queued" | "summary_running" | "summary_failed" | "summary_completed" | "summary_skipped" | "contribution_committed" | "proposals_available" | "phase_changed" | "vote_closed" | "build_updated" | "feedback_submitted" | "round_started";
export interface RoundEvent {
  roundId: string; projectId: string; sequence: number; type: RoundEventType; createdAt: number;
  contribution?: RoundContribution; phase?: RoundPhase; roundNumber?: number;
}
export interface RoundMutation { round: RoundSnapshot; event: RoundEvent | null; duplicate: boolean }

export class LoopError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) { super(message); }
}

export interface ProposalGeneratorInput { projectId?: string; templateTitle: string; contributions: RoundContribution[]; priorFeedback: FeedbackContext | null }
export interface ProposalDraft { cardKey?: string; title: string; playerChange: string; implementationScope: string; acceptanceCriteria: string[]; ideaReferences: number[]; backlogReferences: string[] }
export interface ProposalGenerationResult extends ProposalReconciliation { proposals: ProposalDraft[] }
export interface ProposalGenerator { generate(input: ProposalGeneratorInput): ProposalGenerationResult | ProposalDraft[] | Promise<ProposalGenerationResult | ProposalDraft[]> }
export interface BrainstormSuggestionInput extends ProposalGeneratorInput { roundNumber: number; previousSuggestions: string[]; mode?: "seed" | "nudge" }
export interface BrainstormSuggestionGenerator { suggest(input: BrainstormSuggestionInput): string | null | Promise<string | null> }
export interface BuildAdapterInput { projectId: string; projectName: string; roundNumber: number; templateTitle: string; templatePreviewUrl: string; previousStableUrl: string | null; brief: FrozenBrief; activeProposal?: RankedProposal; priorImplemented?: RankedProposal[]; featureExecution?: { featureId: string; runId: string; workspaceRef: string; signal: AbortSignal; onProgress: (progress: unknown) => void } }
export interface BuildAdapterFeatureResult { proposalId: string; status: "succeeded" | "no_change" | "failed" | "deferred"; releaseUrl: string | null; failure: string | null; delivery?: FeatureDeliveryOutcome }
export interface BuildAdapterResult { validated: boolean; includedProposalIds: string[]; deferredProposalIds: string[]; releaseUrl: string | null; failure: string | null; featureResults?: BuildAdapterFeatureResult[] }
export interface BuildAdapter { readonly simulated: boolean; validate(input: BuildAdapterInput): BuildAdapterResult | Promise<BuildAdapterResult> }

export const LEVEL_UP_BOT_ACCOUNT_ID = "level-up-bot-account";
const LEVEL_UP_BOT_NPUB = "bot:lvl_up";
const LEVEL_UP_BOT_PUBKEY = "f".repeat(64);
const LEVEL_UP_BOT_LABEL = "lvl_up";
const DEFAULT_SUGGESTION_INTERVAL_MS = 30_000;
const MAX_CONTRIBUTION_ATTACHMENTS = 4;
const MAX_CONTRIBUTION_ATTACHMENT_BYTES = 3_000_000;
const MAX_CONTRIBUTION_TOTAL_ATTACHMENT_BYTES = 8_000_000;
const IMAGE_ATTACHMENT_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
type SuggestionIntervalMs = number | (() => number);

export const MAX_PROPOSAL_SOURCES = 50;
export const MAX_PROPOSAL_CARDS = 5;

function cleanPlayerIdea(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\bpoisen\s*t?\b/gi, "poison")
    .replace(/\bopsite\b/gi, "opposite")
    .replace(/\bandhave\b/gi, "and have")
    .replace(/\bstraegic\b/gi, "strategic")
    .replace(/\bexplring\b/gi, "exploring")
    .replace(/\brespoinses\b/gi, "responses")
    .replace(/\blvel\b/gi, "Level")
    .replace(/\s+([?.!,])/g, "$1")
    .replace(/[>]+$/g, "")
    .replace(/^\w/, (letter) => letter.toUpperCase());
}

export class DeterministicProposalGenerator implements ProposalGenerator {
  generate(input: ProposalGeneratorInput): ProposalDraft[] {
    const backlog = (input.priorFeedback?.requirementBacklog ?? []).map((item): ProposalDraft => ({
      title: item.title,
      playerChange: item.playerChange,
      implementationScope: item.implementationScope,
      acceptanceCriteria: item.acceptanceCriteria,
      ideaReferences: [],
      backlogReferences: [item.proposalId],
    }));
    const ideas = input.contributions;
    const generated = ideas.map((idea, index): ProposalDraft => ({
      title: this.title(idea.body, index),
      playerChange: `Bring this team idea into ${input.templateTitle}: ${cleanPlayerIdea(idea.body)}`,
      implementationScope: `Turn the cleaned player request into one bounded content, rules, or presentation change using ${input.templateTitle}'s existing systems.`,
      acceptanceCriteria: ["The requested change is visible during normal play", "Player-facing copy is clean and readable", "The game remains playable on a mobile viewport"],
      ideaReferences: [idea.sequence],
      backlogReferences: [],
    }));
    return [...backlog, ...generated];
  }
  private title(body: string, index: number): string {
    const words = cleanPlayerIdea(body).replace(/[^a-zA-Z0-9' -]/g, "").trim().split(/\s+/).slice(0, 5).join(" ");
    return words ? `${index + 1}. ${words}` : `Team change ${index + 1}`;
  }
}

function normalizeSuggestionText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function buildFailureMessage(error: unknown): string {
  if (error instanceof SummaryError) return agentErrorMessage(error.code);
  if (error instanceof Error && error.name === "PlayableReleaseValidationError") return error.message;
  return "Build agent failed before publishing.";
}

function normalizeContributionAttachments(value: unknown): RoundContributionAttachment[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_CONTRIBUTION_ATTACHMENTS) throw new LoopError("invalid_attachment", "Attach up to four screenshot images.", 400);
  let total = 0;
  return value.map((item, index): RoundContributionAttachment => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new LoopError("invalid_attachment", "Screenshots must be image attachments.", 400);
    const attachment = item as Partial<RoundContributionAttachment>;
    const contentType = typeof attachment.contentType === "string" && IMAGE_ATTACHMENT_TYPES.has(attachment.contentType) ? attachment.contentType as RoundContributionAttachment["contentType"] : null;
    if (!contentType || attachment.kind !== "image" || typeof attachment.dataUrl !== "string") throw new LoopError("invalid_attachment", "Screenshots must be PNG, JPEG, WebP, or GIF images.", 400);
    const prefix = `data:${contentType};base64,`;
    if (!attachment.dataUrl.startsWith(prefix)) throw new LoopError("invalid_attachment", "Screenshot data must be a browser image data URL.", 400);
    const encoded = attachment.dataUrl.slice(prefix.length);
    if (!/^[A-Za-z0-9+/]+=*$/.test(encoded)) throw new LoopError("invalid_attachment", "Screenshot data is not valid base64.", 400);
    const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
    const sizeBytes = Math.floor((encoded.length * 3) / 4) - padding;
    if (sizeBytes < 1 || sizeBytes > MAX_CONTRIBUTION_ATTACHMENT_BYTES) throw new LoopError("invalid_attachment", "Each screenshot must be 3 MB or smaller.", 400);
    total += sizeBytes;
    if (total > MAX_CONTRIBUTION_TOTAL_ATTACHMENT_BYTES) throw new LoopError("invalid_attachment", "Attached screenshots are too large together.", 400);
    const filename = typeof attachment.filename === "string" && attachment.filename.trim() ? attachment.filename.trim().replace(/[^\w .()-]/g, "_").slice(0, 120) : `screenshot-${index + 1}.${contentType.split("/")[1]}`;
    const id = typeof attachment.id === "string" && attachment.id.trim().length >= 8 && attachment.id.length <= 128 ? attachment.id : randomUUID();
    return { id, kind: "image", filename, contentType, dataUrl: attachment.dataUrl, sizeBytes };
  });
}

export class DeterministicSimulatedBuildAdapter implements BuildAdapter {
  readonly simulated = true;
  validate(input: BuildAdapterInput) { const proposal=input.activeProposal??input.brief.committed; return { validated: true, includedProposalIds: [proposal.id], deferredProposalIds: input.activeProposal?[]:input.brief.stretch.map((item)=>item.id), releaseUrl: input.templatePreviewUrl, failure: null }; }
}

export class SilentBrainstormSuggestionGenerator implements BrainstormSuggestionGenerator {
  suggest(): null { return null; }
}

function deterministicBrainstormNudge(input: BrainstormSuggestionInput): string {
  const text = input.contributions.map((item) => item.body.toLowerCase()).join(" ");
  if (/(food|foods|poison|poisen)/.test(text) && /(wall|wrap|opposite|opsite)/.test(text)) return "Yes, and I'd make that strategic: safe foods give powers, poison becomes a risky avoid-or-use hazard, and wall-wrapping creates escape routes.";
  if (/(food|foods|poison|poisen)/.test(text)) return "Yes, and I'd give each food a clear trade-off: one scores, one speeds you up, one protects you, and poison forces a route choice.";
  if (/(wall|wrap|opposite|opsite)/.test(text)) return "Yes, and I'd make wall-wrapping a tactic: crossing an edge saves you, but it can also drop you near danger if you time it badly.";
  if (/(theme|screen|look|visual)/.test(text)) return "Yes, and I'd tie the screen theme to play: make the background, pickups, and danger cues tell players what choice matters next.";
  const latest = input.contributions.at(-1)?.body.trim().replace(/\s+/g, " ") || "that idea";
  return `Yes, and I'd turn "${latest.slice(0, 80)}" into one strategic choice the player can understand while moving.`;
}

type RoundRow = { id: string; project_id: string; number: number; phase: RoundPhase; started_at: number; deadline_at: number; voting_deadline_at: number | null; closed_at: number | null; last_sequence: number; brief_json: string | null; prior_feedback_json: string | null; proposal_generation_status: "idle"|"running"|"failed"|"complete"; proposal_generation_error: string|null; proposal_generation_attempts:number; proposal_generation_lease_at:number|null; proposal_reconciliation_json:string|null; brainstorm_seed_status:"idle"|"running"|"failed"|"complete"; brainstorm_seed_error:string|null; brainstorm_seed_attempts:number; brainstorm_seed_lease_at:number|null };

export class SqliteLoopStore {
  readonly summaries: SummaryStore;
  readonly featureQueue: ProjectFeatureQueue;
  private readonly stages: BuildStage[] = ["preparing", "analysing", "coding", "testing", "publishing", "complete"];
  private readonly visibleLoops: FeatureAgentLoop[] = ["review", "build", "test"];
  private readonly activeBuildRuns = new Map<string, Promise<RoundMutation | null>>();
  private readonly activeBuildControllers = new Map<string, AbortController>();
  private readonly activeProposalRuns = new Map<string, Promise<RoundEvent | null>>();
  constructor(
    private readonly db: Database,
    private readonly now: () => number,
    private readonly brainstormMs: number,
    private readonly votingMs: number,
    private readonly generator: ProposalGenerator,
    private readonly suggestionGenerator: BrainstormSuggestionGenerator = new SilentBrainstormSuggestionGenerator(),
    private readonly suggestionIntervalMs: SuggestionIntervalMs = DEFAULT_SUGGESTION_INTERVAL_MS,
    private readonly buildAdapter: BuildAdapter = new DeterministicSimulatedBuildAdapter(),
  ) { this.migrate(); this.recoverBrainstormSeeds(); this.featureQueue=new ProjectFeatureQueue(db,now); this.featureQueue.recover(); this.recoverProposals();
    this.summaries = new SummaryStore(db, now, (id, type) => {
      const row = this.db.query("SELECT * FROM collaboration_rounds WHERE id=?").get(id) as RoundRow;
      this.simpleEvent(row, row.project_id, type);
    }, (input, content) => this.createSuccessor(input, content));
  }

  ensureFirstRound(projectId: string, startedAt: number): void {
    this.db.query("INSERT OR IGNORE INTO collaboration_rounds (id, project_id, number, phase, started_at, deadline_at, last_sequence) VALUES (?, ?, 1, 'brainstorm', ?, ?, 0)").run(randomUUID(), projectId, startedAt, startedAt + this.brainstormMs);
  }

  async cancelProjectWork(projectId: string): Promise<void> {
    const features = this.featureQueue.list(projectId);
    for (const feature of features) {
      this.activeBuildControllers.get(feature.id)?.abort();
      this.activeBuildControllers.delete(feature.id);
      if (feature.runId) this.featureQueue.completeRun(feature.runId, "interrupted");
    }
    const roundIds = (this.db.query("SELECT id FROM collaboration_rounds WHERE project_id=?").all(projectId) as Array<{id:string}>).map((row) => row.id);
    await Promise.allSettled(roundIds.map((roundId) => this.activeBuildRuns.get(roundId)).filter((run): run is Promise<RoundMutation | null> => Boolean(run)));
  }

  currentRound(projectId: string, accountId: string): RoundSnapshot {
    this.requireMember(projectId, accountId);
    let row = this.currentRow(projectId);
    if (!row) throw this.error("round_not_ready", "Choose a template before starting a round.", 409);
    if (row.phase === "brainstorm" && row.proposal_generation_status !== "failed" && this.now() >= row.deadline_at) {
      try {
        const closed = this.closeBrainstormInternal(projectId, row.number, row.deadline_at, true);
        if (closed instanceof Promise) void closed.catch(() => undefined);
        else row = this.currentRow(projectId)!;
      } catch {
        // Snapshot reads should remain available even when automatic proposal generation is unavailable.
      }
    }
    row = this.currentRow(projectId)!;
    if (row.phase === "voting" && row.voting_deadline_at !== null && this.now() >= row.voting_deadline_at) this.closeVotingInternal(projectId, row.number, row.voting_deadline_at, true);
    return this.hydrate(row, accountId);
  }

  round(projectId: string, number: number, accountId: string): RoundSnapshot {
    this.requireMember(projectId, accountId);
    const current = this.currentRound(projectId, accountId);
    if (current.number === number) return current;
    const row = this.row(projectId, number);
    if (!row) throw this.error("round_not_found", `Round ${number} does not exist.`, 404);
    return this.hydrate(row, accountId);
  }

  events(projectId: string, number: number, accountId: string, after: number): { round: RoundSnapshot; events: RoundEvent[] } {
    const round = this.round(projectId, number, accountId);
    const rows = this.db.query("SELECT sequence, type, payload_json, created_at FROM collaboration_events WHERE round_id = ? AND sequence > ? ORDER BY sequence").all(round.id, Math.max(0, after)) as Array<{sequence:number;type:RoundEventType;payload_json:string;created_at:number}>;
    return { round, events: rows.map((item) => ({ roundId: round.id, projectId, sequence: item.sequence, type: item.type, createdAt: item.created_at, ...JSON.parse(item.payload_json) })) };
  }

  submitContribution(projectId: string, number: number, accountId: string, clientEventId: string, rawBody: string, rawAttachments: unknown = []): RoundMutation {
    this.requireMember(projectId, accountId); this.validateClientId(clientEventId);
    const body = rawBody.trim().replace(/\s+/g, " ");
    const attachments = normalizeContributionAttachments(rawAttachments);
    if (body.length > 500 || (!body && !attachments.length)) throw this.error("invalid_contribution", "Ideas need text or a screenshot; text is limited to 500 characters.", 400);
    this.currentRound(projectId, accountId);
    let event: RoundEvent | null = null; let duplicate = false;
    this.db.transaction(() => {
      const row = this.requiredRow(projectId, number);
      const existing = this.contribution(row.id, clientEventId);
      if (existing) { duplicate = true; event = this.contributionEvent(projectId, existing); return; }
      if (row.phase !== "brainstorm") throw this.error("brainstorm_closed", "Brainstorming has closed.", 409);
      const sequence = this.next(row.id); const at = this.now(); const id = randomUUID();
      this.db.query("INSERT INTO collaboration_contributions (id, round_id, author_account_id, body, client_event_id, sequence, created_at, attachments_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, row.id, accountId, body, clientEventId, sequence, at, JSON.stringify(attachments));
      event = { roundId: row.id, projectId, sequence, type: "contribution_committed", createdAt: at, contribution: this.contribution(row.id, clientEventId)! };
      this.insertEvent(event);
    })();
    return { round: this.round(projectId, number, accountId), event, duplicate };
  }

  suggestBrainstorm(projectId: string): RoundMutation | Promise<RoundMutation | null> | null {
    const row = this.currentRow(projectId);
    if (!row || row.phase !== "brainstorm" || this.now() >= row.deadline_at) return null;
    const member = this.anyMember(projectId);
    if (!member || !this.suggestionDue(row.id)) return null;
    const template = this.db.query("SELECT gt.title FROM projects p JOIN game_templates gt ON gt.id = p.selected_template_id WHERE p.id = ?").get(projectId) as {title:string} | null;
    if (!template) return null;
    const allHumanContributions = this.humanContributions(row.id);
    const previousSuggestions = this.botSuggestions(row.id);
    const seed = allHumanContributions.length === 0 && previousSuggestions.length === 0;
    const humanContributions = seed ? [] : this.freshHumanContributions(row.id);
    if (!seed && !humanContributions.length) return null;
    if (seed && !this.claimBrainstormSeed(row.id)) return null;
    const input: BrainstormSuggestionInput = {
      projectId,
      templateTitle: template.title,
      contributions: humanContributions,
      priorFeedback: this.feedbackContext(row.prior_feedback_json),
      roundNumber: row.number,
      previousSuggestions,
      mode: seed ? "seed" : "nudge",
    };
    const commit = (message: string | null, clientEventId?: string): RoundMutation | null => {
      const body = message?.trim().replace(/\s+/g, " ");
      if (!body) return null;
      let event: RoundEvent | null = null;
      this.db.transaction(() => {
        const fresh = this.requiredRow(projectId, row.number);
        if (fresh.phase !== "brainstorm" || !this.suggestionDue(fresh.id)) return;
        if (seed && (this.humanContributions(fresh.id).length > 0 || this.botSuggestions(fresh.id).length > 0)) {
          this.db.query("UPDATE collaboration_rounds SET brainstorm_seed_status='idle',brainstorm_seed_error=NULL,brainstorm_seed_lease_at=NULL WHERE id=?").run(fresh.id);
          return;
        }
        const idempotencyKey = clientEventId ?? (seed ? `lvl-up-seed-${fresh.id}` : `lvl-up-suggestion-${fresh.id}-${humanContributions.at(-1)?.sequence ?? "none"}`);
        if (this.contribution(fresh.id, idempotencyKey)) return;
        const storedBody = body.slice(0, 500);
        if (this.hasBotSuggestion(fresh.id, storedBody)) return;
        this.ensureBotAccount();
        const sequence = this.next(fresh.id);
        const at = this.now();
        const id = randomUUID();
        this.db.query("INSERT INTO collaboration_contributions (id, round_id, author_account_id, body, client_event_id, sequence, created_at, author_kind, author_label) VALUES (?, ?, ?, ?, ?, ?, ?, 'bot', ?)").run(id, fresh.id, LEVEL_UP_BOT_ACCOUNT_ID, storedBody, idempotencyKey, sequence, at, LEVEL_UP_BOT_LABEL);
        if (seed) this.db.query("UPDATE collaboration_rounds SET brainstorm_seed_status='complete',brainstorm_seed_error=NULL,brainstorm_seed_lease_at=NULL WHERE id=?").run(fresh.id);
        event = { roundId: fresh.id, projectId, sequence, type: "contribution_committed", createdAt: at, contribution: this.contribution(fresh.id, idempotencyKey)! };
        this.insertEvent(event);
      })();
      return event ? { round: this.currentRound(projectId, member), event, duplicate: false } : null;
    };
    try {
      const generated = this.suggestionGenerator.suggest(input);
      const finish = (message:string|null) => { if(seed&&!message?.trim()){const error=new SummaryError("invalid_output");this.failBrainstormSeed(row.id,error);throw error;}return commit(message); };
      return generated instanceof Promise ? generated.then(finish).catch((error) => { if (seed) this.failBrainstormSeed(row.id, error); throw error instanceof SummaryError ? error : new SummaryError("provider_error"); }) : finish(generated);
    } catch (error) {
      if (seed) this.failBrainstormSeed(row.id, error);
      throw error instanceof SummaryError ? error : new SummaryError("provider_error");
    }
  }

  closeBrainstorm(projectId: string, number: number, accountId: string): RoundMutation | Promise<RoundMutation> {
    this.requireOrganiser(projectId, accountId);
    const result = this.closeBrainstormInternal(projectId, number, this.now(), false);
    const mutation = (event: RoundEvent | null): RoundMutation => ({ round: this.round(projectId, number, accountId), event, duplicate: !event });
    return result instanceof Promise ? result.then(mutation) : mutation(result);
  }

  closeExpired(projectId: string): RoundMutation | Promise<RoundMutation | null> | null {
    const row = this.currentRow(projectId); if (!row) return null;
    let eventOrPromise: RoundEvent | Promise<RoundEvent | null> | null = null;
    if (row.phase === "brainstorm" && this.now() >= row.deadline_at) eventOrPromise = this.closeBrainstormInternal(projectId, row.number, row.deadline_at, true);
    else if (row.phase === "voting" && row.voting_deadline_at !== null && this.now() >= row.voting_deadline_at) eventOrPromise = this.closeVotingInternal(projectId, row.number, row.voting_deadline_at, true);
    const mutation = (event: RoundEvent | null): RoundMutation | null => {
      if (!event) return null;
      const member = this.anyMember(projectId); if (!member) return null;
      return { round: this.currentRound(projectId, member), event, duplicate: false };
    };
    if (eventOrPromise instanceof Promise) return eventOrPromise.then(mutation);
    const event = eventOrPromise;
    if (!event) return null;
    const member = this.anyMember(projectId); if (!member) return null;
    return { round: this.currentRound(projectId, member), event, duplicate: false };
  }

  beginVoting(projectId: string, number: number, accountId: string): RoundMutation {
    this.requireMember(projectId, accountId); let event: RoundEvent | null = null;
    this.db.transaction(() => {
      const row=this.requiredRow(projectId,number); if(["voting","brief","building","playtest","failed"].includes(row.phase))return;
      if(row.phase!=="proposals")throw this.error("proposals_not_ready","Proposal review is not ready to close.",409);
      this.db.query("UPDATE collaboration_rounds SET phase='voting',voting_deadline_at=? WHERE id=? AND phase='proposals'").run(this.now()+this.votingMs,row.id);
      event=this.phaseEvent(row,projectId,"voting");
    })();
    return {round:this.round(projectId,number,accountId),event,duplicate:!event};
  }

  replaceVotes(projectId: string, number: number, accountId: string, proposalIds: string[]): RoundMutation {
    this.requireMember(projectId, accountId);
    const unique = [...new Set(proposalIds)];
    const allowance = adminSettings().proposalVoteAllowance;
    if (proposalIds.length > allowance) throw this.error("invalid_proposal_votes", `Use up to ${allowance} proposal vote tokens.`, 400);
    this.currentRound(projectId, accountId);
    this.db.transaction(() => {
      const row = this.requiredRow(projectId, number); if (row.phase !== "voting") throw this.error("voting_closed", "Proposal voting has closed.", 409);
      if (unique.length) {
        const valid = this.db.query(`SELECT COUNT(*) AS count FROM collaboration_proposals WHERE round_id = ? AND id IN (${unique.map(() => "?").join(",")})`).get(row.id, ...unique) as {count:number};
        if (valid.count !== unique.length) throw this.error("invalid_proposal", "Choose proposals from this round.", 400);
      }
      this.db.query("DELETE FROM collaboration_votes WHERE round_id = ? AND account_id = ?").run(row.id, accountId);
      const insert = this.db.query("INSERT INTO collaboration_votes (round_id, account_id, proposal_id, vote_rank, updated_at) VALUES (?, ?, ?, ?, ?)");
      proposalIds.forEach((id, index) => insert.run(row.id, accountId, id, index + 1, this.now()));
    })();
    return { round: this.round(projectId, number, accountId), event: null, duplicate: false };
  }

  closeVoting(projectId: string, number: number, accountId: string): RoundMutation {
    this.requireOrganiser(projectId, accountId);
    const event = this.closeVotingInternal(projectId, number, this.now(), false);
    return { round: this.round(projectId, number, accountId), event, duplicate: !event };
  }

  startBuild(projectId: string, number: number, accountId: string): RoundMutation {
    this.requireOrganiser(projectId, accountId); let event: RoundEvent | null = null;
    this.db.transaction(() => {
      const row = this.requiredRow(projectId, number);
      const existing = this.db.query("SELECT id FROM collaboration_builds WHERE round_id = ?").get(row.id);
      if (existing && ["building","playtest"].includes(row.phase)) return;
      if ((row.phase !== "brief" && row.phase !== "failed") || !row.brief_json) throw this.error("brief_not_ready", "Freeze the round brief before building.", 409);
      if (!existing) {
        const brief = JSON.parse(row.brief_json) as FrozenBrief; const at = this.now();
        const steps = this.stages.map((stage, index): BuildStep => ({ stage, status: index === 0 ? "active" : "pending", at: index === 0 ? at : null, detail: this.stageDetail(stage) }));
        this.db.query("INSERT INTO collaboration_builds (id, round_id, status, current_stage, steps_json, included_json, deferred_json, started_at, completed_at, validated, release_url, failure, simulated, feature_builds_json, reports_json, previous_stable_url) VALUES (?, ?, 'running', 'preparing', ?, ?, ?, ?, NULL, 0, NULL, NULL, ?, ?, '[]', ?)").run(randomUUID(), row.id, JSON.stringify(steps), JSON.stringify([]), JSON.stringify(brief.selected.map((item) => item.id)), at, this.buildAdapter.simulated ? 1 : 0, JSON.stringify(this.initialFeatureBuilds(brief)), this.projectStableUrl(projectId));
        activityLog("build.state.started", { projectId, roundNumber: number, roundId: row.id, simulated: this.buildAdapter.simulated, retry: false });
      } else if (row.phase === "failed") {
        const brief = JSON.parse(row.brief_json) as FrozenBrief; const at = this.now();
        const steps = this.stages.map((stage, index): BuildStep => ({ stage, status: index === 0 ? "active" : "pending", at: index === 0 ? at : null, detail: this.stageDetail(stage) }));
        const prior=this.buildRow(row.id);const reports=this.parseReports(prior?.reports_json);const existingFeatures=this.featureBuilds(prior,brief,reports);const retryFeatures=existingFeatures.map((feature)=>feature.status==="failed"||feature.status==="interrupted"?{...feature,status:"queued" as const,currentAgentLoop:null,failure:null,steps:[],startedAt:null,completedAt:null}:feature);const included=retryFeatures.filter((feature)=>feature.status==="succeeded"||feature.status==="no_change").map((feature)=>feature.proposalId);const stable=this.projectStableUrl(projectId);
        this.db.query("UPDATE collaboration_builds SET status='running', current_stage='preparing', steps_json=?, included_json=?, deferred_json=?, started_at=?, completed_at=NULL, validated=?, release_url=?, failure=NULL, simulated=?, feature_builds_json=?, previous_stable_url=? WHERE round_id=?").run(JSON.stringify(steps), JSON.stringify(included), JSON.stringify(retryFeatures.filter((feature)=>feature.status==="deferred").map((feature)=>feature.proposalId)), at, included.length?1:0, stable, this.buildAdapter.simulated ? 1 : 0, JSON.stringify(retryFeatures), stable, row.id);
        this.featureQueue.requeueRetryable(projectId);
        activityLog("build.state.started", { projectId, roundNumber: number, roundId: row.id, simulated: this.buildAdapter.simulated, retry: true });
      }
      this.db.query("UPDATE collaboration_rounds SET phase = 'building' WHERE id = ? AND phase IN ('brief','failed')").run(row.id);
      this.featureQueue.claim(projectId,this.projectStableUrl(projectId));
      event = this.phaseEvent(row, projectId, "building");
    })();
    return { round: this.round(projectId, number, accountId), event, duplicate: !event };
  }

  advanceBuild(projectId: string): RoundMutation | Promise<RoundMutation | null> | null {
    const leasedAtStart=this.featureQueue.list(projectId).find(feature=>feature.status==="active")??this.featureQueue.claim(projectId,this.projectStableUrl(projectId));
    const row = leasedAtStart ? this.db.query("SELECT r.* FROM collaboration_rounds r JOIN collaboration_builds b ON b.round_id=r.id WHERE r.id=? AND b.status='running'").get(leasedAtStart.roundId) as RoundRow|null : null;
    if (!row) return null;
    const applyResult = (result: BuildAdapterResult): RoundMutation | null => {
      let event: RoundEvent | null = null;
      this.db.transaction(() => {
        const fresh = this.row(projectId,row.number); if (!fresh || fresh.id !== row.id) return;
        const current = this.buildRow(row.id); if (!current || current.status !== "running" || current.current_stage !== "coding") return;
        const at = this.now(); const steps = JSON.parse(current.steps_json) as BuildStep[]; const codingIndex = this.stages.indexOf("coding"); const testingIndex = this.stages.indexOf("testing"); const publishingIndex = this.stages.indexOf("publishing"); const brief=JSON.parse(row.brief_json!) as FrozenBrief; const featureBuilds=this.featureBuildsFromResult(current,brief,result,at);
        const leasedFeature=this.featureQueue.list(projectId).find((feature)=>feature.status==="active"&&feature.id===leasedAtStart?.id);
        if(!result.validated){
          const successful=featureBuilds.filter((feature)=>feature.status==="succeeded"||feature.status==="no_change");
          const included=[...new Set([...this.safeJsonArray(current.included_json),...successful.map((feature)=>feature.proposalId)])];
          const deferred=featureBuilds.filter((feature)=>feature.status==="deferred").map((feature)=>feature.proposalId);
          const stableRelease=[...successful].reverse().find((feature)=>feature.releaseUrl)?.releaseUrl??null;
          steps[codingIndex]={...steps[codingIndex]!,status:"failed",at};steps[testingIndex]={...steps[testingIndex]!,status:"pending",at:null};
          this.db.query("UPDATE collaboration_builds SET status='failed',current_stage='failed',steps_json=?,included_json=?,deferred_json=?,completed_at=?,validated=?,release_url=?,failure=?,feature_builds_json=? WHERE round_id=?").run(JSON.stringify(steps),JSON.stringify(included),JSON.stringify(deferred),at,successful.length?1:0,stableRelease,result.failure??"Build validation failed.",JSON.stringify(featureBuilds),row.id);
          this.db.query("UPDATE collaboration_rounds SET phase='failed' WHERE id=?").run(row.id);
          if(leasedFeature?.leaseId){this.featureQueue.finish(leasedFeature.id,leasedFeature.leaseId,"failed",{failureCode:result.failure??"build_validation_failed"});if(leasedFeature.runId)this.featureQueue.completeRun(leasedFeature.runId,"failed");}
          activityLog("build.state.failed", { projectId, roundNumber: row.number, roundId: row.id, includedProposalIds: included.join(","), deferredProposalIds: deferred.join(","), releaseUrl: stableRelease, failure: result.failure ?? "Build validation failed." });event=this.phaseEvent(row,projectId,"failed");return;
        }
        const included=[...new Set([...this.safeJsonArray(current.included_json),...result.includedProposalIds])];
        const remaining=featureBuilds.find((feature)=>feature.status==="queued");
        this.db.query("UPDATE collaboration_builds SET included_json=?,deferred_json=?,release_url=?,feature_builds_json=? WHERE round_id=?").run(JSON.stringify(included),JSON.stringify(featureBuilds.filter((feature)=>feature.status==="deferred").map((feature)=>feature.proposalId)),result.releaseUrl,JSON.stringify(featureBuilds),row.id);
        if(result.releaseUrl)this.db.query("UPDATE projects SET stable_play_url=?,updated_at=? WHERE id=?").run(result.releaseUrl,at,projectId);
        if(leasedFeature?.leaseId){const featureResult=result.featureResults?.find((feature)=>feature.proposalId===leasedFeature.proposalId);this.featureQueue.finish(leasedFeature.id,leasedFeature.leaseId,featureResult?.status==="no_change"?"no_change":"succeeded",{releaseUrl:result.releaseUrl,delivery:featureResult?.delivery});if(leasedFeature.runId)this.featureQueue.completeRun(leasedFeature.runId,"completed");this.featureQueue.claim(projectId,result.releaseUrl);}
        steps[codingIndex] = { ...steps[codingIndex]!, status: "complete", at };
        steps[testingIndex] = { ...steps[testingIndex]!, status: "complete", at };
        steps[publishingIndex] = { ...steps[publishingIndex]!, status: "complete", at };
        if(remaining){
          const reset=this.stages.map((stage,index):BuildStep=>({stage,status:index===1?"active":"pending",at:index===1?at:null,detail:this.stageDetail(stage)}));
          const nextFeatures=featureBuilds.map((feature)=>feature.proposalId===remaining.proposalId?{...feature,status:"reviewing" as const,currentAgentLoop:"review" as const,startedAt:at,steps:[{loop:"review" as const,status:"active" as const,at,detail:this.loopDetail("review")}]}:feature);
          this.db.query("UPDATE collaboration_builds SET status='running',current_stage='analysing',steps_json=?,release_url=?,feature_builds_json=?,validated=1,previous_stable_url=? WHERE round_id=?").run(JSON.stringify(reset),result.releaseUrl,JSON.stringify(nextFeatures),result.releaseUrl,row.id);
          activityLog("build.feature.advanced",{projectId,roundNumber:row.number,roundId:row.id,completedProposalId:result.includedProposalIds[0]??null,activeProposalId:remaining.proposalId,releaseUrl:result.releaseUrl});
        }else{
          this.db.query("UPDATE collaboration_builds SET status='succeeded',current_stage='complete',steps_json=?,release_url=?,feature_builds_json=?,validated=1,completed_at=? WHERE round_id=?").run(JSON.stringify(steps),result.releaseUrl,JSON.stringify(featureBuilds),at,row.id);
          this.db.query("UPDATE collaboration_rounds SET phase='playtest' WHERE id=? AND phase='building'").run(row.id);
          activityLog("build.state.succeeded",{projectId,roundNumber:row.number,roundId:row.id,stage:"complete",releaseUrl:result.releaseUrl});
        }
        event = remaining?this.simpleEvent(row,projectId,"build_updated"):this.phaseEvent(row,projectId,"playtest");
      })();
      const member = this.anyMember(projectId); return member && event ? { round: this.currentRound(projectId, member), event, duplicate: false } : null;
    };
    const build = this.buildRow(row.id); if (!build || build.status !== "running") return null;
    if (build.current_stage === "coding") {
      const activeRun=this.activeBuildRuns.get(row.id);
      if(activeRun)return activeRun;
      const brief=JSON.parse(row.brief_json!) as FrozenBrief;
      try {
        const buildFeatures=this.featureBuilds(build,brief,this.parseReports(build.reports_json));
        const activeProposal=brief.selected.find((proposal)=>proposal.id===leasedAtStart?.proposalId);
        if(!activeProposal||!leasedAtStart?.runId)throw new Error("leased_feature_proposal_missing");
        const priorImplemented=brief.selected.filter((proposal)=>buildFeatures.some((feature)=>feature.proposalId===proposal.id&&(feature.status==="succeeded"||feature.status==="no_change")));
        const controller=new AbortController();this.activeBuildControllers.set(leasedAtStart.id,controller);const workspaceRef=`${projectId}/${leasedAtStart.runId}`;this.featureQueue.beginRun(leasedAtStart,workspaceRef);
        const result=this.buildAdapter.validate({...this.buildProject(projectId),roundNumber:row.number,previousStableUrl:leasedAtStart.baseCheckpoint??this.projectStableUrl(projectId),brief,activeProposal,priorImplemented,featureExecution:{featureId:leasedAtStart.id,runId:leasedAtStart.runId,workspaceRef,signal:controller.signal,onProgress:progress=>{this.featureQueue.updateRun(leasedAtStart.runId!,progress);this.recordBuildActivity(row.id,brief,activeProposal.id,progress);}}});
        if(result instanceof Promise){
          const run=result.then(applyResult).catch((error) => applyResult({ validated: false, includedProposalIds: [], deferredProposalIds: brief.selected.map((item)=>item.id), releaseUrl: null, failure: buildFailureMessage(error) }));
          let guarded!:Promise<RoundMutation|null>;
          guarded=run.finally(()=>{if(this.activeBuildRuns.get(row.id)===guarded)this.activeBuildRuns.delete(row.id);this.activeBuildControllers.delete(leasedAtStart.id);});
          this.activeBuildRuns.set(row.id,guarded);
          return guarded;
        }
        return applyResult(result);
      } catch (error) {
        return applyResult({ validated: false, includedProposalIds: [], deferredProposalIds: brief.selected.map((item)=>item.id), releaseUrl: null, failure: buildFailureMessage(error) });
      }
    }
    let event: RoundEvent | null = null;
    this.db.transaction(() => {
      const build = this.buildRow(row.id); if (!build || build.status !== "running") return;
      const index = this.stages.indexOf(build.current_stage); const nextStage = this.stages[index + 1]; if (!nextStage) return;
      const at = this.now(); const steps = JSON.parse(build.steps_json) as BuildStep[];
      steps[index] = { ...steps[index]!, status: "complete", at };
      steps[index + 1] = { ...steps[index + 1]!, status: nextStage === "complete" ? "complete" : "active", at };
      const complete = nextStage === "complete"; const releaseUrl = complete ? (this.buildRow(row.id)?.release_url ?? this.templateUrl(projectId)) : build.release_url;
      const brief=JSON.parse(row.brief_json!) as FrozenBrief;
      const featureBuilds=nextStage==="analysing"||nextStage==="coding"||nextStage==="testing"?this.markCurrentFeatureLoop(build,brief,this.activeLoopFromStage(nextStage)!,at):this.featureBuilds(build,brief,this.parseReports(build.reports_json));
      this.db.query("UPDATE collaboration_builds SET status = ?, current_stage = ?, steps_json = ?, completed_at = ?, validated = ?, release_url = ?, feature_builds_json = ? WHERE round_id = ?").run(complete ? "succeeded" : "running", nextStage, JSON.stringify(steps), complete ? at : null, complete ? 1 : 0, releaseUrl, JSON.stringify(featureBuilds), row.id);
      if (complete) { this.db.query("UPDATE collaboration_rounds SET phase = 'playtest' WHERE id = ? AND phase = 'building'").run(row.id); this.db.query("UPDATE projects SET stable_play_url = ?, updated_at = ? WHERE id = ?").run(releaseUrl, at, projectId); }
      activityLog(complete ? "build.state.succeeded" : "build.state.stage", { projectId, roundNumber: row.number, roundId: row.id, stage: nextStage, releaseUrl });
      event = complete ? this.phaseEvent(row, projectId, "playtest") : this.simpleEvent(row, projectId, "build_updated");
    })();
    const member = this.anyMember(projectId); return member && event ? { round: this.currentRound(projectId, member), event, duplicate: false } : null;
  }

  reportBuildProblem(projectId: string, number: number, accountId: string, rawNote: string): RoundMutation {
    this.requireMember(projectId, accountId);
    const note = rawNote.trim().replace(/\s+/g, " ").slice(0, 500);
    let event: RoundEvent | null = null;
    this.db.transaction(() => {
      const row = this.requiredRow(projectId, number);
      if (row.phase !== "building" && row.phase !== "playtest") throw this.error("report_not_available", "Reports are available while the game is building or being playtested.", 409);
      const build = this.buildRow(row.id);
      if (!build) throw this.error("build_not_ready", "The build is not ready to report.", 409);
      const brief = this.brief(row.brief_json);
      if (!brief) throw this.error("brief_not_ready", "The build brief is missing.", 409);
      const reports = this.parseReports(build.reports_json);
      const features = this.featureBuilds(build, brief, reports);
      const active = features.find((item) => item.currentAgentLoop) ?? [...features].reverse().find((item) => item.releaseUrl === build.release_url) ?? features.find((item) => !["succeeded","no_change","deferred"].includes(item.status)) ?? features[0] ?? null;
      const report: BuildReport = { id: randomUUID(), accountId, proposalId: active?.proposalId ?? null, note, reportedAt: this.now(), loop: active?.currentAgentLoop ?? null };
      const nextReports = [...reports, report];
      const at = report.reportedAt;
      const interrupted = features.map((feature) => feature.proposalId === active?.proposalId ? {
        ...feature,
        status: "interrupted" as const,
        currentAgentLoop: null,
        failure: note ? `Game is not running: ${note}` : "Game is not running report interrupted this feature.",
        steps: feature.steps.map((step) => step.status === "active" ? { ...step, status: "failed" as const, at } : step),
        reportCount: feature.reportCount + 1,
        latestReport: report,
        completedAt: at,
      } : feature);
      const previousStable = typeof build.previous_stable_url === "string" ? build.previous_stable_url : null;
      const failure = note ? `Game is not running: ${note}` : "Game is not running report interrupted this build.";
      this.db.query("UPDATE collaboration_builds SET status='interrupted', current_stage='failed', completed_at=?, validated=0, failure=?, feature_builds_json=?, reports_json=? WHERE round_id=?").run(at, failure, JSON.stringify(interrupted), JSON.stringify(nextReports), row.id);
      this.db.query("UPDATE collaboration_rounds SET phase='failed' WHERE id=?").run(row.id);
      this.db.query("UPDATE projects SET stable_play_url=?, updated_at=? WHERE id=?").run(previousStable, at, projectId);
      activityLog("build.report.interrupted", { projectId, roundNumber: row.number, roundId: row.id, proposalId: active?.proposalId ?? null, reportCount: nextReports.length, phase: row.phase });
      event = this.phaseEvent(row, projectId, "failed");
    })();
    return { round: this.round(projectId, number, accountId), event, duplicate: false };
  }

  deferInterruptedFeature(projectId: string, number: number, accountId: string): RoundMutation {
    this.requireMember(projectId, accountId);
    let event: RoundEvent | null = null;
    this.db.transaction(() => {
      const row = this.requiredRow(projectId, number);
      if (row.phase !== "failed" && row.phase !== "building") throw this.error("defer_not_available", "Only the active, interrupted, or failed feature can be deferred.", 409);
      const build = this.buildRow(row.id);
      const brief = this.brief(row.brief_json);
      if (!build || !brief) throw this.error("build_not_ready", "The build is not ready to defer.", 409);
      const reports = this.parseReports(build.reports_json);
      const features = this.featureBuilds(build, brief, reports);
      const activeLease=this.featureQueue.list(projectId).find(feature=>feature.status==="active");
      const target = (activeLease&&activeLease.roundId===row.id?features.find(feature=>feature.proposalId===activeLease.proposalId):null)??features.find((feature) => feature.status === "interrupted" || feature.status === "failed");
      if (!target) throw this.error("defer_not_available", "There is no active or failed feature to defer.", 409);
      const leased=this.featureQueue.list(projectId).find((feature)=>feature.status==="active"&&feature.proposalId===target.proposalId);let nextLease=null as ReturnType<ProjectFeatureQueue["claim"]>;if(leased?.leaseId){this.featureQueue.defer(leased.id,leased.leaseId);nextLease=this.featureQueue.claim(projectId,this.projectStableUrl(projectId));}
      if(leased){this.activeBuildControllers.get(leased.id)?.abort();this.activeBuildControllers.delete(leased.id);if(leased.runId)this.featureQueue.completeRun(leased.runId,"interrupted");}
      const deferred = features.map((feature) => feature.proposalId === target.proposalId ? { ...feature, status: "deferred" as const, currentAgentLoop: null, completedAt: feature.completedAt ?? this.now() } : feature);
      const continued=nextLease?.roundId===row.id?deferred.map(feature=>feature.proposalId===nextLease!.proposalId?{...feature,status:"reviewing" as const,currentAgentLoop:"review" as const,startedAt:this.now(),steps:[{loop:"review" as const,status:"active" as const,at:this.now(),detail:this.loopDetail("review")}]}:feature):deferred;
      const succeeded = continued.filter((feature) => (feature.status === "succeeded" || feature.status === "no_change") && feature.releaseUrl);
      const latest = succeeded.at(-1)?.releaseUrl ?? null;
      const continuing=nextLease?.roundId===row.id;const phase: RoundPhase = continuing?"building":latest ? "playtest" : "failed";const reset=this.stages.map((stage,index):BuildStep=>({stage,status:index===1?"active":"pending",at:index===1?this.now():null,detail:this.stageDetail(stage)}));
      this.db.query("UPDATE collaboration_builds SET status=?, current_stage=?,steps_json=?, validated=?, release_url=?, feature_builds_json=?, deferred_json=?,completed_at=? WHERE round_id=?").run(continuing?"running":latest ? "succeeded" : "interrupted",continuing?"analysing":latest ? "complete" : "failed",continuing?JSON.stringify(reset):build.steps_json,latest ? 1 : 0,latest,JSON.stringify(continued),JSON.stringify(continued.filter((feature) => feature.status === "deferred").map((feature) => feature.proposalId)),continuing?null:this.now(), row.id);
      this.db.query("UPDATE collaboration_rounds SET phase=? WHERE id=?").run(phase, row.id);
      if (latest) this.db.query("UPDATE projects SET stable_play_url=?, updated_at=? WHERE id=?").run(latest, this.now(), projectId);
      activityLog("build.feature.deferred", { projectId, roundNumber: row.number, roundId: row.id, proposalId: target.proposalId, phase });
      event = this.phaseEvent(row, projectId, phase);
    })();
    return { round: this.round(projectId, number, accountId), event, duplicate: false };
  }

  /** Persisted-data/test compatibility only; structured feedback has no HTTP or UI path. */
  submitLegacyFeedback(projectId: string, number: number, accountId: string, clientEventId: string, input: {worked:string;improve:string;nextIdea:string}): RoundMutation {
    this.requireMember(projectId, accountId); this.validateClientId(clientEventId);
    const values = [input.worked, input.improve, input.nextIdea].map((value) => value.trim().replace(/\s+/g, " "));
    if (values.some((value) => value.length > 500) || values.every((value) => !value)) throw this.error("invalid_feedback", "Add at least one feedback note; each field is limited to 500 characters.", 400);
    let event: RoundEvent | null = null; let duplicate = false;
    this.db.transaction(() => {
      const row = this.requiredRow(projectId, number); const delivered=this.build(row.id,this.brief(row.brief_json))?.featureBuilds?.some((feature)=>feature.status==="succeeded"||feature.status==="no_change"); if (row.phase !== "playtest" && !(row.phase==="building"&&delivered)) throw this.error("feedback_closed", "Legacy feedback is closed.", 409);
      const existing = this.db.query("SELECT id FROM collaboration_feedback WHERE round_id = ? AND client_event_id = ?").get(row.id, clientEventId);
      if (existing) { duplicate = true; return; }
      const at = this.now(); this.db.query("INSERT INTO collaboration_feedback VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), row.id, accountId, values[0] ?? "", values[1] ?? "", values[2] ?? "", clientEventId, at);
      event = this.simpleEvent(row, projectId, "feedback_submitted");
    })();
    return { round: this.round(projectId, number, accountId), event, duplicate };
  }

  /** Compatibility transition for existing persisted feedback; new clients use Brainstorm New Features. */
  closeLegacyFeedback(projectId: string, number: number, accountId: string): RoundMutation {
    this.requireOrganiser(projectId, accountId);
    if (!this.feedback(this.requiredRow(projectId,number).id).length) throw this.error("feedback_required", "Wait for at least one submitted feedback note before starting the next round.", 409);
    return this.startSuccessorBrainstorm(projectId,number,accountId);
  }

  startSuccessorBrainstorm(projectId:string,number:number,accountId:string):RoundMutation {
    this.requireMember(projectId,accountId);
    let duplicate=false;let event:RoundEvent|null=null;
    this.db.transaction(()=>{
      const source=this.requiredRow(projectId,number);
      const existing=this.row(projectId,number+1);
      if(existing){duplicate=true;return;}
      const brief=this.brief(source.brief_json);const build=this.build(source.id,brief);
      if(!brief||!build)throw this.error("build_not_started","Wait for Build to start before opening another brainstorm.",409);
      const project=this.db.query("SELECT p.id,p.name,gt.title AS templateTitle,gt.description AS templateDescription FROM projects p JOIN game_templates gt ON gt.id=p.selected_template_id WHERE p.id=?").get(projectId) as SummaryInput["project"];
      this.createSuccessor({schemaVersion:1,promptVersion:1,project,sourceRound:{id:source.id,number},feedback:this.feedback(source.id),release:build,brief},null);
    })();
    const current=this.currentRound(projectId,accountId);
    if(!duplicate)event=this.events(projectId,current.number,accountId,0).events[0]??null;
    return{round:current,event,duplicate};
  }
  private createSuccessor(input: SummaryInput, summary: FeedbackSummary | null): string {
    const { project, sourceRound, feedback } = input;
    const context: FeedbackContext = summary ? {
      roundNumber: sourceRound.number,
      worked: summary.worked.map((item) => item.text),
      improve: [...summary.needsAttention.map((item) => item.text), ...summary.questions.map((item) => `Open question: ${item.text}`)],
      nextIdeas: summary.suggestedUpdates.map((item) => `${item.title}: ${item.reason}`),
      requirementBacklog: this.requirementBacklog(input),
    } : { roundNumber: sourceRound.number, worked: feedback.map(x=>cleanPlayerIdea(x.worked)).filter(Boolean), improve: feedback.map(x=>cleanPlayerIdea(x.improve)).filter(Boolean), nextIdeas: feedback.map(x=>cleanPlayerIdea(x.nextIdea)).filter(Boolean), requirementBacklog: this.requirementBacklog(input) };
    const at = this.now(), id = randomUUID();
    this.db.query("INSERT INTO collaboration_rounds (id,project_id,number,phase,started_at,deadline_at,last_sequence,prior_feedback_json) VALUES (?,?,?,'brainstorm',?,?,0,?)").run(id,project.id,sourceRound.number+1,at,at+this.brainstormMs,JSON.stringify(context));
    this.simpleEvent(this.requiredRow(project.id,sourceRound.number+1),project.id,"round_started",{roundNumber:sourceRound.number+1,phase:"brainstorm"});
    return id;
  }

  private requirementBacklog(input: SummaryInput): RequirementBacklogItem[] {
    if (!input.brief) return [];
    const included = new Set(input.release?.includedProposalIds ?? []);
    const featureStatuses = new Map((input.release?.featureBuilds ?? []).map((feature) => [feature.proposalId, feature.status]));
    return input.brief.selected
      .filter((proposal) => !included.has(proposal.id))
      .map((proposal): RequirementBacklogItem => {
        const status = featureStatuses.get(proposal.id);
        return {
          proposalId: proposal.id,
          sourceRoundNumber: input.sourceRound.number,
          sourceRank: proposal.rank,
          title: proposal.title,
          playerChange: proposal.playerChange,
          implementationScope: proposal.implementationScope,
          acceptanceCriteria: proposal.acceptanceCriteria,
          status: status === "failed" || status === "interrupted" ? status : status === "deferred" ? "deferred" : "queued",
        };
      });
  }

  private closeBrainstormInternal(projectId: string, number: number, at: number, deadlineOnly: boolean): RoundEvent | Promise<RoundEvent | null> | null {
    const row = this.requiredRow(projectId, number); if (row.phase !== "brainstorm") return null;
    if (deadlineOnly && this.now() < row.deadline_at) return null;
    if (deadlineOnly && row.proposal_generation_status === "failed") return null;
    const active = this.activeProposalRuns.get(row.id); if (active) return active;
    const leaseExpiry = this.now() - 10 * 60_000;
    const claimed = this.db.query("UPDATE collaboration_rounds SET proposal_generation_status='running', proposal_generation_error=NULL, proposal_generation_attempts=proposal_generation_attempts+1, proposal_generation_lease_at=? WHERE id=? AND phase='brainstorm' AND (proposal_generation_status IN ('idle','failed') OR (proposal_generation_status='running' AND COALESCE(proposal_generation_lease_at,0)<?)) RETURNING id").get(this.now(), row.id, leaseExpiry) as {id:string}|null;
    if (!claimed) return null;
    const template = this.db.query("SELECT gt.title FROM projects p JOIN game_templates gt ON gt.id = p.selected_template_id WHERE p.id = ?").get(projectId) as {title:string};
    const contributions = this.humanContributions(row.id); const prior = this.feedbackContext(row.prior_feedback_json);
    // Existing unbuilt cards are application-owned backlog. Goose discovers only
    // this round's new cards; the server then appends every backlog card unchanged.
    const generationPrior = prior ? { ...prior, requirementBacklog: [] } : null;
    const input = { projectId, templateTitle: template.title, contributions, priorFeedback: generationPrior };
    const commit = (raw: ProposalGenerationResult | ProposalDraft[]): RoundEvent | null => {
      const generated = this.normalizeProposalResult(raw, contributions, []);
      this.validateProposalCoverage(generated, contributions, []);
      const backlog = prior?.requirementBacklog ?? [];
      const carried = backlog.map((item, index): ProposalDraft => ({
        cardKey: `carried-${index + 1}`,
        title: item.title,
        playerChange: item.playerChange,
        implementationScope: item.implementationScope,
        acceptanceCriteria: item.acceptanceCriteria,
        ideaReferences: [],
        backlogReferences: [item.proposalId],
      }));
      const drafts = [...generated.proposals, ...carried];
      const result: ProposalGenerationResult = {
        ...generated,
        proposals: drafts,
        backlogDecisions: backlog.map((item, index) => ({ backlogProposalId: item.proposalId, operation: "retain", resultingCardKey: carried[index]!.cardKey!, reason: "Carried forward unchanged until implemented." })),
      };
      let event: RoundEvent | null = null;
      this.db.transaction(() => {
      const fresh = this.requiredRow(projectId, number); if (fresh.phase !== "brainstorm") return;
      const insert = this.db.query("INSERT OR IGNORE INTO collaboration_proposals (id, round_id, position, title, player_change, implementation_scope, acceptance_json, idea_refs_json, backlog_refs_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      drafts.forEach((draft, index) => insert.run(randomUUID(), fresh.id, index + 1, draft.title, draft.playerChange, draft.implementationScope, JSON.stringify(draft.acceptanceCriteria), JSON.stringify(draft.ideaReferences), JSON.stringify(draft.backlogReferences), at));
      this.db.query("UPDATE collaboration_rounds SET phase = 'proposals', closed_at = ?, proposal_generation_status='complete', proposal_generation_error=NULL, proposal_generation_lease_at=NULL, proposal_reconciliation_json=? WHERE id = ? AND phase = 'brainstorm' AND proposal_generation_status='running'").run(at, JSON.stringify({schemaVersion:2,backlogDecisions:result.backlogDecisions,contributionDecisions:result.contributionDecisions}), fresh.id);
      event = this.phaseEvent(fresh, projectId, "proposals");
      })();
      return event;
    };
    try {
      const generated = this.generator.generate(input);
      if (!(generated instanceof Promise)) return commit(generated);
      const run = generated.then(commit).catch((error) => { this.failProposalGeneration(row.id,error); throw error instanceof SummaryError ? error : new SummaryError("provider_error"); }).finally(()=>this.activeProposalRuns.delete(row.id));
      this.activeProposalRuns.set(row.id,run); return run;
    } catch (error) {
      this.failProposalGeneration(row.id,error);
      throw error instanceof SummaryError ? error : new SummaryError("provider_error");
    }
  }

  private closeVotingInternal(projectId: string, number: number, at: number, deadlineOnly: boolean): RoundEvent | null {
    let event: RoundEvent | null = null;
    this.db.transaction(() => {
      const row = this.requiredRow(projectId, number); if (row.phase !== "voting") return;
      if (deadlineOnly && row.voting_deadline_at !== null && this.now() < row.voting_deadline_at) return;
      const ranked = this.rankings(row.id); if (!ranked.length) throw this.error("proposals_not_ready", "At least one proposal is required.", 409);
      const selected = ranked;
      const brief: FrozenBrief = { committed: selected[0]!, stretch: selected.slice(1), selected, frozenAt: at, tieBreakRule: "Vote tokens descending, then first-token votes, second-token votes, proposal position, and proposal ID." };
      this.db.query("UPDATE collaboration_rounds SET phase = 'brief', brief_json = ? WHERE id = ? AND phase = 'voting'").run(JSON.stringify(brief), row.id);
      this.featureQueue.reconcile(projectId,row.id,selected);
      event = this.simpleEvent(row, projectId, "vote_closed", { phase: "brief" });
    })();
    if (!event) return null;
    const organiser = this.db.query("SELECT t.creator_account_id AS account_id FROM projects p JOIN teams t ON t.id=p.team_id WHERE p.id=?").get(projectId) as {account_id:string}|null;
    if (!organiser) throw this.error("organiser_not_found", "The build could not start because the team organiser was not found.", 409);
    return this.startBuild(projectId, number, organiser.account_id).event;
  }

  private hydrate(row: RoundRow, accountId: string): RoundSnapshot {
    const proposals = this.proposals(row.id); const selections = (this.db.query("SELECT proposal_id FROM collaboration_votes WHERE round_id = ? AND account_id = ? ORDER BY vote_rank, proposal_id").all(row.id, accountId) as Array<{proposal_id:string}>).map((x) => x.proposal_id);
    const brief = this.brief(row.brief_json);
    const backgroundRow = this.db.query("SELECT r.* FROM collaboration_rounds r JOIN collaboration_builds b ON b.round_id=r.id WHERE r.project_id=? AND r.id<>? AND b.status IN ('running','failed','interrupted') ORDER BY r.number DESC LIMIT 1").get(row.project_id,row.id) as RoundRow|null;
    const backgroundBrief = backgroundRow ? this.brief(backgroundRow.brief_json) : null;
    const backgroundBuild = backgroundRow && backgroundBrief ? this.build(backgroundRow.id, backgroundBrief) : null;
    return { id: row.id, projectId: row.project_id, number: row.number, phase: row.phase, startedAt: row.started_at, deadlineAt: row.deadline_at, votingDeadlineAt: row.voting_deadline_at, closedAt: row.closed_at, serverTime: this.now(), lastSequence: row.last_sequence, proposalVoteAllowance: adminSettings().proposalVoteAllowance, contributions: this.contributions(row.id), proposals, selections, rankings: ["brief","building","playtest","failed"].includes(row.phase) ? this.rankings(row.id) : null, brief, build: this.build(row.id, brief), feedback: this.feedback(row.id), feedbackHistory: this.feedbackHistory(row.project_id), versionHistory:this.versionHistory(row.project_id), priorFeedback: this.feedbackContext(row.prior_feedback_json), activeBuild: backgroundBuild && backgroundBrief ? {roundNumber:backgroundRow!.number,brief:backgroundBrief,build:backgroundBuild}:null, proposalGeneration:{status:row.proposal_generation_status??(row.phase==="proposals"?"complete":"idle"),error:row.proposal_generation_error??null,attempts:row.proposal_generation_attempts??0},brainstormSeed:{status:row.brainstorm_seed_status??"idle",error:row.brainstorm_seed_error??null,attempts:row.brainstorm_seed_attempts??0},proposalReconciliation:this.proposalReconciliation(row.proposal_reconciliation_json),
      summaryRun: this.summaries.view(row.id, Boolean(this.db.query("SELECT 1 FROM projects p JOIN teams t ON t.id=p.team_id WHERE p.id=? AND t.creator_account_id=?").get(row.project_id,accountId))),
      summaryMessages: this.summaries.messages(row.project_id,new Set(this.feedbackHistory(row.project_id).flatMap(r=>r.feedback.map(f=>f.id)))) };
  }
  private contributions(roundId: string): RoundContribution[] { return (this.db.query("SELECT c.*, a.nostr_npub FROM collaboration_contributions c JOIN accounts a ON a.id=c.author_account_id WHERE c.round_id=? ORDER BY c.sequence").all(roundId) as any[]).map((x) => ({id:x.id,roundId:x.round_id,authorAccountId:x.author_account_id,authorNpub:x.nostr_npub,body:x.body,clientEventId:x.client_event_id,sequence:x.sequence,createdAt:x.created_at,authorKind:x.author_kind==="bot"?"bot":"member",authorLabel:typeof x.author_label==="string"&&x.author_label?x.author_label:undefined,attachments:this.parseAttachments(x.attachments_json)})); }
  private humanContributions(roundId: string): RoundContribution[] { return this.contributions(roundId).filter((item) => item.authorKind !== "bot"); }
  private contribution(roundId:string, clientId:string): RoundContribution|null { return this.contributions(roundId).find((x)=>x.clientEventId===clientId)??null; }
  private contributionEvent(projectId:string, contribution:RoundContribution):RoundEvent { return {roundId:contribution.roundId,projectId,sequence:contribution.sequence,type:"contribution_committed",createdAt:contribution.createdAt,contribution}; }
  private proposals(roundId:string):Proposal[] { return (this.db.query("SELECT * FROM collaboration_proposals WHERE round_id=? ORDER BY position,id").all(roundId) as any[]).map((x)=>({id:x.id,roundId:x.round_id,position:x.position,title:x.title,playerChange:x.player_change,implementationScope:x.implementation_scope,acceptanceCriteria:JSON.parse(x.acceptance_json),ideaReferences:JSON.parse(x.idea_refs_json),backlogReferences:this.safeJsonArray(x.backlog_refs_json)})); }
  private rankings(roundId:string):RankedProposal[] {
    const rows=this.db.query("SELECT proposal_id,COUNT(*) votes,SUM(CASE WHEN vote_rank=1 THEN 1 ELSE 0 END) first_place,SUM(CASE WHEN vote_rank=2 THEN 1 ELSE 0 END) second_place,SUM(CASE WHEN vote_rank=3 THEN 1 ELSE 0 END) third_place FROM collaboration_votes WHERE round_id=? GROUP BY proposal_id").all(roundId) as Array<{proposal_id:string;votes:number;first_place:number;second_place:number;third_place:number}>;
    const counts=new Map(rows.map((x)=>[x.proposal_id,x]));
    return this.proposals(roundId).map((p)=>{const count=counts.get(p.id);return{...p,votes:count?.votes??0,firstPlaceVotes:count?.first_place??0,secondPlaceVotes:count?.second_place??0,thirdPlaceVotes:count?.third_place??0,rank:0};}).sort((a,b)=>b.votes-a.votes||b.firstPlaceVotes-a.firstPlaceVotes||b.secondPlaceVotes-a.secondPlaceVotes||a.position-b.position||a.id.localeCompare(b.id)).map((p,i)=>({...p,rank:i+1}));
  }
  private feedback(roundId:string):MemberFeedback[] { return (this.db.query("SELECT f.*,a.nostr_npub FROM collaboration_feedback f JOIN accounts a ON a.id=f.author_account_id WHERE f.round_id=? ORDER BY f.submitted_at,f.id").all(roundId) as any[]).map((x)=>({id:x.id,authorAccountId:x.author_account_id,authorNpub:x.nostr_npub,worked:x.worked,improve:x.improve,nextIdea:x.next_idea,clientEventId:x.client_event_id,submittedAt:x.submitted_at})); }
  private feedbackHistory(projectId:string):RoundFeedbackHistory[] {
    const rounds=this.db.query("SELECT id,number FROM collaboration_rounds WHERE project_id=? ORDER BY number").all(projectId) as Array<{id:string;number:number}>;
    return rounds.map((round)=>({roundNumber:round.number,feedback:this.feedback(round.id)})).filter((round)=>round.feedback.length>0);
  }
  private versionHistory(projectId:string):ProjectVersionHistoryEntry[] {
    const rows=this.db.query("SELECT r.number,r.brief_json,b.* FROM collaboration_rounds r JOIN collaboration_builds b ON b.round_id=r.id WHERE r.project_id=? ORDER BY r.number").all(projectId) as Array<any>;
    return rows.flatMap((row)=>{
      const brief=this.brief(row.brief_json);if(!brief)return[];
      const proposals=new Map(brief.selected.map((proposal)=>[proposal.id,proposal]));
      return this.featureBuilds(row,brief,this.parseReports(row.reports_json)).flatMap((feature):ProjectVersionHistoryEntry[]=>{
        if((feature.status!=="succeeded"&&feature.status!=="no_change")||!feature.releaseUrl)return[];
        const proposal=proposals.get(feature.proposalId);if(!proposal)return[];
        return [{roundNumber:row.number,proposalId:feature.proposalId,title:proposal.title,playerChange:proposal.playerChange,status:feature.status,releaseUrl:feature.releaseUrl,completedAt:feature.completedAt}];
      });
    }).sort((a,b)=>a.roundNumber-b.roundNumber||(a.completedAt??0)-(b.completedAt??0)||a.releaseUrl.localeCompare(b.releaseUrl));
  }
  private feedbackContext(serialized:string|null):FeedbackContext|null {
    if(!serialized)return null;try{const value:unknown=JSON.parse(serialized);if(!value||typeof value!=="object")return null;const context=value as {roundNumber?:unknown;worked?:unknown;improve?:unknown;nextIdeas?:unknown;requirementBacklog?:unknown};if(!Number.isSafeInteger(context.roundNumber)||Number(context.roundNumber)<1)return null;const strings=(items:unknown)=>Array.isArray(items)?items.filter((item):item is string=>typeof item==="string"):[];return{roundNumber:Number(context.roundNumber),worked:strings(context.worked),improve:strings(context.improve),nextIdeas:strings(context.nextIdeas),requirementBacklog:this.normalizeRequirementBacklog(context.requirementBacklog)};}catch{return null;}
  }
  private normalizeRequirementBacklog(value:unknown):RequirementBacklogItem[] {
    if(!Array.isArray(value))return[];
    return value.filter((item):item is Record<string,unknown>=>Boolean(item)&&typeof item==="object"&&!Array.isArray(item)).map((item):RequirementBacklogItem|null=>{
      const status=typeof item.status==="string"&&["queued","deferred","failed","interrupted"].includes(item.status)?item.status as RequirementBacklogItem["status"]:"deferred";
      const criteria=Array.isArray(item.acceptanceCriteria)?item.acceptanceCriteria.filter((criterion):criterion is string=>typeof criterion==="string"&&Boolean(criterion.trim())).slice(0,5):[];
      if(typeof item.proposalId!=="string"||typeof item.title!=="string"||typeof item.playerChange!=="string"||typeof item.implementationScope!=="string"||!criteria.length)return null;
      return{proposalId:item.proposalId,sourceRoundNumber:Number.isSafeInteger(item.sourceRoundNumber)?Number(item.sourceRoundNumber):0,sourceRank:Number.isSafeInteger(item.sourceRank)?Number(item.sourceRank):0,title:item.title,playerChange:item.playerChange,implementationScope:item.implementationScope,acceptanceCriteria:criteria,status};
    }).filter((item):item is RequirementBacklogItem=>Boolean(item));
  }
  private validateProposalCoverage(result: ProposalGenerationResult, contributions: RoundContribution[], backlog: RequirementBacklogItem[]): void {
    const drafts=result.proposals;
    const sourceCount = contributions.length + backlog.length;
    if (sourceCount < 1 || sourceCount > MAX_PROPOSAL_SOURCES || !Array.isArray(drafts) || drafts.length < 1 || drafts.length > Math.min(MAX_PROPOSAL_CARDS, sourceCount)) throw new SummaryError("invalid_output");
    const ideaRefs = drafts.flatMap((draft) => draft.ideaReferences);
    const backlogRefs = drafts.flatMap((draft) => draft.backlogReferences);
    const allowedIdeas = new Set(contributions.map((item) => item.sequence));
    const allowedBacklog = new Set(backlog.map((item) => item.proposalId));
    if (ideaRefs.some((ref) => !allowedIdeas.has(ref)) || backlogRefs.some((ref) => !allowedBacklog.has(ref))) throw new SummaryError("invalid_output");
    if (new Set(ideaRefs).size !== ideaRefs.length || new Set(backlogRefs).size !== backlogRefs.length) throw new SummaryError("invalid_output");
    if(result.schemaVersion!==2||result.contributionDecisions.length!==contributions.length||result.backlogDecisions.length!==backlog.length)throw new SummaryError("invalid_output");
    if(new Set(result.contributionDecisions.map(x=>x.contributionSequence)).size!==contributions.length||new Set(result.backlogDecisions.map(x=>x.backlogProposalId)).size!==backlog.length)throw new SummaryError("invalid_output");
    if(result.contributionDecisions.some(x=>x.operation==="include"?!ideaRefs.includes(x.contributionSequence):ideaRefs.includes(x.contributionSequence)))throw new SummaryError("invalid_output");
    if(result.backlogDecisions.some(x=>x.operation==="delete"?backlogRefs.includes(x.backlogProposalId):!backlogRefs.includes(x.backlogProposalId)))throw new SummaryError("invalid_output");
  }
  private normalizeProposalResult(raw:ProposalGenerationResult|ProposalDraft[],contributions:RoundContribution[],backlog:RequirementBacklogItem[]):ProposalGenerationResult {
    if(!Array.isArray(raw))return raw;
    const proposals=raw.slice(0,MAX_PROPOSAL_CARDS);
    return{schemaVersion:2,proposals,backlogDecisions:backlog.map(item=>{const card=proposals.find(candidate=>candidate.backlogReferences.includes(item.proposalId));return card?{backlogProposalId:item.proposalId,operation:"retain",resultingCardKey:card.cardKey??null,reason:"Injected legacy generator retained this source."}:{backlogProposalId:item.proposalId,operation:"delete",resultingCardKey:null,reason:"Not selected within the five highest-priority cards."};}),contributionDecisions:contributions.map(item=>{const card=proposals.find(candidate=>candidate.ideaReferences.includes(item.sequence));return card?{contributionSequence:item.sequence,operation:"include",resultingCardKey:card.cardKey??null,reason:"Injected legacy generator included this source."}:{contributionSequence:item.sequence,operation:"reject",resultingCardKey:null,reason:"Not selected within the five highest-priority cards."};})};
  }
  private failProposalGeneration(roundId:string,error:unknown):void { const code=error instanceof SummaryError?error.code:"provider_error";this.db.query("UPDATE collaboration_rounds SET proposal_generation_status='failed',proposal_generation_error=?,proposal_generation_lease_at=NULL WHERE id=? AND phase='brainstorm'").run(agentErrorMessage(code),roundId); }
  private proposalReconciliation(serialized:string|null):ProposalReconciliation|null { if(!serialized)return null;try{const value=JSON.parse(serialized) as ProposalReconciliation;return value?.schemaVersion===2&&Array.isArray(value.backlogDecisions)&&Array.isArray(value.contributionDecisions)?value:null;}catch{return null;} }
  private buildRow(roundId:string):any|null { return this.db.query("SELECT * FROM collaboration_builds WHERE round_id=?").get(roundId) as any|null; }
  private brief(serialized:string|null):FrozenBrief|null { if(!serialized)return null;const brief=JSON.parse(serialized) as FrozenBrief;return Array.isArray(brief.selected)?brief:{...brief,selected:[brief.committed,...brief.stretch]}; }
  private build(roundId:string, brief:FrozenBrief|null=null):BuildRun|null {
    const x=this.buildRow(roundId);
    if(!x)return null;
    const reports=this.parseReports(x.reports_json);
    const featureBuilds=this.featureBuilds(x,brief,reports);
    const activeFeature=featureBuilds.find((item)=>item.currentAgentLoop) ?? featureBuilds.find((item)=>["reviewing","building","testing","failed","interrupted"].includes(item.status)) ?? featureBuilds.find((item)=>item.status==="queued") ?? null;
    return {id:x.id,status:x.status,currentStage:x.current_stage,simulated:Boolean(x.simulated),steps:JSON.parse(x.steps_json),includedProposalIds:JSON.parse(x.included_json),deferredProposalIds:JSON.parse(x.deferred_json),startedAt:x.started_at,completedAt:x.completed_at,validated:Boolean(x.validated),releaseUrl:x.release_url,failure:x.failure,featureBuilds,activeFeatureProposalId:activeFeature?.proposalId??null,reportCount:reports.length,latestReport:reports.at(-1)??null,previousStableUrl:typeof x.previous_stable_url==="string"?x.previous_stable_url:null};
  }
  private initialFeatureBuilds(brief:FrozenBrief):FeatureBuild[] {
    return brief.selected.map((proposal,index)=>({proposalId:proposal.id,queuePosition:index+1,status:"queued",currentAgentLoop:null,steps:[],releaseUrl:null,failure:null,reportCount:0,latestReport:null,startedAt:null,completedAt:null,activity:[]}));
  }
  private recordBuildActivity(roundId:string,brief:FrozenBrief,proposalId:string,value:unknown):void {
    if(!value||typeof value!=="object")return;
    const progress=value as {phase?:unknown;changedFiles?:unknown;activityMessage?:unknown};
    if(progress.phase!=="inspecting"&&progress.phase!=="editing"&&progress.phase!=="testing"&&progress.phase!=="repairing")return;
    const changedFiles=Array.isArray(progress.changedFiles)?progress.changedFiles.filter((item):item is string=>typeof item==="string").length:0;
    const authored=typeof progress.activityMessage==="string"?progress.activityMessage.trim().replace(/\bGoose\b/gi,"LvlUP"):"";
    const message=authored|| (progress.phase==="inspecting"?"LvlUP opened the project workspace and is inspecting the game.":progress.phase==="editing"?(changedFiles?`LvlUP updated ${changedFiles} game ${changedFiles===1?"file":"files"} and is checking the feature against the brief.`:"LvlUP is implementing the selected feature in the game workspace."):progress.phase==="testing"?"The code changes are ready. Level Up is running the feature checks.":"LvlUP is reviewing the latest result and preparing another implementation pass.");
    const build=this.buildRow(roundId);if(!build||build.status!=="running")return;
    const features=this.featureBuilds(build,brief,this.parseReports(build.reports_json));
    const at=this.now();
    const next=features.map((feature)=>{if(feature.proposalId!==proposalId)return feature;const activity=feature.activity??[];if(activity.at(-1)?.message===message)return feature;return{...feature,activity:[...activity,{phase:progress.phase,message,at}].slice(-6)};});
    this.db.query("UPDATE collaboration_builds SET feature_builds_json=? WHERE round_id=? AND status='running'").run(JSON.stringify(next),roundId);
  }
  private featureBuilds(build:any, brief:FrozenBrief|null, reports:BuildReport[]):FeatureBuild[] {
    const parsed=this.parseFeatureBuilds(build.feature_builds_json);
    const base=parsed.length?parsed:(brief?this.deriveFeatureBuilds(build,brief):[]);
    return base.map((feature)=>{const featureReports=reports.filter((report)=>report.proposalId===feature.proposalId);return{...feature,reportCount:featureReports.length,latestReport:featureReports.at(-1)??feature.latestReport??null};});
  }
  private deriveFeatureBuilds(build:any, brief:FrozenBrief):FeatureBuild[] {
    const steps=JSON.parse(build.steps_json) as BuildStep[];
    const included=new Set(this.safeJsonArray(build.included_json));
    const deferred=new Set(this.safeJsonArray(build.deferred_json));
    const activeLoop=this.activeLoopFromStage(build.current_stage as BuildStage);
    return brief.selected.map((proposal,index):FeatureBuild=>{
      const succeeded=included.has(proposal.id)&&Boolean(build.validated);
      const status:FeatureBuildStatus=succeeded?"succeeded":deferred.has(proposal.id)&&build.status!=="running"?"deferred":index===0?this.featureStatusFromStage(build.current_stage as BuildStage, build.status):"queued";
      const loops=this.visibleLoops.map((loop):FeatureBuildStep|null=>{
        const stage=loop==="review"?"analysing":loop==="build"?"coding":"testing";
        const step=steps.find((item)=>item.stage===stage);
        if(!step||step.status==="pending")return null;
        return {loop,status:step.status==="active"?"active":step.status==="failed"?"failed":"complete",at:step.at,detail:this.loopDetail(loop)};
      }).filter((item):item is FeatureBuildStep=>Boolean(item));
      return {proposalId:proposal.id,queuePosition:index+1,status,currentAgentLoop:status==="reviewing"||status==="building"||status==="testing"?activeLoop:null,steps:loops,releaseUrl:succeeded?build.release_url:null,failure:status==="failed"||status==="interrupted"?build.failure:null,reportCount:0,latestReport:null,startedAt:index===0?build.started_at:null,completedAt:succeeded||status==="failed"||status==="interrupted"?build.completed_at:null};
    });
  }
  private featureStatusFromStage(stage:BuildStage,status:string):FeatureBuildStatus {
    if(status==="interrupted")return"interrupted";
    if(status==="failed"||stage==="failed")return"failed";
    if(stage==="analysing")return"reviewing";
    if(stage==="coding")return"building";
    if(stage==="testing"||stage==="publishing")return"testing";
    if(stage==="complete")return"succeeded";
    return"queued";
  }
  private activeLoopFromStage(stage:BuildStage):FeatureAgentLoop|null { return stage==="analysing"?"review":stage==="coding"?"build":stage==="testing"||stage==="publishing"?"test":null; }
  private loopDetail(loop:FeatureAgentLoop):string { return ({review:"LvlUP is reviewing the card scope against the frozen vote.",build:"LvlUP is editing the playable game for this card.",test:"Level Up is browser-validating the playable output."})[loop]; }
  private markCurrentFeatureLoop(build:any, brief:FrozenBrief, loop:FeatureAgentLoop, at:number):FeatureBuild[] {
    const reports=this.parseReports(build.reports_json);
    const features=this.featureBuilds(build,brief,reports);
    const active=features.find((item)=>!["succeeded","no_change","deferred"].includes(item.status))??features[0];
    if(!active)return features;
    const status:FeatureBuildStatus=loop==="review"?"reviewing":loop==="build"?"building":"testing";
    return features.map((feature)=>{
      if(feature.proposalId!==active.proposalId)return feature;
      const steps=this.visibleLoops.map((item):FeatureBuildStep|null=>{
        const existing=feature.steps.find((step)=>step.loop===item);
        if(item===loop)return{loop:item,status:"active",at,detail:this.loopDetail(item)};
        if(this.visibleLoops.indexOf(item)<this.visibleLoops.indexOf(loop))return{loop:item,status:existing?.status==="failed"?"failed":"complete",at:existing?.at??at,detail:this.loopDetail(item)};
        return existing&&existing.status!=="active"?existing:null;
      }).filter((item):item is FeatureBuildStep=>Boolean(item));
      return{...feature,status,currentAgentLoop:loop,steps,startedAt:feature.startedAt??at};
    });
  }
  private featureBuildsFromResult(build:any, brief:FrozenBrief, result:BuildAdapterResult, at:number):FeatureBuild[] {
    const reports=this.parseReports(build.reports_json);
    const existing=this.featureBuilds(build,brief,reports);
    const resultMap=new Map((result.featureResults??[]).map((item)=>[item.proposalId,item]));
    const included=new Set(result.includedProposalIds);
    const deferred=new Set(result.deferredProposalIds);
    const firstOpen=existing.find((item)=>!["succeeded","no_change","deferred"].includes(item.status))?.proposalId??brief.selected[0]?.id??null;
    return existing.map((feature)=>{
      const explicit=resultMap.get(feature.proposalId);
      const releaseUrl=explicit?.releaseUrl??(included.has(feature.proposalId)?result.releaseUrl:null);
      if((feature.status==="succeeded"||feature.status==="no_change")&&explicit?.status!=="succeeded"&&explicit?.status!=="no_change")return feature;
      if(explicit?.status==="succeeded"||explicit?.status==="no_change"||(result.validated&&included.has(feature.proposalId))){
        const testingAt=feature.activity?.find((update)=>update.phase==="testing")?.at??at;
        return{...feature,status:explicit?.status==="no_change"?"no_change":"succeeded",currentAgentLoop:null,steps:this.visibleLoops.map((loop)=>({loop,status:"complete" as const,at:feature.steps.find((step)=>step.loop===loop)?.at??(loop==="test"?testingAt:at),detail:this.loopDetail(loop)})),releaseUrl,failure:null,startedAt:feature.startedAt??build.started_at,completedAt:at,delivery:explicit?.delivery??feature.delivery};
      }
      if(explicit?.status==="failed"||(!result.validated&&feature.proposalId===firstOpen)){
        const failure=explicit?.failure??result.failure??"Build validation failed.";
        const steps=feature.steps.length?feature.steps:[{loop:"build" as const,status:"failed" as const,at,detail:this.loopDetail("build")}];
        return{...feature,status:"failed",currentAgentLoop:null,steps:steps.map((step)=>step.status==="active"?{...step,status:"failed" as const,at}:step),releaseUrl:null,failure,startedAt:feature.startedAt??build.started_at,completedAt:at};
      }
      if(explicit?.status==="deferred"||(result.validated&&deferred.has(feature.proposalId))){
        return{...feature,status:"deferred",currentAgentLoop:null,failure:feature.failure,completedAt:feature.completedAt??at};
      }
      return feature;
    });
  }
  private parseFeatureBuilds(serialized:unknown):FeatureBuild[] { if(typeof serialized!=="string"||!serialized)return[];try{const value:unknown=JSON.parse(serialized);return Array.isArray(value)?value.filter((item):item is FeatureBuild=>Boolean(item)&&typeof item==="object"&&typeof (item as FeatureBuild).proposalId==="string"&&Number.isSafeInteger((item as FeatureBuild).queuePosition)):[];}catch{return[];} }
  private parseReports(serialized:unknown):BuildReport[] { if(typeof serialized!=="string"||!serialized)return[];try{const value:unknown=JSON.parse(serialized);return Array.isArray(value)?value.filter((item):item is BuildReport=>Boolean(item)&&typeof item==="object"&&typeof (item as BuildReport).id==="string"&&typeof (item as BuildReport).accountId==="string"&&typeof (item as BuildReport).reportedAt==="number"):[];}catch{return[];} }
  private safeJsonArray(serialized:unknown):string[] { if(typeof serialized!=="string")return[];try{const value:unknown=JSON.parse(serialized);return Array.isArray(value)?value.filter((item):item is string=>typeof item==="string"):[];}catch{return[];} }
  private templateUrl(projectId:string):string { return (this.db.query("SELECT gt.preview_url FROM projects p JOIN game_templates gt ON gt.id=p.selected_template_id WHERE p.id=?").get(projectId) as {preview_url:string}).preview_url; }
  private projectStableUrl(projectId:string):string|null { return (this.db.query("SELECT stable_play_url FROM projects WHERE id=?").get(projectId) as {stable_play_url:string|null}|null)?.stable_play_url??null; }
  private buildProject(projectId:string):Omit<BuildAdapterInput,"roundNumber"|"brief"|"previousStableUrl"> { const row=this.db.query("SELECT p.id AS projectId,p.name AS projectName,gt.title AS templateTitle,gt.preview_url AS templatePreviewUrl FROM projects p JOIN game_templates gt ON gt.id=p.selected_template_id WHERE p.id=?").get(projectId) as Omit<BuildAdapterInput,"roundNumber"|"brief"|"previousStableUrl">|null; if(!row)throw this.error("template_not_ready","Choose a template before building.",409); return row; }
  private currentRow(projectId:string):RoundRow|null { return this.db.query("SELECT * FROM collaboration_rounds WHERE project_id=? ORDER BY number DESC LIMIT 1").get(projectId) as RoundRow|null; }
  private row(projectId:string,number:number):RoundRow|null { return this.db.query("SELECT * FROM collaboration_rounds WHERE project_id=? AND number=?").get(projectId,number) as RoundRow|null; }
  private requiredRow(projectId:string,number:number):RoundRow { const row=this.row(projectId,number); if(!row) throw this.error("round_not_found",`Round ${number} does not exist.`,404); return row; }
  private next(roundId:string):number { return (this.db.query("UPDATE collaboration_rounds SET last_sequence=last_sequence+1 WHERE id=? RETURNING last_sequence").get(roundId) as {last_sequence:number}).last_sequence; }
  private simpleEvent(row:RoundRow,projectId:string,type:RoundEventType,extra:Partial<RoundEvent>={}):RoundEvent { const event={roundId:row.id,projectId,sequence:this.next(row.id),type,createdAt:this.now(),...extra}; this.insertEvent(event); return event; }
  private phaseEvent(row:RoundRow,projectId:string,phase:RoundPhase):RoundEvent { return this.simpleEvent(row,projectId,"phase_changed",{phase}); }
  private insertEvent(event:RoundEvent):void { const {roundId,projectId,sequence,type,createdAt,...payload}=event; this.db.query("INSERT INTO collaboration_events VALUES (?,?,?,?,?)").run(roundId,sequence,type,JSON.stringify(payload),createdAt); }
  private parseAttachments(serialized:unknown):RoundContributionAttachment[] { if(typeof serialized!=="string"||!serialized)return[];try{return normalizeContributionAttachments(JSON.parse(serialized));}catch{return[];} }
  private botSuggestions(roundId:string):string[] { return (this.db.query("SELECT body FROM collaboration_contributions WHERE round_id=? AND author_kind='bot' ORDER BY sequence").all(roundId) as Array<{body:string}>).map(x=>x.body); }
  private latestBotSequence(roundId:string):number|null { return (this.db.query("SELECT MAX(sequence) AS sequence FROM collaboration_contributions WHERE round_id=? AND author_kind='bot'").get(roundId) as {sequence:number|null}).sequence; }
  private freshHumanContributions(roundId:string):RoundContribution[] { const lastBot=this.latestBotSequence(roundId); return this.humanContributions(roundId).filter((item)=>lastBot===null||item.sequence>lastBot); }
  private hasBotSuggestion(roundId:string,body:string):boolean { const normalized=normalizeSuggestionText(body); return this.botSuggestions(roundId).some((item)=>normalizeSuggestionText(item)===normalized); }
  private currentSuggestionIntervalMs(): number {
    const value = typeof this.suggestionIntervalMs === "function" ? this.suggestionIntervalMs() : this.suggestionIntervalMs;
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_SUGGESTION_INTERVAL_MS;
  }

  private suggestionDue(roundId:string):boolean { const row=this.db.query("SELECT MAX(created_at) AS at FROM collaboration_contributions WHERE round_id=? AND author_kind='bot'").get(roundId) as {at:number|null}; return row.at===null || this.now()-row.at>=this.currentSuggestionIntervalMs(); }
  private claimBrainstormSeed(roundId:string):boolean { return this.db.query("UPDATE collaboration_rounds SET brainstorm_seed_status='running',brainstorm_seed_error=NULL,brainstorm_seed_attempts=brainstorm_seed_attempts+1,brainstorm_seed_lease_at=? WHERE id=? AND brainstorm_seed_status IN ('idle','failed') RETURNING id").get(this.now(),roundId)!==null; }
  private failBrainstormSeed(roundId:string,error:unknown):void { const message=error instanceof SummaryError?agentErrorMessage(error.code):agentErrorMessage("provider_error");this.db.query("UPDATE collaboration_rounds SET brainstorm_seed_status='failed',brainstorm_seed_error=?,brainstorm_seed_lease_at=NULL WHERE id=? AND brainstorm_seed_status='running'").run(message,roundId); }
  private recoverBrainstormSeeds():void { this.db.query("UPDATE collaboration_rounds SET brainstorm_seed_status='failed',brainstorm_seed_error='lvl_up was interrupted before posting starter ideas. Keep this room open to retry.',brainstorm_seed_lease_at=NULL WHERE brainstorm_seed_status='running'").run(); }
  private ensureBotAccount():void { this.db.query("INSERT OR IGNORE INTO accounts (id, nostr_pubkey, nostr_npub, created_at) VALUES (?, ?, ?, ?)").run(LEVEL_UP_BOT_ACCOUNT_ID, LEVEL_UP_BOT_PUBKEY, LEVEL_UP_BOT_NPUB, this.now()); }
  private validateClientId(value:string):void { if(value.trim().length<8||value.length>128) throw this.error("invalid_client_event_id","Use a valid client event ID.",400); }
  private requireMember(projectId:string,accountId:string):void { if(!this.db.query("SELECT 1 FROM projects p JOIN team_members tm ON tm.team_id=p.team_id WHERE p.id=? AND tm.account_id=?").get(projectId,accountId)) throw this.error("forbidden","You are not a member of this project's team.",403); }
  private requireOrganiser(projectId:string,accountId:string):void { const x=this.db.query("SELECT t.creator_account_id FROM projects p JOIN teams t ON t.id=p.team_id WHERE p.id=?").get(projectId) as {creator_account_id:string}|null; if(!x||x.creator_account_id!==accountId) throw this.error("forbidden","Only the team organiser can do that.",403); }
  private anyMember(projectId:string):string|null { return (this.db.query("SELECT tm.account_id FROM projects p JOIN team_members tm ON tm.team_id=p.team_id WHERE p.id=? ORDER BY tm.joined_at LIMIT 1").get(projectId) as {account_id:string}|null)?.account_id??null; }
  private error(code:string,message:string,status:number):LoopError { return new LoopError(code,message,status); }
  private stageDetail(stage:BuildStage):string { return ({preparing:"Freezing the voted game-change brief.",analysing:"Checking the committed change and stretch compatibility.",coding:"Asking LvlUP to edit and browser-validate the playable game.",testing:"Recording generated game validation evidence.",publishing:"Publishing the immutable playable release.",complete:"Validated playable release ready to play.",failed:"The build failed; the prior release remains playable."})[stage]; }

  private migrate():void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS collaboration_rounds (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, number INTEGER NOT NULL CHECK(number>0), phase TEXT NOT NULL CHECK(phase IN ('brainstorm','proposals','voting','brief','building','playtest','failed')), started_at INTEGER NOT NULL, deadline_at INTEGER NOT NULL, voting_deadline_at INTEGER, closed_at INTEGER, last_sequence INTEGER NOT NULL DEFAULT 0, brief_json TEXT, prior_feedback_json TEXT, proposal_generation_status TEXT NOT NULL DEFAULT 'idle', proposal_generation_error TEXT, proposal_generation_attempts INTEGER NOT NULL DEFAULT 0, proposal_generation_lease_at INTEGER, proposal_reconciliation_json TEXT, brainstorm_seed_status TEXT NOT NULL DEFAULT 'idle', brainstorm_seed_error TEXT, brainstorm_seed_attempts INTEGER NOT NULL DEFAULT 0, brainstorm_seed_lease_at INTEGER, UNIQUE(project_id,number));
      CREATE TABLE IF NOT EXISTS collaboration_contributions (id TEXT PRIMARY KEY, round_id TEXT NOT NULL REFERENCES collaboration_rounds(id) ON DELETE CASCADE, author_account_id TEXT NOT NULL REFERENCES accounts(id), body TEXT NOT NULL, client_event_id TEXT NOT NULL, sequence INTEGER NOT NULL, created_at INTEGER NOT NULL, author_kind TEXT NOT NULL DEFAULT 'member' CHECK(author_kind IN ('member','bot')), author_label TEXT, attachments_json TEXT NOT NULL DEFAULT '[]', UNIQUE(round_id,client_event_id),UNIQUE(round_id,sequence));
      CREATE TABLE IF NOT EXISTS collaboration_events (round_id TEXT NOT NULL REFERENCES collaboration_rounds(id) ON DELETE CASCADE, sequence INTEGER NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(round_id,sequence));
      CREATE TABLE IF NOT EXISTS collaboration_proposals (id TEXT PRIMARY KEY, round_id TEXT NOT NULL REFERENCES collaboration_rounds(id) ON DELETE CASCADE, position INTEGER NOT NULL, title TEXT NOT NULL, player_change TEXT NOT NULL, implementation_scope TEXT NOT NULL, acceptance_json TEXT NOT NULL, idea_refs_json TEXT NOT NULL, backlog_refs_json TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, UNIQUE(round_id,position));
      CREATE TABLE IF NOT EXISTS collaboration_votes (round_id TEXT NOT NULL REFERENCES collaboration_rounds(id) ON DELETE CASCADE, account_id TEXT NOT NULL REFERENCES accounts(id), proposal_id TEXT NOT NULL REFERENCES collaboration_proposals(id), vote_rank INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL, PRIMARY KEY(round_id,account_id,vote_rank));
      CREATE TABLE IF NOT EXISTS collaboration_builds (id TEXT PRIMARY KEY, round_id TEXT NOT NULL UNIQUE REFERENCES collaboration_rounds(id) ON DELETE CASCADE, status TEXT NOT NULL, current_stage TEXT NOT NULL, steps_json TEXT NOT NULL, included_json TEXT NOT NULL, deferred_json TEXT NOT NULL, started_at INTEGER NOT NULL, completed_at INTEGER, validated INTEGER NOT NULL, release_url TEXT, failure TEXT);
      CREATE TABLE IF NOT EXISTS collaboration_feedback (id TEXT PRIMARY KEY, round_id TEXT NOT NULL REFERENCES collaboration_rounds(id) ON DELETE CASCADE, author_account_id TEXT NOT NULL REFERENCES accounts(id), worked TEXT NOT NULL, improve TEXT NOT NULL, next_idea TEXT NOT NULL, client_event_id TEXT NOT NULL, submitted_at INTEGER NOT NULL, UNIQUE(round_id,client_event_id));
      CREATE INDEX IF NOT EXISTS collaboration_rounds_project_idx ON collaboration_rounds(project_id,number);
      CREATE INDEX IF NOT EXISTS collaboration_events_round_idx ON collaboration_events(round_id,sequence);
    `);
    const legacy = this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='rounds'").get();
    if (legacy) {
      this.db.exec(`INSERT OR IGNORE INTO collaboration_rounds (id,project_id,number,phase,started_at,deadline_at,closed_at,last_sequence)
        SELECT id,project_id,number,phase,started_at,deadline_at,closed_at,last_sequence FROM rounds;
        INSERT OR IGNORE INTO collaboration_contributions (id,round_id,author_account_id,body,client_event_id,sequence,created_at) SELECT id,round_id,author_account_id,body,client_event_id,sequence,created_at FROM round_contributions;
        INSERT OR IGNORE INTO collaboration_events SELECT * FROM round_events;`);
    }
    const columns = new Set((this.db.query("PRAGMA table_info(collaboration_contributions)").all() as Array<{name:string}>).map(column => column.name));
    const roundColumns = new Set((this.db.query("PRAGMA table_info(collaboration_rounds)").all() as Array<{name:string}>).map(column => column.name));
    if(!roundColumns.has("proposal_generation_status"))this.db.query("ALTER TABLE collaboration_rounds ADD COLUMN proposal_generation_status TEXT NOT NULL DEFAULT 'idle'").run();
    if(!roundColumns.has("proposal_generation_error"))this.db.query("ALTER TABLE collaboration_rounds ADD COLUMN proposal_generation_error TEXT").run();
    if(!roundColumns.has("proposal_generation_attempts"))this.db.query("ALTER TABLE collaboration_rounds ADD COLUMN proposal_generation_attempts INTEGER NOT NULL DEFAULT 0").run();
    if(!roundColumns.has("proposal_generation_lease_at"))this.db.query("ALTER TABLE collaboration_rounds ADD COLUMN proposal_generation_lease_at INTEGER").run();
    if(!roundColumns.has("proposal_reconciliation_json"))this.db.query("ALTER TABLE collaboration_rounds ADD COLUMN proposal_reconciliation_json TEXT").run();
    if(!roundColumns.has("brainstorm_seed_status"))this.db.query("ALTER TABLE collaboration_rounds ADD COLUMN brainstorm_seed_status TEXT NOT NULL DEFAULT 'idle'").run();
    if(!roundColumns.has("brainstorm_seed_error"))this.db.query("ALTER TABLE collaboration_rounds ADD COLUMN brainstorm_seed_error TEXT").run();
    if(!roundColumns.has("brainstorm_seed_attempts"))this.db.query("ALTER TABLE collaboration_rounds ADD COLUMN brainstorm_seed_attempts INTEGER NOT NULL DEFAULT 0").run();
    if(!roundColumns.has("brainstorm_seed_lease_at"))this.db.query("ALTER TABLE collaboration_rounds ADD COLUMN brainstorm_seed_lease_at INTEGER").run();
    if (!columns.has("author_kind")) this.db.query("ALTER TABLE collaboration_contributions ADD COLUMN author_kind TEXT NOT NULL DEFAULT 'member'").run();
    if (!columns.has("author_label")) this.db.query("ALTER TABLE collaboration_contributions ADD COLUMN author_label TEXT").run();
    if (!columns.has("attachments_json")) this.db.query("ALTER TABLE collaboration_contributions ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'").run();
    const proposalColumns = new Set((this.db.query("PRAGMA table_info(collaboration_proposals)").all() as Array<{name:string}>).map(column => column.name));
    if (!proposalColumns.has("backlog_refs_json")) this.db.query("ALTER TABLE collaboration_proposals ADD COLUMN backlog_refs_json TEXT NOT NULL DEFAULT '[]'").run();
    const buildColumns = new Set((this.db.query("PRAGMA table_info(collaboration_builds)").all() as Array<{name:string}>).map(column => column.name));
    if (!buildColumns.has("simulated")) this.db.query("ALTER TABLE collaboration_builds ADD COLUMN simulated INTEGER NOT NULL DEFAULT 1").run();
    if (!buildColumns.has("feature_builds_json")) this.db.query("ALTER TABLE collaboration_builds ADD COLUMN feature_builds_json TEXT NOT NULL DEFAULT '[]'").run();
    if (!buildColumns.has("reports_json")) this.db.query("ALTER TABLE collaboration_builds ADD COLUMN reports_json TEXT NOT NULL DEFAULT '[]'").run();
    if (!buildColumns.has("previous_stable_url")) this.db.query("ALTER TABLE collaboration_builds ADD COLUMN previous_stable_url TEXT").run();
    const voteColumns = new Set((this.db.query("PRAGMA table_info(collaboration_votes)").all() as Array<{name:string}>).map(column => column.name));
    if (!voteColumns.has("vote_rank")) this.db.query("ALTER TABLE collaboration_votes ADD COLUMN vote_rank INTEGER NOT NULL DEFAULT 1").run();
    const voteInfo = this.db.query("PRAGMA table_info(collaboration_votes)").all() as Array<{name:string;pk:number}>;
    const votePk = voteInfo.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name).join(",");
    if (votePk !== "round_id,account_id,vote_rank") {
      this.db.transaction(() => {
        this.db.exec(`
          DROP TABLE IF EXISTS collaboration_votes_next;
          CREATE TABLE collaboration_votes_next (round_id TEXT NOT NULL REFERENCES collaboration_rounds(id) ON DELETE CASCADE, account_id TEXT NOT NULL REFERENCES accounts(id), proposal_id TEXT NOT NULL REFERENCES collaboration_proposals(id), vote_rank INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL, PRIMARY KEY(round_id,account_id,vote_rank));
          INSERT OR IGNORE INTO collaboration_votes_next (round_id, account_id, proposal_id, vote_rank, updated_at)
          SELECT round_id, account_id, proposal_id, token_rank, updated_at FROM (
            SELECT round_id, account_id, proposal_id, updated_at, ROW_NUMBER() OVER (PARTITION BY round_id, account_id ORDER BY vote_rank, updated_at, proposal_id) AS token_rank
            FROM collaboration_votes
          ) WHERE token_rank <= 3;
          DROP TABLE collaboration_votes;
          ALTER TABLE collaboration_votes_next RENAME TO collaboration_votes;
        `);
      })();
    }
  }

  private recoverProposals():void {
    this.db.query("UPDATE collaboration_rounds SET proposal_generation_status='idle',proposal_generation_error=NULL,proposal_generation_lease_at=NULL WHERE phase='brainstorm' AND proposal_generation_status='running'").run();
    this.db.query("UPDATE collaboration_rounds SET phase='brainstorm',closed_at=NULL,proposal_generation_status='failed',proposal_generation_error='Stored proposals were incomplete. Retry the proposal agent.',proposal_generation_lease_at=NULL WHERE phase='proposals' AND NOT EXISTS (SELECT 1 FROM collaboration_proposals p WHERE p.round_id=collaboration_rounds.id)").run();
  }
}
