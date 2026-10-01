import { SummaryError, invalidAgentOutput, object } from "./feedback-summary";
import { renderAgentPrompt } from "./admin-prompts";
import { agentConfig, runGooseJson, type AgentConfig, type AgentConfigOptions } from "./feedback-agent";
import { MAX_PROPOSAL_CARDS, MAX_PROPOSAL_SOURCES, type BacklogDecision, type BrainstormSuggestionGenerator, type BrainstormSuggestionInput, type ContributionDecision, type ProposalDraft, type ProposalGenerationResult, type ProposalGenerator, type ProposalGeneratorInput } from "./loop";
import { activityLog } from "./activity-log";

export const PROPOSAL_SCHEMA_VERSION = 2;
export const MAX_PROPOSAL_BYTES = 200_000;

export function proposalAgentConfig(options: AgentConfigOptions = {}): AgentConfig {
  const env = options.env ?? process.env;
  return agentConfig({ env: {
    ...env,
    LEVELUP_AGENT_MAX_OUTPUT_TOKENS: env.LEVELUP_PROPOSAL_MAX_OUTPUT_TOKENS ?? "6000",
    LEVELUP_AGENT_MAX_INPUT_BYTES: env.LEVELUP_PROPOSAL_MAX_INPUT_BYTES ?? env.LEVELUP_AGENT_MAX_INPUT_BYTES,
    LEVELUP_AGENT_TIMEOUT_SECONDS: env.LEVELUP_PROPOSAL_TIMEOUT_SECONDS ?? "180",
    LEVELUP_AGENT_TOTAL_TIMEOUT_SECONDS: env.LEVELUP_PROPOSAL_TOTAL_TIMEOUT_SECONDS ?? "900",
  }, modelResolution: options.modelResolution ?? (options.env ? "environment" : "admin") });
}

export function proposalPrompt(input: ProposalGeneratorInput): string {
  return renderAgentPrompt("proposal_generation", agentPromptInput(input));
}

export function brainstormSuggestionPrompt(input: BrainstormSuggestionInput): string {
  return renderAgentPrompt("brainstorm_suggestion", agentPromptInput(input));
}

/**
 * Screenshot bytes belong to the room snapshot, not a text-model prompt. Passing
 * a data URL here both wastes context and can reject an otherwise tiny idea
 * before Goose starts. Keep bounded metadata so the agent still knows that the
 * player attached visual context without copying the image payload.
 */
function agentPromptInput(input: ProposalGeneratorInput | BrainstormSuggestionInput): Record<string, unknown> {
  return {
    templateTitle: input.templateTitle,
    contributions: input.contributions.map((contribution) => ({
      sequence: contribution.sequence,
      body: contribution.body,
      attachments: contribution.attachments?.map(({ dataUrl: _dataUrl, id: _id, ...attachment }) => attachment),
    })),
    priorFeedback: input.priorFeedback ? {
      worked: input.priorFeedback.worked,
      improve: input.priorFeedback.improve,
      nextIdeas: input.priorFeedback.nextIdeas,
      requirementBacklog: input.priorFeedback.requirementBacklog?.map((item) => ({ proposalId: item.proposalId, title: item.title, playerChange: item.playerChange, implementationScope: item.implementationScope, acceptanceCriteria: item.acceptanceCriteria })),
    } : null,
    ...( "roundNumber" in input ? { roundNumber: input.roundNumber, previousSuggestions: input.previousSuggestions, mode: input.mode ?? "nudge" } : {}),
  };
}

function text(value: unknown, limit: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit) throw new SummaryError("invalid_output");
  return value.trim();
}

function textAlias(card: Record<string, unknown>, keys: string[], limit: number): string {
  for (const key of keys) if (key in card) return text(card[key], limit);
  throw new SummaryError("invalid_output");
}

function arrayAlias(card: Record<string, unknown>, keys: string[], defaultWhenAbsent?: unknown[]): unknown[] {
  for (const key of keys) if (key in card) {
    const value = card[key];
    if (Array.isArray(value)) return value;
    if (typeof value === "string" && value.trim()) return value.split(/\n+|;+/).map((item) => item.trim()).filter(Boolean);
    throw new SummaryError("invalid_output");
  }
  if (defaultWhenAbsent) return defaultWhenAbsent;
  invalidAgentOutput(keys[0]!, `provide ${keys[0]} as a JSON array`);
}

function proposalPayload(value: unknown): Record<string,unknown> {
  const root = object(value);
  for (const key of ["payload", "arguments", "input"]) {
    const nested = root[key];
    if (nested && typeof nested === "object") return proposalPayload(nested);
  }
  if(root.schemaVersion!==PROPOSAL_SCHEMA_VERSION)invalidAgentOutput("schemaVersion", `use ${PROPOSAL_SCHEMA_VERSION}`);
  if(!Array.isArray(root.proposals))invalidAgentOutput("proposals", "provide a JSON array of distinct change cards");
  return root;
}

function criterionText(value: unknown): string {
  if (typeof value === "string") return text(value, 180);
  const criterion = object(value);
  return textAlias(criterion, ["text", "criterion", "description", "acceptanceCriterion"], 180);
}

function referenceNumber(value: unknown, allowedSequences: Set<number>): number {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const ref = value as Record<string, unknown>;
    return referenceNumber(ref.sequence ?? ref.contributionSequence ?? ref.ideaSequence ?? ref.id, allowedSequences);
  }
  const numeric = typeof value === "string" && /^#?\d+$/.test(value.trim()) ? Number(value.trim().replace(/^#/, "")) : value;
  if (!Number.isSafeInteger(numeric) || !allowedSequences.has(Number(numeric))) invalidAgentOutput("ideaReferences", `use only allowed human contribution sequences: ${[...allowedSequences].join(", ") || "none"}`);
  return Number(numeric);
}

function stringReference(value: unknown, allowed: Set<string>): string {
  const reference = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>).proposalId : value;
  if (typeof reference !== "string" || !allowed.has(reference)) invalidAgentOutput("backlogReferences", `use only allowed backlog proposal IDs: ${[...allowed].join(", ") || "none"}`);
  return reference;
}

function validateProposalDrafts(value: unknown, allowedSequences: Set<number>, allowedBacklog: Set<string>): ProposalGenerationResult {
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_PROPOSAL_BYTES) throw new SummaryError("output_too_large");
  const payload=proposalPayload(value);const proposals=(payload.proposals as unknown[]).slice(0,MAX_PROPOSAL_CARDS);
  const sourceCount = allowedSequences.size + allowedBacklog.size;
  if (sourceCount < 1 || sourceCount > MAX_PROPOSAL_SOURCES || proposals.length < 1) invalidAgentOutput("proposals", "return at least one usable card");
  const drafts = proposals.map((item): ProposalDraft => {
    const card = object(item);
    const criteria = arrayAlias(card, ["acceptanceCriteria", "acceptance_criteria", "criteria", "testableAcceptanceCriteria", "testable_acceptance_criteria"]);
    if (criteria.length < 1 || criteria.length > 5) throw new SummaryError("invalid_output");
    const references = arrayAlias(card, ["ideaReferences", "idea_references", "ideaReferenceSequences", "idea_reference_sequences", "contributionSequences", "contribution_sequences", "sourceSequences", "source_sequences"], allowedSequences.size === 0 ? [] : undefined);
    if (references.length > Math.max(1, allowedSequences.size)) throw new SummaryError("invalid_output");
    const refs = references.map((ref) => referenceNumber(ref, allowedSequences));
    if (new Set(refs).size !== refs.length) throw new SummaryError("invalid_output");
    const backlogValues = arrayAlias(card, ["backlogReferences", "backlog_references", "backlogProposalIds", "backlog_proposal_ids"], allowedBacklog.size === 0 ? [] : undefined);
    if (backlogValues.length > allowedBacklog.size) throw new SummaryError("invalid_output");
    const backlogReferences = backlogValues.map((ref) => stringReference(ref, allowedBacklog));
    if (new Set(backlogReferences).size !== backlogReferences.length) throw new SummaryError("invalid_output");
    return {
      cardKey:text(card.cardKey,80),
      title: text(card.title, 80),
      playerChange: textAlias(card, ["playerChange", "player_change", "description", "playerFacingExplanation", "player_facing_explanation", "playerExplanation", "playerOutcome", "visibleOutcome"], 360),
      implementationScope: textAlias(card, ["implementationScope", "implementation_scope", "scope", "implementationPlan", "implementation_plan", "technicalScope"], 500),
      acceptanceCriteria: criteria.map(criterionText),
      ideaReferences: refs,
      backlogReferences,
    };
  });
  const referencedIdeas = new Set(drafts.flatMap((draft) => draft.ideaReferences));
  const referencedBacklog = new Set(drafts.flatMap((draft) => draft.backlogReferences));
  if (drafts.reduce((count, draft) => count + draft.ideaReferences.length, 0) !== referencedIdeas.size || drafts.reduce((count, draft) => count + draft.backlogReferences.length, 0) !== referencedBacklog.size) invalidAgentOutput("proposals", "cite each allowed source on at most one card");
  const cardKeys=new Set(drafts.map(card=>card.cardKey!));if(cardKeys.size!==drafts.length)invalidAgentOutput("proposals.cardKey", "use a unique stable cardKey for every card");
  const suppliedBacklog = Array.isArray(payload.backlogDecisions) ? payload.backlogDecisions as unknown[] : [];
  const explicitBacklog = suppliedBacklog.flatMap((item):BacklogDecision[]=>{const decision=object(item);if(decision.operation!=="delete")return[];return[{backlogProposalId:stringReference(decision.backlogProposalId,allowedBacklog),operation:"delete",resultingCardKey:null,reason:text(decision.reason,300)}];});
  const suppliedContributions = Array.isArray(payload.contributionDecisions) ? payload.contributionDecisions as unknown[] : [];
  const explicitContributions = suppliedContributions.flatMap((item):ContributionDecision[]=>{const decision=object(item);if(decision.operation!=="reject")return[];return[{contributionSequence:referenceNumber(decision.contributionSequence,allowedSequences),operation:"reject",resultingCardKey:null,reason:text(decision.reason,300)}];});
  if(new Set(explicitBacklog.map(x=>x.backlogProposalId)).size!==explicitBacklog.length)invalidAgentOutput("backlogDecisions","provide no more than one explicit decision per backlog source");
  if(new Set(explicitContributions.map(x=>x.contributionSequence)).size!==explicitContributions.length)invalidAgentOutput("contributionDecisions","provide no more than one explicit decision per human source");
  const backlogDecisions: BacklogDecision[] = [...allowedBacklog].map((id) => explicitBacklog.find((decision) => decision.backlogProposalId === id) ?? (() => { const card=drafts.find((draft)=>draft.backlogReferences.includes(id)); return card?{backlogProposalId:id,operation:"retain" as const,resultingCardKey:card.cardKey!,reason:"Reflected by the cited proposal card."}:{backlogProposalId:id,operation:"delete" as const,resultingCardKey:null,reason:"Not selected within the five highest-priority cards."}; })());
  const contributionDecisions: ContributionDecision[] = [...allowedSequences].map((sequence) => explicitContributions.find((decision) => decision.contributionSequence === sequence) ?? (() => { const card=drafts.find((draft)=>draft.ideaReferences.includes(sequence)); return card?{contributionSequence:sequence,operation:"include" as const,resultingCardKey:card.cardKey!,reason:"Reflected by the cited proposal card."}:{contributionSequence:sequence,operation:"reject" as const,resultingCardKey:null,reason:"Not selected within the five highest-priority cards."}; })());
  for(const decision of backlogDecisions){const card=drafts.find(x=>x.cardKey===decision.resultingCardKey);if(decision.operation!=="delete"&&!card?.backlogReferences.includes(decision.backlogProposalId))invalidAgentOutput("backlogDecisions",`decision for ${decision.backlogProposalId} must match the card that cites it`);}
  for(const decision of contributionDecisions){const card=drafts.find(x=>x.cardKey===decision.resultingCardKey);if(decision.operation==="include"&&!card?.ideaReferences.includes(decision.contributionSequence))invalidAgentOutput("contributionDecisions",`decision for ${decision.contributionSequence} must match the card that cites it`);}
  if(backlogDecisions.some(x=>x.operation==="delete"&&referencedBacklog.has(x.backlogProposalId))||contributionDecisions.some(x=>x.operation==="reject"&&referencedIdeas.has(x.contributionSequence)))invalidAgentOutput("decisions","do not cite a source that is explicitly deleted or rejected");
  return{schemaVersion:2,proposals:drafts,backlogDecisions,contributionDecisions};
}

export class GooseProposalGenerator implements ProposalGenerator {
  constructor(readonly config: AgentConfig = proposalAgentConfig(), private readonly localPreflightHost?: string) {}
  async generate(input: ProposalGeneratorInput): Promise<ProposalGenerationResult> {
    const allowedSequences = new Set(input.contributions.map((item) => item.sequence));
    const allowedBacklog = new Set((input.priorFeedback?.requirementBacklog ?? []).map((item) => item.proposalId));
    const result = await runGooseJson(
      this.config,
      proposalPrompt(input),
      new AbortController().signal,
      () => undefined,
      value => validateProposalDrafts(value, allowedSequences, allowedBacklog),
      { localPreflightHost: this.localPreflightHost, maxOutputBytes: MAX_PROPOSAL_BYTES, clientName: "level-up-proposals", stage: "proposal_generation", fields: { projectId: input.projectId ?? null, contributions: input.contributions.length } },
    );
    activityLog("agent.proposals.validated", { proposals: result.output.proposals.length, contributions: input.contributions.length });
    return result.output;
  }
}

export function validateSuggestion(value: unknown, mode: "seed" | "nudge" = "nudge"): string {
  if (new TextEncoder().encode(JSON.stringify(value)).length > 2_000) throw new SummaryError("output_too_large");
  let root = object(value);
  if ("schemaVersion" in root && root.schemaVersion !== (mode === "seed" ? 2 : 1)) throw new SummaryError("invalid_output");
  for (const key of ["payload", "arguments", "input"]) {
    const nested = root[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      root = object(nested);
      break;
    }
  }
  if (mode === "seed") {
    if (root.schemaVersion !== 2 || !Array.isArray(root.starterIdeas) || root.starterIdeas.length !== 2) throw new SummaryError("invalid_output");
    const ideas = root.starterIdeas.map((idea) => text(idea, 180));
    if (normalizeIdea(ideas[0]!) === normalizeIdea(ideas[1]!)) throw new SummaryError("invalid_output");
    const message = `Here are two ways we could start: 1. ${ideas[0]} 2. ${ideas[1]}`;
    if (message.length > 500 || /schemaVersion|JSON|proposal card|implementation scope|acceptance criteria|vote|voting|tool/i.test(message)) throw new SummaryError("invalid_output");
    return message;
  }
  if (root.schemaVersion !== 1) throw new SummaryError("invalid_output");
  const message = text(root.message, 240);
  if (/schemaVersion|JSON|proposal card|implementation scope|acceptance criteria|vote|voting|tool/i.test(message)) throw new SummaryError("invalid_output");
  return message;
}

function normalizeIdea(value:string):string { return value.toLowerCase().replace(/[^a-z0-9]+/g," ").trim(); }

export class GooseBrainstormSuggestionGenerator implements BrainstormSuggestionGenerator {
  constructor(readonly config: AgentConfig = proposalAgentConfig(), private readonly localPreflightHost?: string) {}
  async suggest(input: BrainstormSuggestionInput): Promise<string> {
    const result = await runGooseJson(
      this.config,
      brainstormSuggestionPrompt(input),
      new AbortController().signal,
      () => undefined,
      value => validateSuggestion(value, input.mode ?? "nudge"),
      { localPreflightHost: this.localPreflightHost, maxOutputBytes: 2_000, clientName: "level-up-brainstorm", stage: "brainstorm_suggestion", fields: { projectId: input.projectId ?? null, roundNumber: input.roundNumber, contributions: input.contributions.length, previousSuggestions: input.previousSuggestions.length } },
    );
    activityLog("agent.brainstorm_suggestion.validated", { roundNumber: input.roundNumber, characters: result.output.length });
    return result.output;
  }
}
