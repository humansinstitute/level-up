import { normalizeSummaryMessages, normalizeSummaryRun, type SummaryAuthor, type SummaryMessage } from "./feedback-summary";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { nip19, type Event, type EventTemplate } from "nostr-tools";
import { IdentityVault } from "./identity-vault";
import { browserPersistenceAvailable, clientDb, type RoundOutboxRecord } from "./client-db";
import { parseInviteSecret, pendingInviteFromLocation } from "./invites";
import { ProfileService, profileFromEvent, type PublicProfile } from "./profiles";
import { PROFILE_STALE_MS, selectLatestProfile } from "./profile-data";
import { avatarDataUri, generatedNickname } from "./player-identity";
import { DeviceSigner, Nip07Signer, type NostrSigner } from "./signer";
import type { BuildActivityUpdate, BuildReport, BuildRun, FeatureBuild, FeatureBuildStep, FrozenBrief, MemberFeedback, ProjectVersionHistoryEntry, Proposal, RankedProposal, RequirementBacklogItem, RoundContribution as DomainRoundContribution, RoundContributionAttachment, RoundPhase, RoundSnapshot as DomainRoundSnapshot } from "./loop";

interface User { npub: string }
export interface TeamMember { accountId: string; npub: string; role: "organiser" | "player" }
export interface ProjectSummary { id: string; teamId: string; name: string; phase: ProjectPhase; selectedTemplateId: string | null; stablePlayUrl: string | null; createdAt: number }
export interface Team { id: string; sessionId: string; name: string; phase: "lobby"; isOrganiser: boolean; members: TeamMember[]; projects: ProjectSummary[]; profiles?: PublicProfile[] }
export type ProjectPhase = "selecting_template" | "resolving_template_tie" | "round_1_brainstorm";
export interface GameTemplate { id: string; title: string; description: string; themePrompts: string[]; previewUrl: string; visual: string; votes?: number }
export type RoundContribution = DomainRoundContribution;
export type RoundSnapshot = DomainRoundSnapshot;
export interface ProjectRoom extends ProjectSummary { teamName: string; isOrganiser: boolean; selectionStartedAt: number; selectionDeadlineAt: number; selectionClosedAt: number | null; serverTime: number; templates: GameTemplate[]; selections: string[]; rankings: GameTemplate[]; topThree: GameTemplate[]; tiedLeaderIds: string[]; selectedTemplate: GameTemplate | null; round: RoundSnapshot | null; captain?: { accountId:string; npub:string; roundNumber:number } | null; profiles?: PublicProfile[] }
interface Invite { secret: string; url: string; expiresAt: number | null }
interface Challenge { nonce: string; expiresAt: number; event: EventTemplate }
type AgentPromptStageId = "brainstorm_suggestion" | "proposal_generation" | "feature_build" | "build_run" | "game_edit" | "feedback_summary";
interface AgentPromptRecord { id: AgentPromptStageId; label: string; stage: string; description: string; template: string; defaultTemplate: string; isDefault: boolean; updatedAt: number | null; modelMode: "default" | "specific"; model: string | null; effectiveModel: string }
interface AdminSettingsRecord { brainstormSuggestionIntervalSeconds: number; brainstormSuggestionIntervalMs: number; agentMaxTurns: number; proposalVoteAllowance: number; allowedModels: string[]; defaultModel: string; updatedAt: number | null }
interface AdminProjectSummary extends ProjectSummary { teamName: string; joinedCount:number; connectedCount:number|null; activeInvite:boolean; selectionStartedAt:number; selectionClosedAt:number|null; captain:{accountId:string;npub:string;roundNumber:number}|null; failure:{code:string;section:string}|null; round: { id: string; number: number; phase: RoundPhase; lastSequence: number; buildStatus: string | null; buildStage: string | null } | null }
interface AdminTeamSummary { id:string; name:string; memberCount:number; projectCount:number; createdAt:number }
type GroupCommand="open_play"|"start_voting"|"extend_voting"|"close_voting"|"start_first_brainstorm"|"pause"|"resume";
interface GroupRun {id:string;name:string;status:"draft"|"running"|"paused"|"completed";initialStage:string;selectedProjectIds:string[];results:Array<{projectId:string;command:GroupCommand;status:"succeeded"|"failed"|"skipped";code:string|null;message:string;at:number}>;createdAt:number;updatedAt:number}
type GroupModeRequest = { sequence:number; editRevision:number };
interface TraceBody { value: unknown; bytes: number; truncated: boolean }
interface AgentModelTurn extends TraceBody { number: number; observedAt: number; source: "provider" | "acp" }
interface AgentRunTrace { id: string; stage: string; clientName: string; model: string | null; maxTurns: number; status: "running" | "succeeded" | "failed"; startedAt: number; completedAt: number | null; durationMs: number | null; promptBytes: number; maxOutputBytes: number; outputBytes: number | null; inputTokens: number | null; outputTokens: number | null; cost: number | null; gooseSessionId: string | null; errorCode: string | null; errorDetail: string | null; outputPreview: unknown; compiledInput: TraceBody | null; turns: AgentModelTurn[]; finalPayload: TraceBody | null; transcriptTruncated: boolean; fields: Record<string, string | number | boolean | null> }
type AdminTab = "monitoring" | "group-mode" | "models" | "prompts";
type ApiError = { message?: string; error?: string };
type LoginMode = "choices" | "create" | "unlock";
type ProjectDeletionTarget = { team: Team; project: ProjectSummary };
type AdminDeletionTarget = { kind:"project"|"team"; id:string; name:string; teamName?:string; projectCount?:number };

export function AuthChoices({ deviceNpub, busy, checking, onCreatePlayer, onResumeDevice, onSignInWithNostr }: { deviceNpub: string | null; busy: boolean; checking: boolean; onCreatePlayer: () => void; onResumeDevice: () => void; onSignInWithNostr: () => void }) {
  if (deviceNpub) {
    return <div className="auth-choices"><button className="primary-button" type="button" onClick={onSignInWithNostr} disabled={busy || checking}><span className="button-cube" aria-hidden="true" /><span>{checking ? "Checking session…" : "Sign in with Nostr"}</span><span>↗</span></button><button className="secondary-auth" type="button" disabled={checking || busy} onClick={onResumeDevice}><span>Continue as this device player</span><small>{friendlyName(deviceNpub,"Saved player")}</small></button></div>;
  }
  return <div className="auth-choices"><button className="primary-button" type="button" disabled={busy || checking} onClick={onCreatePlayer}><span className="button-cube" aria-hidden="true" /><span>Create a player account</span><span>→</span></button><button className="secondary-auth" type="button" onClick={onSignInWithNostr} disabled={busy || checking}><span>{checking ? "Checking session…" : "Sign in with Nostr"}</span><small>Already use Nostr? Use your signer extension</small></button></div>;
}

const SIGN_TIMEOUT_MS = 15_000;
export const LEVELUP_ADMIN_NPUB = "npub1jss47s4fvv6usl7tn6yp5zamv2u60923ncgfea0e6thkza5p7c3q0afmzy";
const PROMPT_INPUT_PLACEHOLDER = "{{inputJson}}";
export const TEAM_UPDATE_MESSAGE = "Level Up is still updating. Your team is safe—refresh this page after the update finishes.";
const IDEA_ATTACHMENT_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_IDEA_ATTACHMENTS = 4;
const MAX_IDEA_ATTACHMENT_BYTES = 3_000_000;
const vault = new IdentityVault();
const profiles = new ProfileService();
let activeSigner: NostrSigner | null = null;

export function shouldSubmitIdeaFromKey(event: { key: string; shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; isComposing?: boolean }): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && !event.isComposing;
}

function normalizeAttachmentList(value: unknown): RoundContributionAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is RoundContributionAttachment => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const attachment = item as Partial<RoundContributionAttachment>;
    return attachment.kind === "image" && typeof attachment.id === "string" && typeof attachment.filename === "string" && typeof attachment.dataUrl === "string" && typeof attachment.sizeBytes === "number" && typeof attachment.contentType === "string" && IDEA_ATTACHMENT_TYPES.has(attachment.contentType);
  }).slice(0, MAX_IDEA_ATTACHMENTS);
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("That image could not be read."));
    reader.onerror = () => reject(new Error("That image could not be read."));
    reader.readAsDataURL(file);
  });
}

async function filesToIdeaAttachments(files: File[], existing: RoundContributionAttachment[]): Promise<RoundContributionAttachment[]> {
  const available = MAX_IDEA_ATTACHMENTS - existing.length;
  if (available <= 0) throw new Error("You can attach up to four screenshots.");
  const accepted = files.filter((file) => IDEA_ATTACHMENT_TYPES.has(file.type));
  if (!accepted.length) throw new Error("Attach PNG, JPEG, WebP, or GIF screenshots.");
  const attachments: RoundContributionAttachment[] = [];
  for (const file of accepted.slice(0, available)) {
    if (file.size > MAX_IDEA_ATTACHMENT_BYTES) throw new Error("Each screenshot must be 3 MB or smaller.");
    attachments.push({ id: crypto.randomUUID(), kind: "image", filename: file.name || "screenshot.png", contentType: file.type as RoundContributionAttachment["contentType"], dataUrl: await readFileAsDataUrl(file), sizeBytes: file.size });
  }
  return attachments;
}

function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), SIGN_TIMEOUT_MS);
    promise.then((value) => { window.clearTimeout(timer); resolve(value); }, (error) => { window.clearTimeout(timer); reject(error); });
  });
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", ...init, headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers } });
  const payload = await response.json().catch(() => ({})) as T & ApiError;
  if (response.status === 405 && path === "/api/teams" && (!init?.method || init.method === "GET")) {
    throw new Error(TEAM_UPDATE_MESSAGE);
  }
  if (response.status === 401) window.dispatchEvent(new CustomEvent("levelup:unauthenticated"));
  if (!response.ok) throw new Error(payload.message || "Level Up could not complete that request.");
  return payload;
}

export function shortNpub(npub: string): string { return `${npub.slice(0, 12)}…${npub.slice(-8)}`; }
function pubkeyFromNpub(npub: string): string {
  const decoded = nip19.decode(npub);
  if (decoded.type !== "npub") throw new Error("Invalid Nostr account.");
  return decoded.data;
}
function friendlyName(npub:string|undefined,fallback="Player"):string{if(!npub)return fallback;try{return generatedNickname(pubkeyFromNpub(npub));}catch{return fallback;}}
export function memberDisplayName(member: TeamMember, profile: PublicProfile | undefined, index: number): string {
  return profile?.displayName||friendlyName(member.npub,member.role === "organiser" ? "Team organiser" : `Player ${index + 1}`);
}
function normalizeProfiles(value: unknown): PublicProfile[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): PublicProfile[] => {
    if (!item || typeof item !== "object") return [];
    const candidate=item as Partial<PublicProfile>;
    if(typeof candidate.pubkey!=="string"||!candidate.event||typeof candidate.fetchedAt!=="number")return[];
    const event=selectLatestProfile([candidate.event],candidate.pubkey.toLowerCase());
    return event?[profileFromEvent(candidate.pubkey.toLowerCase(),event,candidate.fetchedAt)]:[];
  });
}
export function mergeTeamLists<T extends { id: string }>(refreshed: T[], remembered: T[]): T[] {
  const refreshedIds = new Set(refreshed.map((team) => team.id));
  return [...refreshed, ...remembered.filter((team) => !refreshedIds.has(team.id))];
}
export type SelectionContext = { kind: "root" | "admin" } | { kind: "team" | "project"; id: string };
export function selectionContextFromPath(pathname: string): SelectionContext {
  if (pathname === "/admin") return { kind: "admin" };
  const teamMatch = pathname.match(/^\/teams\/([^/]+)\/?$/);
  if (teamMatch) { try { return { kind: "team", id: decodeURIComponent(teamMatch[1]!) }; } catch { return { kind: "root" }; } }
  const projectId = projectIdFromPath(pathname);
  return projectId ? { kind: "project", id: projectId } : { kind: "root" };
}
export function selectionContextKey(context: SelectionContext): string { return context.kind === "team" || context.kind === "project" ? `${context.kind}:${context.id}` : context.kind; }
export function teamSelectionDestination(team: Team): SelectionContext {
  // The authoritative lobby only contains current projects; deletion is the
  // existing end of a project's lifecycle, so every listed project is active.
  return !team.isOrganiser && team.projects.length === 1
    ? { kind: "project", id: team.projects[0]!.id }
    : { kind: "team", id: team.id };
}
export function createSelectionRequestGate(initial: SelectionContext) {
  let current = selectionContextKey(initial); let sequence = 0;
  return {
    select(context: SelectionContext) { current = selectionContextKey(context); sequence += 1; return sequence; },
    refresh(context: SelectionContext) { const key = selectionContextKey(context); if (key !== current) return null; sequence += 1; return sequence; },
    accepts(context: SelectionContext, request: number | null) { return request !== null && current === selectionContextKey(context) && sequence === request; },
    current: () => current,
  };
}
function isTeamMember(value: unknown): value is TeamMember {
  if (!value || typeof value !== "object") return false;
  const member = value as Partial<TeamMember>;
  return typeof member.accountId === "string" && typeof member.npub === "string" && (member.role === "organiser" || member.role === "player");
}
function isProjectSummary(value: unknown): value is ProjectSummary {
  if (!value || typeof value !== "object") return false;
  const project = value as Partial<ProjectSummary>;
  return typeof project.id === "string" && typeof project.teamId === "string" && typeof project.name === "string"
    && (project.phase === "selecting_template" || project.phase === "resolving_template_tie" || project.phase === "round_1_brainstorm")
    && (project.selectedTemplateId === null || typeof project.selectedTemplateId === "string") && typeof project.createdAt === "number";
}
function normalizeProjectSummary(value: unknown): ProjectSummary | null {
  if (!isProjectSummary(value)) return null;
  return { ...value, stablePlayUrl: typeof value.stablePlayUrl === "string" ? value.stablePlayUrl : null };
}
export function normalizeTeam(value: unknown): Team {
  if (!value || typeof value !== "object") throw new Error("Level Up received an invalid team response.");
  const team = value as Partial<Team>;
  if (typeof team.id !== "string" || typeof team.sessionId !== "string" || typeof team.name !== "string") {
    throw new Error("Level Up received an invalid team response.");
  }
  return {
    ...team,
    id: team.id,
    sessionId: team.sessionId,
    name: team.name,
    phase: "lobby",
    isOrganiser: team.isOrganiser === true,
    members: Array.isArray(team.members) ? team.members.filter(isTeamMember) : [],
    projects: Array.isArray(team.projects) ? team.projects.map(normalizeProjectSummary).filter((project): project is ProjectSummary => Boolean(project)) : [],
    profiles: normalizeProfiles(team.profiles),
  };
}
export function normalizeTeamListPayload(value: unknown): Team[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { teams?: unknown }).teams)) throw new Error(TEAM_UPDATE_MESSAGE);
  return (value as { teams: unknown[] }).teams.map(normalizeTeam);
}
function normalizeAdminPrompt(value: unknown): AgentPromptRecord {
  if (!value || typeof value !== "object") throw new Error(TEAM_UPDATE_MESSAGE);
  const prompt = value as Partial<AgentPromptRecord>;
  if ((prompt.id !== "brainstorm_suggestion" && prompt.id !== "proposal_generation" && prompt.id !== "feature_build" && prompt.id !== "build_run" && prompt.id !== "game_edit" && prompt.id !== "feedback_summary")
    || typeof prompt.label !== "string" || typeof prompt.stage !== "string" || typeof prompt.description !== "string"
    || typeof prompt.template !== "string" || typeof prompt.defaultTemplate !== "string" || typeof prompt.isDefault !== "boolean"
    || (prompt.modelMode !== "default" && prompt.modelMode !== "specific") || (prompt.model !== null && typeof prompt.model !== "string") || typeof prompt.effectiveModel !== "string"
    || (prompt.updatedAt !== null && typeof prompt.updatedAt !== "number")) throw new Error(TEAM_UPDATE_MESSAGE);
  return prompt as AgentPromptRecord;
}
export function normalizeAdminPromptsPayload(value: unknown): AgentPromptRecord[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { prompts?: unknown }).prompts)) throw new Error(TEAM_UPDATE_MESSAGE);
  return (value as { prompts: unknown[] }).prompts.map(normalizeAdminPrompt);
}
function normalizeAdminSettings(value: unknown): AdminSettingsRecord {
  if (!value || typeof value !== "object") throw new Error(TEAM_UPDATE_MESSAGE);
  const settings = value as Partial<AdminSettingsRecord>;
  const seconds = settings.brainstormSuggestionIntervalSeconds;
  const intervalMs = settings.brainstormSuggestionIntervalMs;
  const turns = settings.agentMaxTurns;
  const voteAllowance = settings.proposalVoteAllowance;
  const models = settings.allowedModels;
  if (typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds < 5 || seconds > 600
    || typeof intervalMs !== "number" || !Number.isSafeInteger(intervalMs) || intervalMs !== seconds * 1000
    || typeof turns !== "number" || !Number.isSafeInteger(turns) || turns < 1 || turns > 5
    || typeof voteAllowance !== "number" || !Number.isSafeInteger(voteAllowance) || voteAllowance < 1 || voteAllowance > 20
    || !Array.isArray(models) || models.some((model) => typeof model !== "string") || typeof settings.defaultModel !== "string" || !models.includes(settings.defaultModel)
    || (settings.updatedAt !== null && typeof settings.updatedAt !== "number")) throw new Error(TEAM_UPDATE_MESSAGE);
  return settings as AdminSettingsRecord;
}
const ROUND_PHASES = new Set<RoundPhase>(["brainstorm", "proposals", "voting", "brief", "building", "playtest", "failed"]);
const BUILD_STAGES = new Set(["preparing", "analysing", "coding", "testing", "publishing", "complete", "failed"]);
const BUILD_STATUSES = new Set(["running", "succeeded", "failed", "interrupted"]);
const FEATURE_STATUSES = new Set(["queued", "reviewing", "building", "testing", "succeeded", "no_change", "failed", "interrupted", "deferred"]);
const FEATURE_LOOPS = new Set(["review", "build", "test"]);
function normalizeAdminProject(value: unknown): AdminProjectSummary | null {
  if (!isProjectSummary(value)) return null;
  const raw = value as unknown as Record<string, unknown>;
  if (typeof raw.teamName !== "string") return null;
  const project = value as Partial<AdminProjectSummary>;
  const teamName = raw.teamName;
  const round = project.round && typeof project.round === "object" && typeof project.round.id === "string" && typeof project.round.number === "number" && ROUND_PHASES.has(project.round.phase as RoundPhase)
    ? { id: project.round.id, number: project.round.number, phase: project.round.phase as RoundPhase, lastSequence: typeof project.round.lastSequence === "number" ? project.round.lastSequence : 0, buildStatus: typeof project.round.buildStatus === "string" ? project.round.buildStatus : null, buildStage: typeof project.round.buildStage === "string" ? project.round.buildStage : null }
    : null;
  const captain=raw.captain&&typeof raw.captain==="object"&&typeof (raw.captain as {accountId?:unknown}).accountId==="string"&&typeof (raw.captain as {npub?:unknown}).npub==="string"?raw.captain as AdminProjectSummary["captain"]:null;
  const failure=raw.failure&&typeof raw.failure==="object"&&typeof (raw.failure as {code?:unknown}).code==="string"&&typeof (raw.failure as {section?:unknown}).section==="string"?raw.failure as AdminProjectSummary["failure"]:null;
  return { ...normalizeProjectSummary(value)!, teamName, joinedCount:typeof raw.joinedCount==="number"?raw.joinedCount:0,connectedCount:typeof raw.connectedCount==="number"?raw.connectedCount:null,activeInvite:raw.activeInvite===true,selectionStartedAt:typeof raw.selectionStartedAt==="number"?raw.selectionStartedAt:0,selectionClosedAt:typeof raw.selectionClosedAt==="number"?raw.selectionClosedAt:null,captain,failure,round };
}
export function normalizeAdminProjectsPayload(value: unknown): AdminProjectSummary[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { projects?: unknown }).projects)) throw new Error(TEAM_UPDATE_MESSAGE);
  return (value as { projects: unknown[] }).projects.map(normalizeAdminProject).filter((project): project is AdminProjectSummary => Boolean(project));
}

export function normalizeAdminTeamsPayload(value: unknown): AdminTeamSummary[] {
  const source = value && typeof value === "object" && !Array.isArray(value) ? (value as { teams?: unknown }).teams : value;
  if (!Array.isArray(source)) return [];
  return source.filter((item): item is AdminTeamSummary => Boolean(item && typeof item === "object" && typeof (item as AdminTeamSummary).id === "string" && typeof (item as AdminTeamSummary).name === "string" && Number.isSafeInteger((item as AdminTeamSummary).memberCount) && Number.isSafeInteger((item as AdminTeamSummary).projectCount) && typeof (item as AdminTeamSummary).createdAt === "number"));
}
function normalizeTraceBody(value: unknown): TraceBody | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Partial<TraceBody>;
  return typeof body.bytes === "number" && Number.isFinite(body.bytes) && typeof body.truncated === "boolean" ? { value: body.value ?? null, bytes: body.bytes, truncated: body.truncated } : null;
}
export function normalizeAgentRunTrace(value: unknown): AgentRunTrace | null {
  if (!value || typeof value !== "object") return null;
  const run = value as Partial<AgentRunTrace>;
  if (typeof run.id !== "string" || typeof run.stage !== "string" || typeof run.clientName !== "string" || (run.status !== "running" && run.status !== "succeeded" && run.status !== "failed")
    || typeof run.startedAt !== "number" || typeof run.maxTurns !== "number" || typeof run.promptBytes !== "number" || typeof run.maxOutputBytes !== "number") return null;
  const compiledInput = normalizeTraceBody(run.compiledInput);
  const finalPayload = normalizeTraceBody(run.finalPayload);
  const turns = Array.isArray(run.turns) ? run.turns.map((value, index): AgentModelTurn | null => {
    const body = normalizeTraceBody(value); if (!body || !value || typeof value !== "object") return null;
    const turn = value as Partial<AgentModelTurn>;
    return { ...body, number: typeof turn.number === "number" && Number.isSafeInteger(turn.number) ? turn.number : index + 1, observedAt: typeof turn.observedAt === "number" ? turn.observedAt : run.startedAt!, source: turn.source === "provider" ? "provider" : "acp" };
  }).filter((turn): turn is AgentModelTurn => Boolean(turn)) : [];
  return {
    id: run.id,
    stage: run.stage,
    clientName: run.clientName,
    model: typeof run.model === "string" ? run.model : null,
    maxTurns: run.maxTurns,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: typeof run.completedAt === "number" ? run.completedAt : null,
    durationMs: typeof run.durationMs === "number" ? run.durationMs : null,
    promptBytes: run.promptBytes,
    maxOutputBytes: run.maxOutputBytes,
    outputBytes: typeof run.outputBytes === "number" ? run.outputBytes : null,
    inputTokens: typeof run.inputTokens === "number" ? run.inputTokens : null,
    outputTokens: typeof run.outputTokens === "number" ? run.outputTokens : null,
    cost: typeof run.cost === "number" ? run.cost : null,
    gooseSessionId: typeof run.gooseSessionId === "string" ? run.gooseSessionId : null,
    errorCode: typeof run.errorCode === "string" ? run.errorCode : null,
    errorDetail: typeof run.errorDetail === "string" ? run.errorDetail : null,
    outputPreview: run.outputPreview ?? null,
    compiledInput,
    turns,
    finalPayload,
    transcriptTruncated: run.transcriptTruncated === true || Boolean(compiledInput?.truncated || finalPayload?.truncated || turns.some((turn) => turn.truncated)),
    fields: run.fields && typeof run.fields === "object" && !Array.isArray(run.fields) ? run.fields as AgentRunTrace["fields"] : {},
  };
}
function normalizeAgentRunsPayload(value: unknown): AgentRunTrace[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { runs?: unknown }).runs)) throw new Error(TEAM_UPDATE_MESSAGE);
  return (value as { runs: unknown[] }).runs.map(normalizeAgentRunTrace).filter((run): run is AgentRunTrace => Boolean(run));
}
export function normalizeRoundSnapshot(value: unknown): RoundSnapshot {
  if (!value || typeof value !== "object") throw new Error(TEAM_UPDATE_MESSAGE);
  const round = value as Partial<RoundSnapshot>;
  if (typeof round.id !== "string" || typeof round.projectId !== "string" || typeof round.number !== "number" || !ROUND_PHASES.has(round.phase as RoundPhase)) throw new Error(TEAM_UPDATE_MESSAGE);
  let summaryRun: DomainRoundSnapshot["summaryRun"], summaryMessages: DomainRoundSnapshot["summaryMessages"];
  try { summaryRun=normalizeSummaryRun(round.summaryRun);summaryMessages=normalizeSummaryMessages(round.summaryMessages,new Set(normalizeFeedbackHistory(round.feedbackHistory).flatMap(r=>r.feedback.map(f=>f.id)))); }
  catch { throw new Error(TEAM_UPDATE_MESSAGE); }
  const rawActive=round.activeBuild;
  const activeBuild=rawActive&&typeof rawActive==="object"&&Number.isSafeInteger(rawActive.roundNumber)&&rawActive.brief&&typeof rawActive.brief==="object"?{roundNumber:Number(rawActive.roundNumber),brief:rawActive.brief,build:normalizeBuildRun(rawActive.build,rawActive.brief)}:null;
  return {
    ...round,
    id: round.id,
    projectId: round.projectId,
    number: round.number,
    phase: round.phase as RoundPhase,
    startedAt: typeof round.startedAt === "number" ? round.startedAt : 0,
    deadlineAt: typeof round.deadlineAt === "number" ? round.deadlineAt : 0,
    votingDeadlineAt: typeof round.votingDeadlineAt === "number" ? round.votingDeadlineAt : null,
    closedAt: typeof round.closedAt === "number" ? round.closedAt : null,
    serverTime: typeof round.serverTime === "number" ? round.serverTime : Date.now(),
    lastSequence: typeof round.lastSequence === "number" ? round.lastSequence : 0,
    proposalVoteAllowance: typeof round.proposalVoteAllowance === "number" && Number.isSafeInteger(round.proposalVoteAllowance) && round.proposalVoteAllowance >= 1 && round.proposalVoteAllowance <= 20 ? round.proposalVoteAllowance : 5,
    contributions: normalizeContributionList(round.contributions),
    proposals: normalizeProposalList(round.proposals),
    selections: Array.isArray(round.selections) ? round.selections.filter((id): id is string => typeof id === "string") : [],
    rankings: Array.isArray(round.rankings) ? round.rankings : null,
    brief: round.brief && typeof round.brief === "object" ? round.brief : null,
    build: normalizeBuildRun(round.build, round.brief),
    summaryRun, summaryMessages,
    feedback: normalizeFeedbackList(round.feedback),
    feedbackHistory: normalizeFeedbackHistory(round.feedbackHistory),
    versionHistory: normalizeVersionHistory(round.versionHistory),
    priorFeedback: normalizeFeedbackContext(round.priorFeedback),
    activeBuild: activeBuild?.build ? activeBuild as RoundSnapshot["activeBuild"] : null,
    proposalGeneration: round.proposalGeneration && typeof round.proposalGeneration==="object" && ["idle","running","failed","complete"].includes(round.proposalGeneration.status) ? {status:round.proposalGeneration.status,error:typeof round.proposalGeneration.error==="string"?round.proposalGeneration.error:null,attempts:Number.isSafeInteger(round.proposalGeneration.attempts)?round.proposalGeneration.attempts:0} : {status:round.phase==="proposals"?"complete":"idle",error:null,attempts:0},
    brainstormSeed: round.brainstormSeed && typeof round.brainstormSeed==="object" && ["idle","running","failed","complete"].includes(round.brainstormSeed.status) ? {status:round.brainstormSeed.status,error:typeof round.brainstormSeed.error==="string"?round.brainstormSeed.error:null,attempts:Number.isSafeInteger(round.brainstormSeed.attempts)?round.brainstormSeed.attempts:0} : {status:Array.isArray(round.contributions)&&round.contributions.some((item)=>item.authorKind==="bot")?"complete":"idle",error:null,attempts:0},
    proposalReconciliation: round.proposalReconciliation?.schemaVersion===2 ? round.proposalReconciliation : null,
  };
}
function normalizeVersionHistory(value:unknown):ProjectVersionHistoryEntry[]{
  if(!Array.isArray(value))return[];
  return value.map((item):ProjectVersionHistoryEntry|null=>{
    if(!item||typeof item!=="object")return null;const entry=item as Partial<ProjectVersionHistoryEntry>;
    if(!Number.isSafeInteger(entry.roundNumber)||Number(entry.roundNumber)<1||typeof entry.proposalId!=="string"||typeof entry.title!=="string"||typeof entry.playerChange!=="string"||typeof entry.releaseUrl!=="string"||(entry.status!=="succeeded"&&entry.status!=="no_change"))return null;
    return{roundNumber:Number(entry.roundNumber),proposalId:entry.proposalId,title:entry.title,playerChange:entry.playerChange,status:entry.status,releaseUrl:entry.releaseUrl,completedAt:typeof entry.completedAt==="number"?entry.completedAt:null};
  }).filter((entry):entry is ProjectVersionHistoryEntry=>Boolean(entry));
}
function normalizeProposalList(value: unknown): Proposal[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new Error(TEAM_UPDATE_MESSAGE);
    const proposal = item as Partial<Proposal>;
    if (typeof proposal.id !== "string" || typeof proposal.roundId !== "string" || !Number.isSafeInteger(proposal.position) || typeof proposal.title !== "string" || typeof proposal.playerChange !== "string" || typeof proposal.implementationScope !== "string") throw new Error(TEAM_UPDATE_MESSAGE);
    return { ...proposal, id: proposal.id, roundId: proposal.roundId, position: Number(proposal.position), title: proposal.title, playerChange: proposal.playerChange, implementationScope: proposal.implementationScope, acceptanceCriteria: Array.isArray(proposal.acceptanceCriteria) ? proposal.acceptanceCriteria.filter((item): item is string => typeof item === "string") : [], ideaReferences: Array.isArray(proposal.ideaReferences) ? proposal.ideaReferences.filter((item): item is number => Number.isSafeInteger(item)) : [], backlogReferences: Array.isArray(proposal.backlogReferences) ? proposal.backlogReferences.filter((item): item is string => typeof item === "string") : [] };
  });
}
function normalizeBuildReport(value: unknown): BuildReport | null {
  if (!value || typeof value !== "object") return null;
  const report = value as Partial<BuildReport>;
  if (typeof report.id !== "string" || typeof report.accountId !== "string" || typeof report.reportedAt !== "number") return null;
  return { id: report.id, accountId: report.accountId, proposalId: typeof report.proposalId === "string" ? report.proposalId : null, note: typeof report.note === "string" ? report.note : "", reportedAt: report.reportedAt, loop: report.loop && FEATURE_LOOPS.has(report.loop) ? report.loop : null };
}
function normalizeFeatureStep(value: unknown): FeatureBuildStep | null {
  if (!value || typeof value !== "object") return null;
  const step = value as Partial<FeatureBuildStep>;
  if (!step.loop || !FEATURE_LOOPS.has(step.loop) || (step.status !== "active" && step.status !== "complete" && step.status !== "failed")) return null;
  return { loop: step.loop, status: step.status, at: typeof step.at === "number" ? step.at : null, detail: typeof step.detail === "string" ? step.detail : "" };
}
function normalizeFeatureDelivery(value: unknown): FeatureBuild["delivery"] {
  if (!value || typeof value !== "object") return undefined;
  const delivery = value as Record<string, unknown>;
  if (delivery.implementation !== "checked" || (delivery.review !== "approved" && delivery.review !== "changes_required" && delivery.review !== "failed") || (delivery.correction !== "not_required" && delivery.correction !== "checked" && delivery.correction !== "failed") || (delivery.selectedCandidate !== "primary" && delivery.selectedCandidate !== "corrected")) return undefined;
  return {
    implementation: "checked",
    review: delivery.review,
    correction: delivery.correction,
    selectedCandidate: delivery.selectedCandidate,
    reviewFindings: Array.isArray(delivery.reviewFindings) ? delivery.reviewFindings.filter((item): item is string => typeof item === "string") : [],
    reviewFailure: typeof delivery.reviewFailure === "string" ? delivery.reviewFailure : null,
    correctionFailure: typeof delivery.correctionFailure === "string" ? delivery.correctionFailure : null,
  };
}
function normalizeFeatureBuild(value: unknown): FeatureBuild | null {
  if (!value || typeof value !== "object") return null;
  const feature = value as Partial<FeatureBuild>;
  if (typeof feature.proposalId !== "string" || !Number.isSafeInteger(feature.queuePosition)) return null;
  return {
    proposalId: feature.proposalId,
    queuePosition: Number(feature.queuePosition),
    status: feature.status && FEATURE_STATUSES.has(feature.status) ? feature.status : "queued",
    currentAgentLoop: feature.currentAgentLoop && FEATURE_LOOPS.has(feature.currentAgentLoop) ? feature.currentAgentLoop : null,
    steps: Array.isArray(feature.steps) ? feature.steps.map(normalizeFeatureStep).filter((step): step is FeatureBuildStep => Boolean(step)) : [],
    releaseUrl: typeof feature.releaseUrl === "string" ? feature.releaseUrl : null,
    failure: typeof feature.failure === "string" ? feature.failure : null,
    reportCount: typeof feature.reportCount === "number" ? feature.reportCount : 0,
    latestReport: normalizeBuildReport(feature.latestReport),
    startedAt: typeof feature.startedAt === "number" ? feature.startedAt : null,
    completedAt: typeof feature.completedAt === "number" ? feature.completedAt : null,
    activity: Array.isArray(feature.activity) ? feature.activity.flatMap((item): BuildActivityUpdate[] => {
      if (!item || typeof item !== "object") return [];
      const update = item as { phase?: unknown; message?: unknown; at?: unknown };
      return (update.phase === "inspecting" || update.phase === "editing" || update.phase === "testing" || update.phase === "repairing") && typeof update.message === "string" && typeof update.at === "number" ? [{ phase: update.phase, message: update.message, at: update.at }] : [];
    }).slice(-6) : [],
    delivery: normalizeFeatureDelivery(feature.delivery),
  };
}
function normalizeBuildRun(value: unknown, brief: unknown): BuildRun | null {
  if (!value || typeof value !== "object") return null;
  const build = value as Partial<BuildRun>;
  if (typeof build.id !== "string" || !build.status || !BUILD_STATUSES.has(build.status) || !build.currentStage || !BUILD_STAGES.has(build.currentStage)) return null;
  const selected = brief && typeof brief === "object" && Array.isArray((brief as FrozenBrief).selected) ? (brief as FrozenBrief).selected : [];
  const features = Array.isArray(build.featureBuilds) ? build.featureBuilds.map(normalizeFeatureBuild).filter((feature): feature is FeatureBuild => Boolean(feature)) : [];
  const fallbackFeatures = features.length ? features : selected.map((proposal, index): FeatureBuild => ({ proposalId: proposal.id, queuePosition: index + 1, status: "queued", currentAgentLoop: null, steps: [], releaseUrl: null, failure: null, reportCount: 0, latestReport: null, startedAt: null, completedAt: null }));
  return {
    ...build,
    id: build.id,
    status: build.status,
    currentStage: build.currentStage,
    simulated: build.simulated === true,
    steps: Array.isArray(build.steps) ? build.steps.filter((step): step is BuildRun["steps"][number] => Boolean(step) && typeof step === "object") : [],
    includedProposalIds: Array.isArray(build.includedProposalIds) ? build.includedProposalIds.filter((id): id is string => typeof id === "string") : [],
    deferredProposalIds: Array.isArray(build.deferredProposalIds) ? build.deferredProposalIds.filter((id): id is string => typeof id === "string") : [],
    startedAt: typeof build.startedAt === "number" ? build.startedAt : 0,
    completedAt: typeof build.completedAt === "number" ? build.completedAt : null,
    validated: build.validated === true,
    releaseUrl: typeof build.releaseUrl === "string" ? build.releaseUrl : null,
    failure: typeof build.failure === "string" ? build.failure : null,
    featureBuilds: fallbackFeatures,
    activeFeatureProposalId: typeof build.activeFeatureProposalId === "string" ? build.activeFeatureProposalId : null,
    reportCount: typeof build.reportCount === "number" ? build.reportCount : 0,
    latestReport: normalizeBuildReport(build.latestReport),
    previousStableUrl: typeof build.previousStableUrl === "string" ? build.previousStableUrl : null,
  };
}
function normalizeContributionList(value:unknown):RoundContribution[]{
  if(!Array.isArray(value))return[];
  return value.map((item)=>{if(!item||typeof item!=="object")throw new Error(TEAM_UPDATE_MESSAGE);const contribution=item as Partial<RoundContribution>;if(typeof contribution.id!=="string"||typeof contribution.roundId!=="string"||typeof contribution.authorAccountId!=="string"||typeof contribution.authorNpub!=="string"||typeof contribution.body!=="string"||typeof contribution.clientEventId!=="string"||!Number.isSafeInteger(contribution.sequence))throw new Error(TEAM_UPDATE_MESSAGE);const authorKind=contribution.authorKind==="bot"?"bot":"member";return{...contribution,id:contribution.id,roundId:contribution.roundId,authorAccountId:contribution.authorAccountId,authorNpub:contribution.authorNpub,body:contribution.body,clientEventId:contribution.clientEventId,sequence:Number(contribution.sequence),createdAt:typeof contribution.createdAt==="number"?contribution.createdAt:0,authorKind,authorLabel:typeof contribution.authorLabel==="string"?contribution.authorLabel:undefined,attachments:normalizeAttachmentList(contribution.attachments)};});
}
function normalizeFeedbackContext(value:unknown):RoundSnapshot["priorFeedback"]{
  if(value===null||value===undefined)return null;if(!value||typeof value!=="object")throw new Error(TEAM_UPDATE_MESSAGE);const context=value as {roundNumber?:unknown;worked?:unknown;improve?:unknown;nextIdeas?:unknown;requirementBacklog?:unknown};if(!Number.isSafeInteger(context.roundNumber)||Number(context.roundNumber)<1)throw new Error(TEAM_UPDATE_MESSAGE);const strings=(items:unknown)=>Array.isArray(items)?items.filter((item):item is string=>typeof item==="string"):[];return{roundNumber:Number(context.roundNumber),worked:strings(context.worked),improve:strings(context.improve),nextIdeas:strings(context.nextIdeas),requirementBacklog:normalizeRequirementBacklog(context.requirementBacklog)};
}
function normalizeRequirementBacklog(value:unknown):RequirementBacklogItem[]{
  if(!Array.isArray(value))return[];
  return value.map((item):RequirementBacklogItem|null=>{
    if(!item||typeof item!=="object"||Array.isArray(item))return null;
    const card=item as Partial<RequirementBacklogItem>;
    const status=card.status&&FEATURE_STATUSES.has(card.status)&&["queued","deferred","failed","interrupted"].includes(card.status)?card.status as RequirementBacklogItem["status"]:"deferred";
    const acceptanceCriteria=Array.isArray(card.acceptanceCriteria)?card.acceptanceCriteria.filter((criterion):criterion is string=>typeof criterion==="string"&&Boolean(criterion.trim())).slice(0,5):[];
    if(typeof card.proposalId!=="string"||typeof card.title!=="string"||typeof card.playerChange!=="string"||typeof card.implementationScope!=="string"||!acceptanceCriteria.length)return null;
    return{proposalId:card.proposalId,sourceRoundNumber:typeof card.sourceRoundNumber==="number"?card.sourceRoundNumber:0,sourceRank:typeof card.sourceRank==="number"?card.sourceRank:0,title:card.title,playerChange:card.playerChange,implementationScope:card.implementationScope,acceptanceCriteria,status};
  }).filter((item):item is RequirementBacklogItem=>Boolean(item));
}
function normalizeFeedbackList(value: unknown): MemberFeedback[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new Error(TEAM_UPDATE_MESSAGE);
    const feedback = item as Partial<MemberFeedback>;
    if (typeof feedback.id !== "string" || typeof feedback.authorAccountId !== "string" || typeof feedback.authorNpub !== "string" || typeof feedback.clientEventId !== "string") throw new Error(TEAM_UPDATE_MESSAGE);
    return {
      id: feedback.id,
      authorAccountId: feedback.authorAccountId,
      authorNpub: feedback.authorNpub,
      worked: typeof feedback.worked === "string" ? feedback.worked : "",
      improve: typeof feedback.improve === "string" ? feedback.improve : "",
      nextIdea: typeof feedback.nextIdea === "string" ? feedback.nextIdea : "",
      clientEventId: feedback.clientEventId,
      submittedAt: typeof feedback.submittedAt === "number" ? feedback.submittedAt : 0,
    };
  });
}
function normalizeFeedbackHistory(value: unknown): RoundSnapshot["feedbackHistory"] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new Error(TEAM_UPDATE_MESSAGE);
    const history = item as { roundNumber?: unknown; feedback?: unknown };
    if (!Number.isSafeInteger(history.roundNumber) || Number(history.roundNumber) < 1) throw new Error(TEAM_UPDATE_MESSAGE);
    return { roundNumber: Number(history.roundNumber), feedback: normalizeFeedbackList(history.feedback) };
  });
}
export function normalizeRoundOutboxRecord(value: unknown): RoundOutboxRecord | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<RoundOutboxRecord>;
  if (typeof item.clientEventId !== "string" || typeof item.projectId !== "string" || typeof item.body !== "string" || typeof item.createdAt !== "number") return null;
  const scoped = typeof item.roundId === "string" && Number.isSafeInteger(item.roundNumber) && Number(item.roundNumber) > 0;
  return {
    clientEventId: item.clientEventId,
    projectId: item.projectId,
    roundId: scoped ? item.roundId! : "",
    roundNumber: scoped ? Number(item.roundNumber) : 0,
    body: item.body,
    attachments: normalizeAttachmentList(item.attachments),
    status: item.status === "sent" || item.status === "failed" ? item.status : "pending",
    createdAt: item.createdAt,
    error: scoped ? item.error : "This saved idea predates round-safe delivery. Copy it into the current round or dismiss it.",
  };
}
type RoundSocketMessage =
  | { type: "round.sync" | "round.event"; round: RoundSnapshot }
  | { type: "contribution.ack"; clientEventId: string; status: "sent" | "failed"; message?: string };
export function normalizeRoundSocketMessage(value: unknown): RoundSocketMessage | null {
  if (!value || typeof value !== "object") return null;
  const message = value as { type?: unknown; round?: unknown; clientEventId?: unknown; status?: unknown; message?: unknown };
  if (message.type === "round.sync" || message.type === "round.event") return { type: message.type, round: normalizeRoundSnapshot(message.round) };
  if (message.type === "contribution.ack" && typeof message.clientEventId === "string" && (message.status === "sent" || message.status === "failed")) return { type: message.type, clientEventId: message.clientEventId, status: message.status, ...(typeof message.message === "string" ? { message: message.message } : {}) };
  if (message.type === "round.error") throw new Error(typeof message.message === "string" ? message.message : "The live room rejected an update.");
  return null;
}
export function normalizeProjectRoom(value: unknown): ProjectRoom {
  if (!value || typeof value !== "object" || !isProjectSummary(value)) throw new Error(TEAM_UPDATE_MESSAGE);
  const project = value as Partial<ProjectRoom> & ProjectSummary;
  return {
    ...project,
    teamName: typeof project.teamName === "string" ? project.teamName : "Team",
    isOrganiser: project.isOrganiser === true,
    selectionStartedAt: typeof project.selectionStartedAt === "number" ? project.selectionStartedAt : 0,
    selectionDeadlineAt: typeof project.selectionDeadlineAt === "number" ? project.selectionDeadlineAt : 0,
    selectionClosedAt: typeof project.selectionClosedAt === "number" ? project.selectionClosedAt : null,
    serverTime: typeof project.serverTime === "number" ? project.serverTime : Date.now(),
    templates: Array.isArray(project.templates) ? project.templates : [],
    selections: Array.isArray(project.selections) ? project.selections.filter((id): id is string => typeof id === "string") : [],
    rankings: Array.isArray(project.rankings) ? project.rankings : [],
    topThree: Array.isArray(project.topThree) ? project.topThree : [],
    tiedLeaderIds: Array.isArray(project.tiedLeaderIds) ? project.tiedLeaderIds.filter((id): id is string => typeof id === "string") : [],
    selectedTemplate: project.selectedTemplate && typeof project.selectedTemplate === "object" ? project.selectedTemplate : null,
    stablePlayUrl: typeof project.stablePlayUrl === "string" ? project.stablePlayUrl : null,
    round: project.round ? normalizeRoundSnapshot(project.round) : null,
    captain: project.captain && typeof project.captain.accountId==="string" && typeof project.captain.npub==="string" && Number.isSafeInteger(project.captain.roundNumber) ? project.captain : null,
    profiles: normalizeProfiles(project.profiles),
  };
}
export function projectIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/projects\/([^/]+)\/?$/);
  if (!match) return null;
  try { return decodeURIComponent(match[1]!); } catch { return null; }
}
export function signedOutPath(pendingInvite: string | null): string { return pendingInvite ? `/#join=${encodeURIComponent(pendingInvite)}` : "/"; }
export function groupCommandEligible(project: AdminProjectSummary, command: GroupCommand): boolean {
  if (command === "open_play") return project.selectionStartedAt === 0;
  if (command === "start_voting") return project.selectionStartedAt === 0;
  if (command === "extend_voting" || command === "close_voting") return project.phase === "selecting_template" && project.selectionStartedAt > 0 && project.selectionClosedAt === null;
  if (command === "start_first_brainstorm") return Boolean(project.selectedTemplateId);
  return true;
}
export function createGroupModeRequestGate() {
  let sequence=0,editRevision=0;
  return {
    begin():GroupModeRequest { return {sequence:++sequence,editRevision}; },
    edited():void { editRevision+=1; },
    accepts(request:GroupModeRequest):boolean { return request.sequence===sequence; },
    acceptsDraftHydration(request:GroupModeRequest):boolean { return request.sequence===sequence&&request.editRevision===editRevision; },
  };
}
export function groupModeDraftIsDirty(run:GroupRun|null,name:string,selectedProjectIds:string[]):boolean {
  if(!run)return Boolean(name.trim()||selectedProjectIds.length);
  return name!==run.name||selectedProjectIds.length!==run.selectedProjectIds.length||selectedProjectIds.some((id,index)=>id!==run.selectedProjectIds[index]);
}
export function remainingWholeSeconds(deadlineAt: number, serverTimeAtSync: number, elapsedClientMs: number): number {
  return Math.max(0, Math.ceil((deadlineAt - serverTimeAtSync - elapsedClientMs) / 1000));
}
export function formatCountdown(seconds: number): string {
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
export function countdownState(seconds: number): "normal" | "urgent" | "zero" {
  return seconds === 0 ? "zero" : seconds <= 21 ? "urgent" : "normal";
}

function projectPhaseLabel(phase: ProjectPhase): string {
  return phase === "selecting_template" ? "Choosing template" : phase === "resolving_template_tie" ? "Tie-break needed" : "Round 1 brainstorm";
}

function LevelMark() {
  return <svg className="level-mark" viewBox="0 0 72 72" role="img" aria-label="Level Up block landscape"><path className="mark-sky" d="M4 4h64v64H4z" /><path className="mark-sun" d="M48 12h12v12H48z" /><path className="mark-hill-back" d="M4 36h16V28h16v8h12v32H4z" /><path className="mark-hill" d="M20 48h16V40h16v-8h16v36H20z" /><path className="mark-path" d="M36 48h16v8H44v12H28v-8h8z" /></svg>;
}

function Avatar({ profile, variant = 0, className = "member-avatar" }: { profile?: PublicProfile; variant?: number; className?: string }) {
  if (profile?.picture) return <img className={`${className} profile-picture`} src={profile.picture} alt="" referrerPolicy="no-referrer" />;
  if (profile?.pubkey) return <img className={`${className} profile-picture`} src={avatarDataUri(profile.pubkey)} alt="" />;
  return <div className={`${className} avatar-${variant % 4}`} aria-hidden="true"><i /><b /></div>;
}

export function AppFooter() {
  return <footer className="app-footer">Vibed with Love by <a href="https://otherstuff.ai" target="_blank" rel="noreferrer">Otherstuff.ai</a></footer>;
}

function profileForNpub(npub: string | undefined, profileMap: Record<string, PublicProfile>): PublicProfile | undefined {
  if (!npub) return undefined;
  try { return profileMap[pubkeyFromNpub(npub)]; } catch { return undefined; }
}

function avatarVariant(identity: string): number {
  let hash = 0;
  for (const character of identity) hash = ((hash * 31) + character.charCodeAt(0)) >>> 0;
  return hash % 4;
}

type ConversationBubbleProps = {
  authorNpub?: string;
  authorLabel?: string;
  profileMap?: Record<string, PublicProfile>;
  variant: "idea" | "feedback" | "summary";
  author?: SummaryAuthor;
  children?: ReactNode;
  status: "sent" | "pending" | "failed";
  metadata: string;
  message?: string;
  attachments?: RoundContributionAttachment[];
  feedback?: Pick<MemberFeedback, "worked" | "improve" | "nextIdea">;
  error?: string;
  actions?: ReactNode;
};

export function ConversationBubble({ authorNpub, authorLabel = "You", profileMap = {}, variant, status, metadata, message, attachments = [], feedback, error, actions, author, children }: ConversationBubbleProps) {
  const profile = profileForNpub(authorNpub, profileMap);
  const displayName = author?.displayName || profile?.displayName || friendlyName(authorNpub,authorLabel);
  const identity = profile?.pubkey || authorNpub || authorLabel;
  return <article className={`conversation-bubble conversation-bubble-${variant} delivery-${status}${status === "sent" ? "" : ` local-${status}`}${actions ? " has-actions" : ""}`}>
    {author ? <BotAvatar system={author.kind === "system"}/> : <Avatar profile={profile} variant={avatarVariant(identity)} className="mini-avatar" />}
    <div className="conversation-main">
      <header className="conversation-heading"><strong>{displayName}</strong><span className="conversation-meta"><span>{metadata}</span><small>{author ? author.kind.toUpperCase() : status}</small></span></header>
      <div className="conversation-content">
        {message && <p>{message}</p>}
        {attachments.length > 0 && <div className="conversation-attachments">{attachments.map((attachment) => <a key={attachment.id} href={attachment.dataUrl} target="_blank" rel="noreferrer" aria-label={`Open ${attachment.filename}`}><img src={attachment.dataUrl} alt={attachment.filename} loading="lazy" /></a>)}</div>}
        {children}
        {feedback?.worked && <p className="feedback-line"><b>Worked</b><span>{feedback.worked}</span></p>}
        {feedback?.improve && <p className="feedback-line"><b>Improve</b><span>{feedback.improve}</span></p>}
        {feedback?.nextIdea && <p className="feedback-line"><b>Next</b><span>{feedback.nextIdea}</span></p>}
        {error && <p className="delivery-error">{error}</p>}
      </div>
    </div>
    {actions && <div className="conversation-actions">{actions}</div>}
  </article>;
}

export function BotAvatar({system=false}:{system?:boolean}) {
  const [broken,setBroken]=useState(false);
  return <span className="mini-avatar bot-avatar" aria-hidden="true">{!system&&!broken?<img src="/avatars/lvl-up-voxel.webp?v=1" srcSet="/avatars/lvl-up-voxel-32.webp?v=1 32w, /avatars/lvl-up-voxel-64.webp?v=1 64w, /avatars/lvl-up-voxel.webp?v=1 128w" sizes="32px" alt="" onError={()=>setBroken(true)}/>:<svg viewBox="0 0 32 32" focusable="false"><path fill="currentColor" d="M7 6h18v3h4v17H3V9h4z"/><path fill="#d7f64a" d="M8 12h5v5H8zm11 0h5v5h-5z"/><path fill="#fffdf3" d="M10 21h12v3H10z"/></svg>}</span>;
}
export function SummaryEntry({message}:{message:SummaryMessage}) {
  const content=message.content;
  const refs=(ids:string[])=><span className="summary-sources">{ids.map((id,index)=><a key={id} href={`#feedback-${id}`}>Note {index+1}</a>)}</span>;
  return <ConversationBubble variant="summary" status="sent" author={message.author} metadata={`After Round ${message.sourceRoundNumber}`}>
    {content?<details><summary>{content.overview}</summary>{[["What worked",content.worked],["Needs attention",content.needsAttention],["Questions for the team",content.questions]].map(([title,items])=><section key={String(title)}><h3>{String(title)}</h3><ul>{(items as typeof content.worked).map((p,i)=><li key={i}>{p.text}{refs(p.feedbackIds)}</li>)}</ul></section>)}<section><h3>Suggested updates</h3><ul>{content.suggestedUpdates.map((p,i)=><li key={i}><strong>{p.title}</strong> — {p.reason} <small>{p.origin==="agent_suggestion"?"Agent suggestion":"Player request"}</small>{refs(p.feedbackIds)}</li>)}</ul></section></details>:<p>Discussion started with original feedback. No AI summary was produced.</p>}
    <a className="summary-round-link" href={`#feedback-round-${message.sourceRoundNumber}`}>Original feedback · Round {message.sourceRoundNumber}</a>
  </ConversationBubble>;
}

export function AppHeader({ user, profile, busy, atHome, onHome, onEdit, onManageGames, onAdmin, onLogout }: { user: User; profile: PublicProfile; busy: boolean; atHome: boolean; onHome: () => void; onEdit: () => void; onManageGames: () => void; onAdmin?: () => void; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  return <header className="future-header"><div className="header-home"><button className="mini-brand" type="button" aria-label="Level Up team home" onClick={onHome}><LevelMark /><span>LEVEL UP</span></button>{!atHome && <button className="back-to-teams" type="button" onClick={onHome}>← All teams</button>}</div><div className="profile-menu-wrap" ref={menu}><button className="avatar-button" type="button" aria-label="Open profile menu" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}><Avatar profile={profile} className="header-avatar" /></button>{open && <div className="profile-menu" role="menu"><strong>{profile.displayName}</strong><small>Level Up player</small><button role="menuitem" type="button" onClick={() => { setOpen(false); onManageGames(); }}>Manage My Games</button>{onAdmin && <button role="menuitem" type="button" onClick={() => { setOpen(false); onAdmin(); }}>Admin mode</button>}<button role="menuitem" type="button" onClick={() => { setOpen(false); onEdit(); }}>Edit profile</button><button role="menuitem" type="button" disabled={busy} onClick={() => { setOpen(false); onLogout(); }}>Log out</button></div>}</div></header>;
}

export function TeamChooserView({ userNpub, teams, teamName, joinInput, busy, onTeamName, onJoinInput, onCreate, onJoin, onOpenTeam }: { userNpub: string; teams: Team[]; teamName: string; joinInput: string; busy: boolean; onTeamName: (value: string) => void; onJoinInput: (value: string) => void; onCreate: (event: React.FormEvent) => void; onJoin: (event: React.FormEvent) => void; onOpenTeam: (team: Team) => void }) {
  const canCreateTeam = userNpub === LEVELUP_ADMIN_NPUB;
  return <><div className="choice-intro"><p className="eyebrow">PLAYER VERIFIED</p><h1>Find your<br /><em>crew.</em></h1><p>Open one of your teams or use an invite from your organiser.</p></div>{teams.length > 0 && <section className="my-teams" aria-labelledby="my-teams-title"><div className="section-heading"><h2 id="my-teams-title">Your teams</h2><span>{teams.length} total</span></div><div className="team-list">{teams.map((existingTeam) => <article key={existingTeam.id}><a href={`/teams/${encodeURIComponent(existingTeam.id)}`} aria-busy={busy || undefined} onClick={(event) => { event.preventDefault(); onOpenTeam(existingTeam); }}><span><strong>{existingTeam.name}</strong><small>{existingTeam.isOrganiser ? "Organiser" : "Player"} · {existingTeam.members.length} {existingTeam.members.length === 1 ? "member" : "members"}</small></span><b aria-hidden="true">→</b></a></article>)}</div></section>}<div className="choice-grid">{canCreateTeam ? <form className="choice-card create-choice" onSubmit={onCreate}><span className="choice-number">01</span><h2>Create a team</h2><p>Name your team and open a fresh lobby.</p><label><span>Team name</span><input value={teamName} onChange={(event) => onTeamName(event.target.value)} maxLength={60} placeholder="Pixel Pioneers" required /></label><button className="primary-button compact-button" disabled={busy}>Create team <span>→</span></button></form> : <section className="choice-card create-choice restricted-choice"><span className="choice-number">01</span><h2>Team creation</h2><p>New team creation is currently limited to Pete. You can still open your teams or join with an invite.</p></section>}<form className="choice-card join-choice" onSubmit={onJoin}><span className="choice-number">02</span><h2>Join a team</h2><p>Paste the full link or just the secret.</p><label><span>Invite</span><input value={joinInput} onChange={(event) => onJoinInput(event.target.value)} placeholder="https://…/#join=…" required /></label><button className="primary-button compact-button orange-button" disabled={busy}>Join team <span>→</span></button></form></div></>;
}

export function TeamProjectsView({ team, projectName, busy, onProjectName, onCreateProject, onOpenProject }: { team: Team; projectName: string; busy: boolean; onProjectName: (value: string) => void; onCreateProject: (event: React.FormEvent) => void; onOpenProject: (projectId: string) => void }) {
  return <section className="projects-panel" aria-labelledby="projects-title"><div className="section-heading"><div><p className="eyebrow">GAMES YOUR TEAM BUILDS</p><h2 id="projects-title">Projects</h2></div><span>{team.projects.length} total</span></div>{team.projects.length ? <div className="project-list">{team.projects.map((item) => <article key={item.id}><a href={`/projects/${encodeURIComponent(item.id)}`} aria-busy={busy || undefined} onClick={(event) => { event.preventDefault(); onOpenProject(item.id); }}><span><strong>{item.name}</strong><small>{projectPhaseLabel(item.phase)}</small></span><b aria-hidden="true">→</b></a></article>)}</div> : <p className="empty-projects">{team.isOrganiser ? "No projects yet. Create the first evolving game for this team." : "No projects yet. The team creator can start the first game."}</p>}{team.isOrganiser && <form className="create-project-form" onSubmit={onCreateProject}><label><span>Project name</span><input required minLength={2} maxLength={80} value={projectName} onChange={(event) => onProjectName(event.target.value)} placeholder="Moonbase Mischief" /></label><button className="primary-button compact-button" disabled={busy}>Create project <span>→</span></button></form>}</section>;
}

function ProfileDialog({ profile, busy, onClose, onSave }: { profile: PublicProfile; busy: boolean; onClose: () => void; onSave: (edit: { displayName: string; about: string }) => void }) {
  const [displayName, setDisplayName] = useState(profile.metadata.display_name || profile.metadata.name || "");
  const [about, setAbout] = useState(profile.about || "");
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="profile-dialog" role="dialog" aria-modal="true" aria-labelledby="profile-title" onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}><div className="dialog-heading"><div><p className="eyebrow">NOSTR PROFILE</p><h2 id="profile-title">Edit profile</h2></div><button className="dialog-close" type="button" aria-label="Close profile editor" onClick={onClose}>×</button></div><form onSubmit={(event) => { event.preventDefault(); onSave({ displayName, about }); }}><p className="vault-warning">Use a nickname—not your full name, school, address, phone number, or other personal details.</p><label><span>Nickname</span><input required maxLength={80} value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label><label><span>About (optional)</span><textarea maxLength={500} rows={4} value={about} onChange={(event) => setAbout(event.target.value)} /></label><div className="dialog-actions"><button className="text-button" type="button" onClick={onClose}>Cancel</button><button className="primary-button compact-button" disabled={busy}>Publish profile</button></div></form></section></div>;
}

function ManageGamesDialog({ teams, busy, deletingProjectId, onClose, onOpenProject, onDeleteProject }: { teams: Team[]; busy: boolean; deletingProjectId: string | null; onClose: () => void; onOpenProject: (projectId: string) => void; onDeleteProject: (target: ProjectDeletionTarget) => void }) {
  const projects = teams.flatMap((team) => team.projects.map((project) => ({ team, project })));
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="profile-dialog manage-games-dialog" role="dialog" aria-modal="true" aria-labelledby="manage-games-title" onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}><div className="dialog-heading"><div><p className="eyebrow">MY LEVEL UP GAMES</p><h2 id="manage-games-title">Manage My Games</h2></div><button className="dialog-close" type="button" aria-label="Close game manager" onClick={onClose}>×</button></div>{projects.length ? <ol className="manage-games-list">{projects.map(({ team, project }) => <li key={project.id}><div><strong>{project.name}</strong><small>{team.name} · {projectPhaseLabel(project.phase)}</small></div><div className="manage-game-actions"><button className="text-button" type="button" disabled={busy} onClick={() => onOpenProject(project.id)}>Open</button>{team.isOrganiser ? <button className="danger-button" type="button" disabled={busy} onClick={() => onDeleteProject({ team, project })}>{deletingProjectId === project.id ? "Deleting..." : "Delete"}</button> : <span>Organiser only</span>}</div></li>)}</ol> : <p className="empty-projects">No games yet.</p>}<div className="dialog-actions single-action"><button className="text-button" type="button" onClick={onClose}>Done</button></div></section></div>;
}

function DeleteGameDialog({ target, busy, deletingProjectId, onCancel, onConfirm }: { target: ProjectDeletionTarget; busy: boolean; deletingProjectId: string | null; onCancel: () => void; onConfirm: (target: ProjectDeletionTarget) => void }) {
  const isDeleting = deletingProjectId === target.project.id;
  return <div className="dialog-backdrop destructive-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}><section className="profile-dialog delete-game-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-game-title" aria-describedby="delete-game-copy" onKeyDown={(event) => { if (event.key === "Escape" && !busy) onCancel(); }}><div className="dialog-heading"><div><p className="eyebrow">DELETE GAME</p><h2 id="delete-game-title">{target.project.name}</h2></div><button className="dialog-close" type="button" aria-label="Cancel deletion" disabled={busy} onClick={onCancel}>×</button></div><p id="delete-game-copy" className="delete-game-copy">This removes the game room and its playtest history for everyone on {target.team.name}. The team stays intact.</p><div className="dialog-actions destructive-actions"><button className="text-button" type="button" disabled={busy} onClick={onCancel}>Cancel</button><button className="danger-button" type="button" disabled={busy} onClick={() => onConfirm(target)}>{isDeleting ? "Deleting..." : "Delete game"}</button></div></section></div>;
}

export function AdminDeleteDialog({target,busy,onCancel,onConfirm}:{target:AdminDeletionTarget;busy:boolean;onCancel:()=>void;onConfirm:()=>void}) {
  const team = target.kind === "team";
  return <div className="dialog-backdrop destructive-backdrop" role="presentation" onMouseDown={(event)=>{if(event.target===event.currentTarget&&!busy)onCancel();}}><section className="profile-dialog delete-game-dialog" role="alertdialog" aria-modal="true" aria-labelledby="admin-delete-title" aria-describedby="admin-delete-copy" onKeyDown={(event)=>{if(event.key==="Escape"&&!busy)onCancel();}}><div className="dialog-heading"><div><p className="eyebrow">DELETE {target.kind.toUpperCase()}</p><h2 id="admin-delete-title">{target.name}</h2></div><button className="dialog-close" type="button" aria-label="Cancel deletion" disabled={busy} onClick={onCancel}>×</button></div><p id="admin-delete-copy" className="delete-game-copy">{team?`This permanently deletes ${target.name}, its ${target.projectCount??0} projects, memberships, invites, collaboration history, builds, and releases.`:`This permanently deletes ${target.name} from ${target.teamName}, including its collaboration history, builds, and releases. The team stays intact.`} This cannot be undone.</p><div className="dialog-actions destructive-actions"><button className="text-button" type="button" disabled={busy} onClick={onCancel}>Cancel</button><button className="danger-button" type="button" disabled={busy} onClick={onConfirm}>{busy?"Deleting…":`Delete ${target.kind}`}</button></div></section></div>;
}

function ForgetDeviceDialog({ busy, onCancel, onConfirm }: { busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  return <div className="dialog-backdrop destructive-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}><section className="profile-dialog delete-game-dialog" role="alertdialog" aria-modal="true" aria-labelledby="forget-device-title" aria-describedby="forget-device-copy" onKeyDown={(event) => { if (event.key === "Escape" && !busy) onCancel(); }}><div className="dialog-heading"><div><p className="eyebrow">FORGET DEVICE ACCOUNT</p><h2 id="forget-device-title">Remove local identity</h2></div><button className="dialog-close" type="button" aria-label="Cancel account removal" disabled={busy} onClick={onCancel}>×</button></div><p id="forget-device-copy" className="delete-game-copy">This permanently removes the encrypted identity from this browser. Level Up cannot recover it here if you have not backed it up elsewhere.</p><div className="dialog-actions destructive-actions"><button className="text-button" type="button" disabled={busy} onClick={onCancel}>Cancel</button><button className="danger-button" type="button" disabled={busy} onClick={onConfirm}>Forget account</button></div></section></div>;
}

function formatTraceTime(value: number | null): string {
  if (value === null) return "pending";
  return new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatTraceDuration(value: number | null): string {
  if (value === null) return "running";
  if (value < 1000) return `${value}ms`;
  return `${Math.round(value / 100) / 10}s`;
}

function formatTraceBytes(value: number | null): string {
  if (value === null) return "-";
  if (value < 1000) return `${value} B`;
  return `${Math.round(value / 100) / 10} KB`;
}

function formatTraceCost(value: number | null): string {
  return value === null ? "-" : `$${value.toFixed(6)}`;
}

function traceText(value: unknown): string { return typeof value === "string" ? value : JSON.stringify(value, null, 2); }
function TraceDisclosure({ title, body, open = false, accent = false }: { title: string; body: TraceBody | null; open?: boolean; accent?: boolean }) {
  return <details className={accent ? "admin-trace-final" : ""} open={open}><summary>{title}<span>{body ? `${formatTraceBytes(body.bytes)}${body.truncated ? " · TRUNCATED" : ""}` : "UNAVAILABLE"}</span></summary>{body ? <pre>{traceText(body.value)}</pre> : <p className="admin-trace-empty">Not captured for this run.</p>}</details>;
}

export function GroupModePanel({projects,busy,onChanged}:{projects:AdminProjectSummary[];busy:boolean;onChanged:()=>void}){
  const [run,setRun]=useState<GroupRun|null>(null);const [name,setName]=useState("");const [selected,setSelected]=useState<string[]>([]);const [message,setMessage]=useState("Loading saved workshop…");const [pending,setPending]=useState<GroupCommand|"save"|"load"|null>("load");const gate=useRef(createGroupModeRequestGate());
  useEffect(()=>{let active=true;const request=gate.current.begin();api<{run:GroupRun|null}>("/api/admin/group-run").then(({run:loaded})=>{if(!active||!gate.current.accepts(request))return;setRun(loaded);if(gate.current.acceptsDraftHydration(request)){setName(loaded?.name??"Scout workshop");setSelected(loaded?.selectedProjectIds??[]);}setMessage(loaded?"Saved workshop loaded. Commands use this selection.":"Select projects, then save and run preflight.");}).catch(error=>{if(active&&gate.current.accepts(request))setMessage(error instanceof Error?error.message:"Could not load the saved workshop.");}).finally(()=>{if(active&&gate.current.accepts(request))setPending(null);});return()=>{active=false;};},[]);
  const editName=(value:string)=>{gate.current.edited();setName(value);};
  const editSelection=(projectId:string,checked:boolean)=>{gate.current.edited();setSelected(current=>checked?current.filter(id=>id!==projectId):[...current,projectId]);};
  const dirty=groupModeDraftIsDirty(run,name,selected);const controlsBusy=busy||pending!==null;
  async function save(){const request=gate.current.begin();setPending("save");setMessage(`Saving ${selected.length} selected project${selected.length===1?"":"s"}…`);try{const result=await api<{run:GroupRun}>("/api/admin/group-run",{method:"PUT",body:JSON.stringify({name,projectIds:selected})});if(!gate.current.accepts(request))return;setRun(result.run);setName(result.run.name);setSelected(result.run.selectedProjectIds);setMessage(`Saved ${result.run.selectedProjectIds.length} project${result.run.selectedProjectIds.length===1?"":"s"}. Commands use this selection.`);onChanged();}catch(error){if(gate.current.accepts(request))setMessage(error instanceof Error?error.message:"Could not save Group Mode.");}finally{if(gate.current.accepts(request))setPending(null);}}
  async function command(command:GroupCommand){if(!run||dirty)return;const request=gate.current.begin(),label=command.replaceAll("_"," ");setPending(command);setMessage(`${label} running for ${run.selectedProjectIds.length} saved projects…`);try{const result=await api<{run:GroupRun;results:GroupRun["results"]}>("/api/admin/group-run/commands",{method:"POST",body:JSON.stringify({command,requestId:crypto.randomUUID()})});if(!gate.current.accepts(request))return;setRun(result.run);const failed=result.results.filter(item=>item.status==="failed").length,skipped=result.results.filter(item=>item.status==="skipped").length;setMessage(`${label} finished: ${result.results.length-failed-skipped} succeeded, ${skipped} skipped, ${failed} failed.`);onChanged();}catch(error){if(gate.current.accepts(request))setMessage(error instanceof Error?error.message:"Group command failed.");}finally{if(gate.current.accepts(request))setPending(null);}}
  const selectedProjects=projects.filter(project=>run?.selectedProjectIds.includes(project.id));
  return <section className="group-mode-panel" aria-labelledby="group-mode-title" aria-busy={pending!==null}><div className="section-heading"><div><p className="eyebrow">FACILITATED INITIAL LAUNCH</p><h2 id="group-mode-title">Group Mode</h2></div><span>{run?.status?.toUpperCase()??"DRAFT"}</span></div><label><span>Workshop name</span><input value={name} maxLength={80} disabled={controlsBusy} onChange={event=>editName(event.target.value)}/></label><fieldset disabled={controlsBusy}><legend>Projects and preflight</legend>{projects.map(project=>{const checked=selected.includes(project.id);const ready=project.activeInvite&&project.joinedCount>0;return <label key={project.id} className="group-project-option"><input type="checkbox" checked={checked} onChange={()=>editSelection(project.id,checked)}/><span><strong>{project.teamName} · {project.name}</strong><small>{project.activeInvite?"Invite ready":"Invite missing"} · {project.joinedCount} joined · {project.connectedCount===null?"connected unavailable":`${project.connectedCount} connected`} · {project.round?phaseTitle(project.round.phase):projectPhaseLabel(project.phase)} · {ready?"READY":"CHECK"}</small></span></label>})}</fieldset>{dirty&&run&&<p className="waiting-state">Edits are not saved. Save &amp; preflight before running commands.</p>}<div className="admin-actions"><button className="text-button" type="button" disabled={controlsBusy||!selected.length||!dirty} onClick={()=>void save()}>{pending==="save"?"Saving & preflighting…":"Save & preflight"}</button>{(["open_play","start_voting","extend_voting","close_voting","start_first_brainstorm"] as GroupCommand[]).map(action=>{const eligible=selectedProjects.filter(project=>groupCommandEligible(project,action)).length;return <button key={action} className="text-button" type="button" disabled={controlsBusy||!run||dirty||eligible===0} onClick={()=>void command(action)}>{pending===action?`${action.replaceAll("_"," ")}…`:`${action.replaceAll("_"," ")} (${eligible}/${selectedProjects.length})`}</button>})}<button className="text-button" type="button" disabled={controlsBusy||!run||dirty} onClick={()=>void command(run?.status==="paused"?"resume":"pause")}>{pending==="pause"||pending==="resume"?`${pending}…`:run?.status==="paused"?"Resume":"Pause"}</button></div><p className="waiting-state">Counts use the saved selection. Ineligible projects are skipped with their own result.</p>{run?.results.slice(-(run.selectedProjectIds.length||1)).map(result=><p key={`${result.projectId}-${result.at}-${result.command}`} className={result.status==="failed"?"admin-run-error":"waiting-state"}>{projects.find(project=>project.id===result.projectId)?.name??result.projectId}: {result.message}</p>)}<p className="status" role="status" aria-live="polite">{message}</p></section>;
}

export function AdminPromptView({ tab, prompts, selectedId, draft, settings, settingsDraft, turnsDraft, votesDraft = "5", modelsDraft = "", defaultModelDraft = "", projects, teams = [], runs, selectedProjectId, selectedRunId, busy, status, onTab, onSelect, onDraft, onSettingsDraft, onTurnsDraft, onVotesDraft = () => undefined, onModelsDraft = () => undefined, onDefaultModelDraft = () => undefined, onPromptModel = () => undefined, onSelectProject, onSelectRun, onRefreshRuns, onDeleteProject = () => undefined, onDeleteTeam = () => undefined, onSave, onReset, onSaveSettings, onSaveModels = () => undefined }: { tab: AdminTab; prompts: AgentPromptRecord[]; selectedId: AgentPromptStageId | null; draft: string; settings: AdminSettingsRecord | null; settingsDraft: string; turnsDraft: string; votesDraft?: string; modelsDraft?: string; defaultModelDraft?: string; projects: AdminProjectSummary[]; teams?: AdminTeamSummary[]; runs: AgentRunTrace[]; selectedProjectId: string; selectedRunId: string; busy: boolean; status: string; onTab: (tab: AdminTab) => void; onSelect: (id: AgentPromptStageId) => void; onDraft: (value: string) => void; onSettingsDraft: (value: string) => void; onTurnsDraft: (value: string) => void; onVotesDraft?: (value: string) => void; onModelsDraft?: (value: string) => void; onDefaultModelDraft?: (value: string) => void; onPromptModel?: (id: AgentPromptStageId, model: string | null) => void; onSelectProject: (id: string) => void; onSelectRun: (id: string) => void; onRefreshRuns: () => void; onDeleteProject?: (project:AdminProjectSummary)=>void; onDeleteTeam?: (team:AdminTeamSummary)=>void; onSave: () => void; onReset: () => void; onSaveSettings: () => void; onSaveModels?: () => void }) {
  const selected = prompts.find((prompt) => prompt.id === selectedId) ?? prompts[0] ?? null;
  const dirty = Boolean(selected && draft !== selected.template);
  const settingsDirty = Boolean(settings && (settingsDraft !== String(settings.brainstormSuggestionIntervalSeconds) || turnsDraft !== String(settings.agentMaxTurns) || votesDraft !== String(settings.proposalVoteAllowance)));
  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;
  const filteredRuns = selectedProjectId ? runs.filter((run) => run.fields.projectId === selectedProjectId) : runs;
  const selectedRun = filteredRuns.find((run) => run.id === selectedRunId) ?? filteredRuns[0] ?? null;
  if (tab === "models") return <section className="admin-mode" aria-labelledby="admin-models-title"><div className="admin-hero"><div><p className="eyebrow">OWNER ADMIN MODE</p><h1 id="admin-models-title">Goose controls</h1><p>Choose the OpenRouter inventory and the model each prompt stage uses next.</p></div><span className="phase-badge">OWNER ONLY</span></div><nav className="admin-tabs" aria-label="Admin sections"><button type="button" onClick={() => onTab("monitoring")}>Monitoring</button><button type="button" onClick={() => onTab("group-mode")}>Group Mode</button><button type="button" className="selected" aria-current="page">Models</button><button type="button" onClick={() => onTab("prompts")}>Prompts</button></nav><form className="admin-models-card" onSubmit={(event) => { event.preventDefault(); onSaveModels(); }}><div><p className="eyebrow">OPENROUTER INVENTORY</p><h2>Allowed models</h2><p>One provider/model ID per line. Change assigned stages before removing their model.</p></div><label><span>Allowed model IDs</span><textarea rows={10} value={modelsDraft} onChange={(event) => onModelsDraft(event.target.value)} spellCheck={false} /></label><label><span>Default model</span><select value={defaultModelDraft} onChange={(event) => onDefaultModelDraft(event.target.value)}>{modelsDraft.split(/\r?\n/).map((model) => model.trim()).filter(Boolean).map((model) => <option key={model} value={model}>{model}</option>)}</select></label><button className="primary-button compact-button" disabled={busy}>{busy ? "Saving..." : "Save models"}</button></form><section className="admin-model-stage-list" aria-labelledby="stage-model-title"><div><p className="eyebrow">PROMPT STAGES</p><h2 id="stage-model-title">Stage models</h2></div>{prompts.map((prompt) => <label key={prompt.id}><span>{prompt.label}</span><select value={prompt.model ?? ""} onChange={(event) => onPromptModel(prompt.id, event.target.value || null)}><option value="">Use default model ({settings?.defaultModel ?? "unset"})</option>{settings?.allowedModels.map((model) => <option key={model} value={model}>{model}</option>)}</select><small>Effective model: {prompt.effectiveModel}</small></label>)}</section><p className="status" role="status" aria-live="polite">{status}</p></section>;
  return <section className="admin-mode" aria-labelledby="admin-title">
    <div className="admin-hero"><div><p className="eyebrow">OWNER ADMIN MODE</p><h1 id="admin-title">Goose controls</h1><p>Review Goose ACP runtime limits, project loops, and recent agent activity.</p></div><span className="phase-badge">OWNER ONLY</span></div>
    <nav className="admin-tabs" aria-label="Admin sections">
      <button type="button" className={tab === "monitoring" ? "selected" : ""} aria-current={tab === "monitoring" ? "page" : undefined} onClick={() => onTab("monitoring")}>Monitoring</button>
      <button type="button" className={tab === "group-mode" ? "selected" : ""} aria-current={tab === "group-mode" ? "page" : undefined} onClick={() => onTab("group-mode")}>Group Mode</button>
      <button type="button" onClick={() => onTab("models")}>Models</button>
      <button type="button" className={tab === "prompts" ? "selected" : ""} aria-current={tab === "prompts" ? "page" : undefined} onClick={() => onTab("prompts")}>Prompts</button>
    </nav>
    {tab === "monitoring" ? <section className="admin-inspector" aria-labelledby="admin-inspector-title">
      <div className="section-heading"><div><p className="eyebrow">PROJECT PROCESS LOOPS</p><h2 id="admin-inspector-title">Monitoring</h2></div><button className="text-button" type="button" disabled={busy} onClick={onRefreshRuns}>Refresh</button></div>
      <section className="admin-resource-controls" aria-labelledby="admin-resources-title"><div className="section-heading"><div><p className="eyebrow">OWNER CONTROLS</p><h3 id="admin-resources-title">Teams and projects</h3></div></div>{teams.map(team=><article key={team.id}><div><strong>{team.name}</strong><small>{team.memberCount} members · {team.projectCount} projects</small></div><button className="danger-button" type="button" disabled={busy} onClick={()=>onDeleteTeam(team)}>Delete team</button></article>)}</section>
      <div className="admin-project-operations">{projects.map(project=><article key={project.id}><div><strong>{project.teamName} · {project.name}</strong><small>{project.round?`Round ${project.round.number} · ${phaseTitle(project.round.phase)}`:projectPhaseLabel(project.phase)} · {project.joinedCount} joined · {project.connectedCount===null?"live connections unavailable":`${project.connectedCount} connected`}</small><small>Captain: {project.captain?shortNpub(project.captain.npub):project.round?"No eligible player · owner override available":"Assigned from Round 2"} · Agent: {project.round?.buildStatus??"idle"}{project.round?.buildStage?` / ${project.round.buildStage}`:""} · Release: {project.stablePlayUrl?"stable":"none yet"}</small></div><div><a className="text-button" href={`/projects/${encodeURIComponent(project.id)}`} target="_blank" rel="noreferrer">Open project ↗</a>{project.failure&&<a className="danger-link" href={`/projects/${encodeURIComponent(project.id)}#${project.failure.section}`} target="_blank" rel="noreferrer">Jump to failure ↗</a>}<button className="danger-button" type="button" disabled={busy} onClick={()=>onDeleteProject(project)}>Delete project</button></div></article>)}</div>
      <div className="admin-inspector-grid">
        <nav className="admin-project-list" aria-label="Projects">{projects.length ? projects.map((project) => <button key={project.id} type="button" className={project.id === selectedProjectId ? "selected" : ""} aria-pressed={project.id === selectedProjectId} onClick={() => onSelectProject(project.id)}><strong>{project.name}</strong><span>{project.teamName}</span><small>{project.round ? `Round ${project.round.number} · ${phaseTitle(project.round.phase)} · seq ${project.round.lastSequence}` : projectPhaseLabel(project.phase)}</small></button>) : <p>No projects yet.</p>}</nav>
        <div className="admin-run-list" aria-label="Agent runs" aria-live="polite">
          <div className="admin-run-heading"><strong>{selectedProject ? selectedProject.name : "All projects"}</strong><span>{filteredRuns.length} recent {filteredRuns.length === 1 ? "run" : "runs"}</span></div>
          {filteredRuns.length ? filteredRuns.map((run) => <button className={`admin-run-row ${run.status} ${run.id === selectedRun?.id ? "selected" : ""}`} key={run.id} type="button" aria-pressed={run.id === selectedRun?.id} onClick={() => onSelectRun(run.id)}><span><strong>{run.stage}</strong><small>{formatTraceTime(run.startedAt)}</small></span><b>{run.status}</b><small>{run.model ?? "model unset"} · {run.maxTurns} turns · {formatTraceDuration(run.durationMs)}</small></button>) : <p className="empty-projects">No recent agent runs for this selection.</p>}
        </div>
        <article className="admin-run-detail" aria-live="polite">
          {selectedRun ? <><div className="admin-run-detail-title"><div><p className="eyebrow">{selectedRun.stage}</p><h3>{selectedRun.status}</h3></div><span>{formatTraceDuration(selectedRun.durationMs)}</span></div><dl className="admin-detail-grid"><dt>Client</dt><dd>{selectedRun.clientName}</dd><dt>Model</dt><dd>{selectedRun.model ?? "unset"}</dd><dt>Max turns</dt><dd>{selectedRun.maxTurns}</dd><dt>Goose session</dt><dd>{selectedRun.gooseSessionId ?? "pending"}</dd><dt>Started</dt><dd>{formatTraceTime(selectedRun.startedAt)}</dd><dt>Completed</dt><dd>{formatTraceTime(selectedRun.completedAt)}</dd><dt>Prompt bytes</dt><dd>{formatTraceBytes(selectedRun.promptBytes)}</dd><dt>Output bytes</dt><dd>{formatTraceBytes(selectedRun.outputBytes)}</dd><dt>Max output</dt><dd>{formatTraceBytes(selectedRun.maxOutputBytes)}</dd><dt>Tokens</dt><dd>{selectedRun.inputTokens ?? "-"} in / {selectedRun.outputTokens ?? "-"} out</dd><dt>Cost</dt><dd>{formatTraceCost(selectedRun.cost)}</dd><dt>Project</dt><dd>{selectedRun.fields.projectId ?? selectedProject?.id ?? "-"}</dd><dt>Round</dt><dd>{selectedRun.fields.roundNumber ?? "-"}</dd><dt>Version</dt><dd>{selectedRun.fields.version ?? "-"}</dd></dl>{selectedRun.errorCode && <p className="admin-run-error">{selectedRun.errorCode}{selectedRun.errorDetail ? ` · ${selectedRun.errorDetail}` : ""}</p>}{selectedRun.transcriptTruncated && <p className="admin-run-warning">Transcript retention limit reached. Truncated sections are labelled.</p>}<TraceDisclosure title="Compiled model input" body={selectedRun.compiledInput} open />
          <section className="admin-turns" aria-labelledby={`turns-${selectedRun.id}`}><div className="admin-run-heading"><strong id={`turns-${selectedRun.id}`}>Model turns</strong><span>{selectedRun.turns.length}</span></div>{selectedRun.turns.length ? selectedRun.turns.map((turn) => <TraceDisclosure key={`${turn.number}-${turn.observedAt}`} title={`Turn ${turn.number} · ${turn.source} · ${formatTraceTime(turn.observedAt)}`} body={turn} open={selectedRun.turns.length === 1} />) : <p className="admin-trace-empty">No model output was observed.</p>}</section>
          <TraceDisclosure title="Final Level Up payload" body={selectedRun.finalPayload} open accent /><details><summary>Safe fields</summary><pre>{JSON.stringify(selectedRun.fields, null, 2)}</pre></details></> : <div className="admin-run-empty"><h3>Select a run</h3><p>Recent Goose activity for the selected project will appear here.</p></div>}
        </article>
      </div>
    </section> : tab === "group-mode" ? <GroupModePanel projects={projects} busy={busy} onChanged={onRefreshRuns}/> : <><form className="admin-settings-card" onSubmit={(event) => { event.preventDefault(); onSaveSettings(); }}><div><p className="eyebrow">LIVE GAME SETTINGS</p><h2>Round controls</h2></div><label><span>Seconds between lvl_up checks</span><input type="number" min={5} max={600} step={1} value={settingsDraft} onChange={(event) => onSettingsDraft(event.target.value)} /></label><label><span>Goose max turns</span><input type="number" min={1} max={5} step={1} value={turnsDraft} onChange={(event) => onTurnsDraft(event.target.value)} /></label><label><span>Proposal votes per player</span><input type="number" min={1} max={20} step={1} value={votesDraft} onChange={(event) => onVotesDraft(event.target.value)} /></label><button className="primary-button compact-button" disabled={busy || !settingsDirty}>{busy ? "Saving..." : "Save settings"}</button></form>{prompts.length ? <div className="admin-layout"><nav className="admin-stage-list" aria-label="Prompt stages">{prompts.map((prompt) => <button key={prompt.id} type="button" className={prompt.id === selected?.id ? "selected" : ""} aria-pressed={prompt.id === selected?.id} onClick={() => onSelect(prompt.id)}><strong>{prompt.label}</strong><span>{prompt.stage}</span><small>{prompt.isDefault ? "Default prompt" : "Custom prompt"} · {prompt.model ? "Specific model" : "Global model"}</small></button>)}</nav>{selected && <form className="admin-prompt-editor" onSubmit={(event) => { event.preventDefault(); onSave(); }}><div className="section-heading"><div><p className="eyebrow">{selected.stage}</p><h2>{selected.label}</h2></div><span>{selected.isDefault ? "DEFAULT" : "CUSTOM"}</span></div><p>{selected.description}</p><label><span>Model for this stage</span><select value={selected.model ?? ""} disabled={busy || !settings} onChange={(event) => onPromptModel(selected.id, event.target.value || null)}><option value="">Use global default ({settings?.defaultModel ?? "unset"})</option>{settings?.allowedModels.map((model) => <option key={model} value={model}>{model}</option>)}</select><small>Effective model: {selected.effectiveModel}</small></label><label><span>Prompt template</span><textarea rows={18} value={draft} onChange={(event) => onDraft(event.target.value)} spellCheck={false} /></label><div className="admin-placeholder"><strong>Required placeholder</strong><code>{PROMPT_INPUT_PLACEHOLDER}</code><span>{draft.includes(PROMPT_INPUT_PLACEHOLDER) ? "present" : "missing"}</span></div><details className="default-prompt"><summary>Show compiled default</summary><pre>{selected.defaultTemplate}</pre></details><div className="admin-actions"><button className="text-button" type="button" disabled={busy || selected.isDefault} onClick={onReset}>Reset to default</button><button className="primary-button compact-button" disabled={busy || !dirty || !draft.includes(PROMPT_INPUT_PLACEHOLDER)}>{busy ? "Saving..." : "Save prompt"}</button></div></form>}</div> : <section className="loop-panel"><h2>No prompt stages loaded</h2><p>Refresh after signing in as the owner.</p></section>}</>}
    <p className="status" role="status" aria-live="polite">{status}</p>
  </section>;
}

export function InvitePanel({ team, invite, busy, onRotate }: { team: Team; invite: Invite | null; busy: boolean; onRotate: () => void }) {
  const [qr, setQr] = useState(""); const [copied, setCopied] = useState(false);
  useEffect(() => {
    let active = true;
    setQr("");
    if (invite) void import("qrcode")
      .then(({ default: QRCode }) => QRCode.toDataURL(invite.url, { errorCorrectionLevel: "H", margin: 4, width: 256, color: { dark: "#171713", light: "#fffdf3" } }))
      .then((value) => { if (active) setQr(value); })
      .catch(() => { if (active) setQr(""); });
    return () => { active = false; };
  }, [invite]);
  return <aside className="invite-panel" aria-labelledby="invite-title"><div className="invite-heading"><div><span>BRING YOUR CREW</span><h2 id="invite-title">Scan to join</h2></div><span className="tiny-cubes" aria-hidden="true">■ ■ ■</span></div>{invite ? <><div className="qr-stage">{qr ? <img src={qr} alt={`QR invite for ${team.name}`} width="256" height="256" /> : <div className="qr-loading">Building QR…</div>}</div><label className="invite-link"><span>Invite link</span><input readOnly value={invite.url} aria-label="Team invite link" /></label><div className="invite-actions"><button className="primary-button compact-button" type="button" onClick={async () => { await navigator.clipboard.writeText(invite.url); setCopied(true); window.setTimeout(() => setCopied(false), 1800); }}>{copied ? "Copied!" : "Copy link"}</button>{team.isOrganiser && <button className="text-button" type="button" onClick={onRotate} disabled={busy}>Rotate</button>}</div></> : <div className="invite-empty"><p>The current invite could not be loaded. Refresh this team page to try again.</p></div>}<small>High-correction QR · Keep the whole paper border visible</small></aside>;
}

const TEMPLATE_THUMBNAILS: Record<string, string> = {
  fps: "/thumbnails/citadel-strike.webp",
  platformer: "/thumbnails/skyline-sprint.webp",
  world: "/thumbnails/village-games.webp",
  arcade: "/thumbnails/arcade-cabinet.webp",
};

function TemplateVisual({ kind }: { kind: string }) {
  const thumbnail = TEMPLATE_THUMBNAILS[kind];
  return <div className={`template-visual visual-${kind}`} aria-hidden="true">{thumbnail ? <img src={thumbnail} alt="" loading="lazy" decoding="async" /> : <><i /><b /><span /><em /></>}</div>;
}

const LOOP_STEPS = ["Brainstorm", "Review", "Prioritise", "Build", "Iterate"] as const;

function phaseIndex(phase: RoundPhase): number {
  if (phase === "brainstorm") return 0;
  if (phase === "proposals") return 1;
  if (phase === "voting") return 2;
  return 3;
}

function phaseTitle(phase: RoundPhase): string {
  return phase === "proposals" ? "Requirement cards" : phase === "brief" ? "Frozen brief" : phase === "playtest" ? "Build complete" : phase.charAt(0).toUpperCase() + phase.slice(1);
}

function RoundProgressRail({ round }: { round: RoundSnapshot }) {
  const active = phaseIndex(round.phase);
  return <ol className="round-progress" aria-label={`Round ${round.number} collaboration loop`}>
    {LOOP_STEPS.map((label, index) => <li key={label} className={`${index < active ? "done" : index === active ? "active" : ""}${label === "Iterate" ? " iterate-loop" : ""}`} aria-current={index === active ? "step" : undefined}><b>{index + 1}</b><span>{label}</span>{label === "Iterate" && <small>loops to Brainstorm</small>}</li>)}
  </ol>;
}

function ideaTrace(proposal: Proposal, contributions: RoundContribution[]): string[] {
  const bySequence = new Map(contributions.map((item) => [item.sequence, item.body.trim().replace(/\s+/g, " ")]));
  return proposal.ideaReferences.map((sequence) => {
    const source = bySequence.get(sequence);
    return source ? `#${sequence}: ${source.length > 96 ? `${source.slice(0, 93)}...` : source}` : `#${sequence}`;
  });
}

function backlogTrace(proposal: Proposal, backlog: RequirementBacklogItem[]): string[] {
  const byId = new Map(backlog.map((item) => [item.proposalId, item]));
  return (proposal.backlogReferences ?? []).map((id) => {
    const source = byId.get(id);
    return source ? `Round ${source.sourceRoundNumber} #${source.sourceRank || "?"}: ${source.title}` : `Earlier card ${id}`;
  });
}

function agentStageMessage(round: RoundSnapshot): string {
  if (round.phase === "brainstorm") return "lvl_up starts an empty room with two ideas, then only responds after a new player idea. It cannot close the room or choose work.";
  if (round.phase === "proposals") return "Review the requirement cards before voting opens.";
  if (round.phase === "voting") return "Your vote tokens stay private until voting closes.";
  if (round.phase === "brief") return "The voted build order is fixed for this round.";
  if (round.phase === "building") {
    const activeStep = round.build?.steps.find((step) => step.status === "active");
    return activeStep ? activeStep.detail : "The next playable version is being prepared.";
  }
  if (round.phase === "playtest") return "The release is ready in Game Versions. Use Brainstorm New Features whenever the team wants to iterate.";
  return "The last playable version is safe. The organiser can retry when the problem is resolved.";
}

function featureLoopLabel(loop: FeatureBuildStep["loop"]): string {
  return loop === "review" ? "Review" : loop === "build" ? "Build" : "Test";
}

function featureStatusLabel(status: FeatureBuild["status"]): string {
  return ({ queued: "Queued", reviewing: "Reviewing", building: "Building", testing: "Testing", succeeded: "Ready", no_change: "No change needed", failed: "Failed", interrupted: "Interrupted", deferred: "Deferred" })[status];
}

export function featureLoopDurationMs(feature: FeatureBuild, stepIndex: number, now: number): number | null {
  const step = feature.steps[stepIndex];
  if (!step || typeof step.at !== "number") return null;
  const nextAt = feature.steps.slice(stepIndex + 1).find((candidate) => typeof candidate.at === "number")?.at;
  const end = typeof nextAt === "number" ? nextAt : step.status === "active" ? now : feature.completedAt;
  return typeof end === "number" && end >= step.at ? end - step.at : null;
}

export function formatBuildDuration(value: number | null): string {
  if (value === null) return "—";
  const seconds = Math.max(0, Math.floor(value / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function FeatureCycleSteps({ feature }: { feature: FeatureBuild }) {
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    if (!feature.steps.some((step) => step.status === "active")) return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [feature.proposalId, feature.currentAgentLoop]);
  return <ol>{feature.steps.map((step,index) => <li key={step.loop} className={step.status}><b>{featureLoopLabel(step.loop)}</b><span>{step.detail}</span><em>{step.status} · <time>{formatBuildDuration(featureLoopDurationMs(feature,index,clock))}</time></em></li>)}</ol>;
}

function fallbackRankedProposal(proposal: Proposal, index: number): RankedProposal {
  return { ...proposal, rank: index + 1, votes: 0, firstPlaceVotes: 0, secondPlaceVotes: 0, thirdPlaceVotes: 0 };
}

function featureProposalsForRound(round: RoundSnapshot): RankedProposal[] {
  if (round.brief?.selected?.length) return round.brief.selected;
  if (round.rankings?.length) return round.rankings.slice(0, 3);
  return round.proposals.slice(0, 3).map(fallbackRankedProposal);
}

function fallbackFeatureBuilds(round: RoundSnapshot): FeatureBuild[] {
  const build = round.build;
  if (!build) return [];
  const proposals = featureProposalsForRound(round);
  const included = new Set(build.includedProposalIds);
  const deferred = new Set(build.deferredProposalIds);
  const activeLoop = build.currentStage === "analysing" ? "review" : build.currentStage === "coding" ? "build" : build.currentStage === "testing" || build.currentStage === "publishing" ? "test" : null;
  return proposals.map((proposal, index): FeatureBuild => {
    const succeeded = included.has(proposal.id) && build.validated;
    const failed = build.status === "failed" && (index === 0 || !included.size);
    const status: FeatureBuild["status"] = succeeded ? "succeeded" : failed ? "failed" : deferred.has(proposal.id) && build.status !== "running" ? "deferred" : index === 0 && activeLoop === "review" ? "reviewing" : index === 0 && activeLoop === "build" ? "building" : index === 0 && activeLoop === "test" ? "testing" : "queued";
    const steps = build.steps.filter((step) => step.status !== "pending").map((step): FeatureBuildStep | null => {
      const loop = step.stage === "analysing" ? "review" : step.stage === "coding" ? "build" : step.stage === "testing" || step.stage === "publishing" ? "test" : null;
      return loop ? { loop, status: step.status === "active" ? "active" : step.status === "failed" ? "failed" : "complete", at: step.at, detail: step.detail } : null;
    }).filter((step): step is FeatureBuildStep => Boolean(step));
    return { proposalId: proposal.id, queuePosition: index + 1, status, currentAgentLoop: index === 0 ? activeLoop : null, steps, releaseUrl: succeeded ? build.releaseUrl : null, failure: failed ? build.failure : null, reportCount: 0, latestReport: null, startedAt: index === 0 ? build.startedAt : null, completedAt: succeeded || failed ? build.completedAt : null, activity: [] };
  });
}

function proposalForFeature(feature: FeatureBuild, proposals: RankedProposal[]): RankedProposal | null {
  return proposals.find((proposal) => proposal.id === feature.proposalId) ?? null;
}

function versionLabel(url: string, fallback: number): string {
  const match = url.match(/\/versions\/(v\d+)\/?(?:[?#].*)?$/i);
  return match?.[1]?.toUpperCase() ?? `VERSION ${fallback}`;
}

function PlayableVersions({ versions, project, brainstormState, busy, canBrainstorm=true, onBrainstormMore }: { versions: ProjectVersionHistoryEntry[]; project: ProjectRoom; brainstormState: "available" | "in-progress" | "waiting"; busy: boolean; canBrainstorm?:boolean; onBrainstormMore: () => void }) {
  const newestFirst = versions.slice().reverse();
  return <section className="version-library" aria-labelledby="version-library-title">
    <div className="section-heading"><div><p className="eyebrow">PLAYABLE HISTORY</p><h3 id="version-library-title">Game versions</h3></div><span>{versions.length + 1} AVAILABLE</span></div>
    {brainstormState === "in-progress"
      ? <a className="primary-button version-brainstorm-button" href="#ideas-title">Go to Brainstorm</a>
      : canBrainstorm?<button className="primary-button version-brainstorm-button" type="button" disabled={busy||brainstormState==="waiting"} onClick={onBrainstormMore}>{brainstormState==="waiting"?"Brainstorm available when Build starts":"Brainstorm New Features"}</button>:<p className="waiting-state">Waiting for the Round Captain to start the next brainstorm.</p>}
    <ol>
      {newestFirst.map((version, index) => { const label = versionLabel(version.releaseUrl, versions.length - index + 1); return <li key={`${version.proposalId}:${version.releaseUrl}`}><span className="version-number">{label}</span><div><strong>{version.title}</strong><p>{version.playerChange}</p><small>Round {version.roundNumber} · {version.status === "no_change" ? "No change needed · Stable version preserved" : "Feature delivered · Ready"}</small></div><a href={version.releaseUrl} target="_blank" rel="noreferrer">Play {label} ↗</a></li>; })}
      <li><span className="version-number">V1</span><div><strong>{project.selectedTemplate?.title ?? "Starting game"}</strong><p>{project.selectedTemplate?.description ?? "The playable starting version selected by the team."}</p><small>Starting version · Ready</small></div>{project.selectedTemplate?.previewUrl && <a href={project.selectedTemplate.previewUrl} target="_blank" rel="noreferrer">Play V1 ↗</a>}</li>
    </ol>
  </section>;
}

function BuildQueueExperience({ round, project, isOwnerAdmin, busy, onReportBuild, onStartBuild, onDeferFeature }: { round: RoundSnapshot; project: ProjectRoom; isOwnerAdmin: boolean; busy: boolean; successorBrainstormActive?: boolean; onReportBuild: (note: string) => Promise<boolean> | boolean; onStartBuild: () => void; onDeferFeature: () => void; onBrainstormMore?: () => void }) {
  const [reportOpen, setReportOpen] = useState(false);
  const [reportNote, setReportNote] = useState("");
  const [cancelOpen, setCancelOpen] = useState(false);
  const build = round.build;
  if (!build) return null;
  const proposals = featureProposalsForRound(round);
  const features = ((build.featureBuilds?.length ? build.featureBuilds : fallbackFeatureBuilds(round))).slice().sort((a, b) => a.queuePosition - b.queuePosition).filter((feature) => proposalForFeature(feature, proposals));
  const active = features.find((feature) => feature.proposalId === build.activeFeatureProposalId)
    ?? features.find((feature) => feature.currentAgentLoop)
    ?? features.find((feature) => ["reviewing", "building", "testing", "failed", "interrupted"].includes(feature.status))
    ?? features.find((feature) => feature.status === "queued")
    ?? [...features].reverse().find((feature) => feature.status === "succeeded" || feature.status === "no_change")
    ?? features[0];
  if (!active) return null;
  const activeProposal = proposalForFeature(active, proposals)!;
  const queued = features.filter((feature) => feature.proposalId !== active.proposalId);
  const previousPlayable = project.stablePlayUrl ?? build.previousStableUrl ?? project.selectedTemplate?.previewUrl ?? null;
  const canReport = round.phase === "building" || round.phase === "playtest";
  return <section className="loop-panel feature-build-panel" id="active-build">
    <div className="section-heading"><div><p className="eyebrow">{build.simulated ? "VISIBLE SIMULATED BUILD" : "FEATURE BUILD QUEUE"}</p><h2>Build queue</h2></div><span>{featureStatusLabel(active.status)}</span></div>
    <div className="feature-build-layout">
      <div className="feature-card-column">
        <article className={`feature-build-card ${active.status}`}>
          <span>#{active.queuePosition} · {featureStatusLabel(active.status)}</span>
          <h3>{activeProposal.title}</h3>
          <p>{activeProposal.playerChange}</p>
          {active.status === "no_change" && <p className="feature-no-change">This feature was already present or the safe playable result produced no material change. The stable game was versioned and the queue continued.</p>}
          {active.releaseUrl && <a className="feature-play-link" href={active.releaseUrl} target="_blank" rel="noreferrer">Play this feature</a>}
          {active.delivery?.review === "failed" && <p className="feature-review-note">The independent review could not complete. Level Up published the checked primary candidate; the review failure is recorded for operators.</p>}
          {active.delivery?.review === "changes_required" && active.delivery.correction === "checked" && <p className="feature-review-note">Independent review found issues, and one checked corrective build was published.</p>}
          {active.delivery?.correction === "failed" && <p className="feature-review-note">The corrective build did not pass its checks, so Level Up published the checked primary candidate instead.</p>}
          {(active.status === "failed" || active.status === "interrupted") && <p className="feature-failure">{active.failure ?? build.failure ?? "This feature did not validate."}</p>}
          {active.latestReport && <p className="feature-report-note">Latest report: {active.latestReport.note || "Game is not running."}</p>}
        </article>
        {queued.length > 0 && <ol className="queued-feature-stack" aria-label="Queued feature cards">{queued.map((feature) => {
          const proposal = proposalForFeature(feature, proposals)!;
          return <li key={feature.proposalId} className={feature.status}><span>#{feature.queuePosition}</span><strong>{proposal.title}</strong><small>{featureStatusLabel(feature.status)}</small>{feature.releaseUrl && <a href={feature.releaseUrl} target="_blank" rel="noreferrer">Play this feature</a>}</li>;
        })}</ol>}
      </div>
      <aside className="feature-cycle-panel" aria-label="Active feature build cycle">
        <h3>{activeProposal.title}</h3>
        {active.steps.length ? <FeatureCycleSteps feature={active}/> : <p className="waiting-state">Waiting for a real build loop to start for this card.</p>}
        {active.status === "building" && <div className="build-thinking" role="status" aria-live="polite" aria-atomic="false"><span className="build-thinking-cubes" aria-hidden="true"><i/><i/><i/></span><div><strong>lvl_up is working</strong>{active.activity?.length ? <ol>{active.activity.map((update,index) => <li key={`${update.at}:${index}`}><span>{update.message}</span></li>)}</ol> : <p>Opening the game workspace and getting the selected feature into focus…</p>}</div></div>}
        <div className="build-scope"><p><strong>Queued:</strong> {features.filter((feature) => feature.status === "queued").length}</p><p><strong>Complete:</strong> {features.filter((feature) => feature.status === "succeeded" || feature.status === "no_change").length}</p></div>
        {canReport && <div className="build-report-box"><button type="button" className="danger-button compact-button" disabled={busy} onClick={() => setReportOpen((open) => !open)}>Game is not running</button>{reportOpen && <form onSubmit={async (event) => { event.preventDefault(); if (await onReportBuild(reportNote)) { setReportNote(""); setReportOpen(false); } }}><label><span>Optional note</span><textarea maxLength={500} value={reportNote} onChange={(event) => setReportNote(event.target.value)} placeholder="What happened when you tried to play?"/></label><div><button type="button" className="text-button" disabled={busy} onClick={() => setReportOpen(false)}>Cancel</button><button className="danger-button compact-button" disabled={busy}>Interrupt build</button></div></form>}</div>}
        {isOwnerAdmin && ["reviewing", "building", "testing"].includes(active.status) && <div className="build-cancel-box">{cancelOpen?<div role="alert"><strong>Cancel this build?</strong><p>The active agent run will stop, this feature will be deferred, and the next queued feature can continue.</p><div><button type="button" className="text-button" disabled={busy} onClick={()=>setCancelOpen(false)}>Keep building</button><button type="button" className="danger-button compact-button" disabled={busy} onClick={()=>{setCancelOpen(false);onDeferFeature();}}>Cancel current build</button></div></div>:<button type="button" className="danger-button compact-button build-cancel-trigger" disabled={busy} onClick={()=>setCancelOpen(true)}>Cancel current build</button>}</div>}
        {(round.phase === "failed" || build.status === "interrupted") && <div className="build-recovery-box"><h3>Build failed safely</h3><p>{build.failure ?? "The prior playable release is still available."}</p>{previousPlayable && <a className="text-button play-inline-link" href={previousPlayable} target="_blank" rel="noreferrer">Open prior playable game</a>}{project.isOrganiser && <div><button className="primary-button compact-button" disabled={busy} onClick={onStartBuild}>Retry build agent</button><button className="close-vote" disabled={busy} onClick={onDeferFeature}>Defer feature</button></div>}</div>}
      </aside>
    </div>
  </section>;
}

function BackgroundBuildSummary({ round, project, isOwnerAdmin, busy, onReportBuild, onStartBuild, onDeferFeature }: { round: RoundSnapshot; project: ProjectRoom; isOwnerAdmin: boolean; busy: boolean; onReportBuild: (note: string) => Promise<boolean> | boolean; onStartBuild: () => void; onDeferFeature: () => void }) {
  const build=round.build;
  if(!build)return null;
  const proposals=featureProposalsForRound(round);
  const features=(build.featureBuilds?.length?build.featureBuilds:fallbackFeatureBuilds(round)).slice().sort((a,b)=>a.queuePosition-b.queuePosition);
  const active=features.find((feature)=>feature.proposalId===build.activeFeatureProposalId)??features.find((feature)=>["reviewing","building","testing","failed","interrupted"].includes(feature.status))??features.find((feature)=>feature.status==="queued")??features.at(-1);
  const activeProposal=active?proposalForFeature(active,proposals):null;
  const complete=features.filter((feature)=>feature.status==="succeeded"||feature.status==="no_change").length;
  const failed=features.filter((feature)=>feature.status==="failed"||feature.status==="interrupted").length;
  const queued=features.filter((feature)=>["queued","reviewing","building","testing"].includes(feature.status)).length;
  const stableUrl=project.stablePlayUrl??[...features].reverse().find((feature)=>feature.releaseUrl)?.releaseUrl??build.previousStableUrl;
  return <details className="background-build-summary">
    <summary>
      <span><strong>ROUND {round.number} BUILD · {active?featureStatusLabel(active.status).toUpperCase():"UPDATE"}</strong><b>{activeProposal?.title??"Frozen feature queue"}</b></span>
      <span className="background-build-counts"><em>{complete} built</em><em>{failed} failed</em><em>{queued} queued</em></span>
      <small>{stableUrl?"The current playable release is safe. Future builds continue from it.":"A failed build will not replace the current playable game."}</small>
    </summary>
    <div className="background-build-drawer"><BuildQueueExperience round={round} project={project} isOwnerAdmin={isOwnerAdmin} busy={busy} onReportBuild={onReportBuild} onStartBuild={onStartBuild} onDeferFeature={onDeferFeature}/></div>
  </details>;
}

export const PROPOSAL_GENERATION_STATUS_LINES = [
  "Reviewing the team's wildest ideas with a straight face…",
  "Turning brilliant chaos into cards everyone can read…",
  "Checking every suggestion got an invite to the party…",
  "Giving the bold ideas a useful shape…",
  "Untangling the clever bits from the gloriously weird bits…",
  "Cooking up some interesting features for sure…",
  "Making room for the ideas that arrived sideways…",
  "Comparing notes, spotting overlaps, keeping the good stuff…",
  "Polishing rough thoughts without sanding off their personality…",
  "Asking the feature cards to form an orderly queue…",
  "Making sure no excellent suggestion fell behind the sofa…",
  "Translating team energy into buildable next moves…",
  "Finding the shared thread in a very colourful brainstorm…",
  "Giving each idea a fair hearing and a tidy name…",
  "Combining kindred ideas into something even better…",
  "Keeping the ambitious bits and adding sensible handrails…",
  "Lining up the team's next possible adventures…",
  "Almost certainly taking this brainstorm very seriously…",
] as const;

export const PROPOSAL_STATUS_ROTATION_MS = 10_000;

export function updateProposalVotes(current:string[],id:string,delta:1|-1,allowance:number):string[] {
  if(delta===1)return current.length<allowance?[...current,id]:current;
  const removeAt=current.lastIndexOf(id);
  return removeAt>=0?current.filter((_,index)=>index!==removeAt):current;
}

function ProposalGenerationSplash({ roundId }: { roundId: string }) {
  const [lineIndex,setLineIndex]=useState(0);
  useEffect(()=>{
    setLineIndex(0);
    const timer=window.setInterval(()=>setLineIndex((index)=>(index+1)%PROPOSAL_GENERATION_STATUS_LINES.length),PROPOSAL_STATUS_ROTATION_MS);
    return ()=>window.clearInterval(timer);
  },[roundId]);
  return <section className="proposal-generation-splash" aria-labelledby="proposal-generation-title">
    <div className="proposal-card-maker" aria-hidden="true"><span/><span/><span/><i/></div>
    <p className="eyebrow">LVL_UP IS ON IT</p>
    <h2 id="proposal-generation-title">Preparing your proposal cards</h2>
    <p className="proposal-generation-intro">This can take a little while. The cards will appear here as soon as they are ready.</p>
    <p className="proposal-generation-status" role="status" aria-live="polite" aria-atomic="true">{PROPOSAL_GENERATION_STATUS_LINES[lineIndex]}</p>
    <div className="proposal-generation-dots" aria-hidden="true"><span/><span/><span/></div>
  </section>;
}

export function ProjectRoomView({ project, draft, remaining, roundRemaining = 0, pending = [], idea = "", ideaAttachments = [], connection = "connecting", profileMap = {}, viewerNpub, isOwnerAdmin = viewerNpub === LEVELUP_ADMIN_NPUB, busy, status, proposalGenerationPending = false, onChoose, onClose, onResolve, onIdeaChange = () => undefined, onAddIdeaFiles = async () => undefined, onRemoveIdeaAttachment = () => undefined, onSubmitIdea = () => undefined, onRetryIdea = () => undefined, onDismissIdea = () => undefined, onCloseBrainstorm = () => undefined, onBeginVoting = () => undefined, onProposalVotes = () => undefined, onCloseProposalVoting = () => undefined, onStartBuild = () => undefined, onReportBuild = async () => false, onDeferFeature = () => undefined, onBrainstormMore = () => undefined }: { project: ProjectRoom; draft: string[]; remaining: number; roundRemaining?: number; pending?: RoundOutboxRecord[]; idea?: string; ideaAttachments?: RoundContributionAttachment[]; connection?: "connecting" | "live" | "offline"; profileMap?: Record<string, PublicProfile>; viewerNpub?: string; isOwnerAdmin?: boolean; busy: boolean; status: string; proposalGenerationPending?: boolean; onChoose: (id: string, replaceIndex?: number) => void; onClose: () => void; onResolve: (id: string) => void; onIdeaChange?: (value: string) => void; onAddIdeaFiles?: (files: File[]) => Promise<void>; onRemoveIdeaAttachment?: (id: string) => void; onSubmitIdea?: (event: React.FormEvent) => void; onRetryIdea?: (item: RoundOutboxRecord) => void; onDismissIdea?: (item: RoundOutboxRecord) => void; onCloseBrainstorm?: () => void; onBeginVoting?:()=>void; onProposalVotes?:(ids:string[])=>void; onCloseProposalVoting?:()=>void; onStartBuild?:(roundNumber?:number)=>void; onReportBuild?:(note:string,roundNumber?:number)=>Promise<boolean>|boolean; onDeferFeature?:(roundNumber?:number)=>void; onBrainstormMore?:()=>void }) {
  const [proposalDraft,setProposalDraft]=useState<string[]>(project.round?.selections??[]);
  function addIdeaFiles(files: FileList | File[]) { const images = Array.from(files).filter((file) => file.type.startsWith("image/")); if (!images.length) return; void onAddIdeaFiles(images); }

  useEffect(()=>setProposalDraft(project.round?.selections??[]),[project.round?.id,(project.round?.selections??[]).join("|")]);
  const [transitionNotice,setTransitionNotice]=useState("");
  const [versionRailMode,setVersionRailMode]=useState<"docked"|"collapsed"|"popped">(()=>typeof window!=="undefined"&&window.matchMedia?.("(max-width: 900px)").matches?"collapsed":"docked");
  const priorPhaseKey=useRef(project.round?`${project.round.number}:${project.round.phase}`:"");
  useEffect(()=>{
    if(!project.round)return;
    const key=`${project.round.number}:${project.round.phase}`;
    if(priorPhaseKey.current&&priorPhaseKey.current!==key){
      setTransitionNotice(`Round ${project.round.number} moved to ${phaseTitle(project.round.phase)}.`);
    }
    priorPhaseKey.current=key;
  },[project.round?.number,project.round?.phase]);
  if (project.phase === "round_1_brainstorm" && project.selectedTemplate && project.round) {
    const round = project.round; const deadline=round.phase==="voting"?round.votingDeadlineAt:round.deadlineAt;
    const playableUrl = round.build?.releaseUrl ?? project.stablePlayUrl ?? project.selectedTemplate.previewUrl;
    const changeProposalVotes=(id:string,delta:1|-1)=>{
      const next=updateProposalVotes(proposalDraft,id,delta,round.proposalVoteAllowance);
      if(next!==proposalDraft){setProposalDraft(next);onProposalVotes(next);}
    };
    const captainProfile=profileForNpub(project.captain?.npub,profileMap);const captainLabel=captainProfile?.displayName||friendlyName(project.captain?.npub,"another player");
    const isCaptain=project.captain?.npub===viewerNpub;
    const canStartIteration=project.isOrganiser||isCaptain||isOwnerAdmin;
    const proposalGenerating=round.phase==="brainstorm"&&(proposalGenerationPending||(busy&&status==="lvl_up is turning the brainstorm into checked requirement cards...")||round.proposalGeneration?.status==="running");
    const brainstormState = round.phase==="brainstorm"||Boolean(round.activeBuild) ? "in-progress" : round.build ? "available" : "waiting";
    const showRoundHero=round.phase!=="building"&&round.phase!=="playtest"&&round.phase!=="failed";
    const captainDuty=project.captain?.roundNumber===round.number?"This player opens voting for this round.":"This player can start the next brainstorm.";
    return <section className="round-room">{showRoundHero&&<header className="round-hero"><div><p className="eyebrow">ROUND {round.number} · {round.phase.replaceAll("_"," ").toUpperCase()}</p><h1>{project.name}</h1><p>{project.selectedTemplate.title} · <a href={playableUrl} target="_blank" rel="noreferrer">Open current playable game ↗</a></p>{project.captain?<><div className="round-player-identity is-captain"><Avatar profile={captainProfile} variant={avatarVariant(project.captain.npub)} className="round-identity-avatar"/><span><small>Round {project.captain.roundNumber}</small><strong>{isCaptain?"You":captainLabel}</strong></span><b className="round-captain-badge">ROUND CAPTAIN</b></div><p className="viewer-badge">{captainDuty} Pete can override.</p></>:<p className="viewer-badge">No eligible player is available as Round Captain. Pete can use the owner override.</p>}</div>{round.phase==="brainstorm"||round.phase==="voting"?<div className={`voxel-timer ${countdownState(roundRemaining)}`} role="timer" aria-label={`${roundRemaining} seconds remaining`}><small>{round.phase==="brainstorm"?"IDEA TIME":"VOTE TIME"}</small><strong>{formatCountdown(roundRemaining)}</strong></div>:<div className="phase-badge" aria-label={`Current phase ${round.phase}`}>{round.phase.replaceAll("_"," ").toUpperCase()}</div>}</header>}
      <RoundProgressRail round={round}/>
      {transitionNotice&&<aside className="phase-transition" role="status"><span>{transitionNotice}</span><button type="button" onClick={()=>setTransitionNotice("")} aria-label="Dismiss phase update">×</button></aside>}
      {round.phase!=="brainstorm"&&<section className="agent-stage-note" aria-live="polite"><strong>{phaseTitle(round.phase)}</strong><span>{agentStageMessage(round)}</span></section>}
      <div className={`round-workspace version-rail-${versionRailMode}`}>
      <main className="round-workflow">
      {round.activeBuild&&<BackgroundBuildSummary round={{...round,number:round.activeBuild.roundNumber,phase:round.activeBuild.build.status==="running"?"building":"failed",brief:round.activeBuild.brief,build:round.activeBuild.build,proposals:round.activeBuild.brief.selected,rankings:round.activeBuild.brief.selected,activeBuild:null}} project={project} isOwnerAdmin={isOwnerAdmin} busy={busy} onReportBuild={(note)=>onReportBuild(note,round.activeBuild!.roundNumber)} onStartBuild={()=>onStartBuild(round.activeBuild!.roundNumber)} onDeferFeature={()=>onDeferFeature(round.activeBuild!.roundNumber)}/>}
      {proposalGenerating&&<ProposalGenerationSplash roundId={round.id}/>}
      {!proposalGenerating&&<>
      {round.phase==="brainstorm"&&round.priorFeedback&&!round.summaryMessages?.length&&<section className="feedback-context"><p className="eyebrow">FROM ROUND {round.priorFeedback.roundNumber}</p><h2>Play notes for this brainstorm</h2><p>{[...round.priorFeedback.improve,...round.priorFeedback.nextIdeas].join(" · ")||"The previous play round closed without follow-up notes."}</p></section>}
      {(round.priorFeedback?.requirementBacklog?.length??0)>0&&<section className="requirement-backlog" aria-label="Requirement backlog"><div className="section-heading"><div><p className="eyebrow">BACKLOG FROM ROUND {round.priorFeedback?.roundNumber}</p><h2>Unbuilt requirement cards</h2></div><span>{round.priorFeedback?.requirementBacklog?.length} carried</span></div><ol>{round.priorFeedback?.requirementBacklog?.map((card)=><li key={card.proposalId}><span>#{card.sourceRank || "?"} · {card.status.toUpperCase()}</span><strong>{card.title}</strong><p>{card.playerChange}</p></li>)}</ol></section>}
      {round.summaryMessages?.length ? <section className="summary-history" aria-label="Conversation summaries"><ol className="conversation-list">{round.summaryMessages.map(message=><li key={message.id}><SummaryEntry message={message}/></li>)}</ol></section>:null}
      {round.phase==="brainstorm"&&<div className="round-layout">
        <section className="ideas-panel" aria-labelledby="ideas-title">
          <div className="section-heading"><div><p className="eyebrow">TEAM CONTRIBUTIONS</p><h2 id="ideas-title">Ideas in the room</h2></div><span className={`connection-state ${connection}`}>{connection==="live"?"LIVE":connection==="connecting"?"CONNECTING":"RECONNECTING"}</span></div>
          <ol className="conversation-list idea-list">
            {round.contributions.map((item)=><li key={item.id}><ConversationBubble authorNpub={item.authorNpub} author={item.authorKind==="bot"?{kind:"bot",id:"lvl_up",displayName:"lvl_up"}:undefined} profileMap={profileMap} variant="idea" status="sent" metadata={`#${item.sequence}`} message={item.body} attachments={item.attachments}/></li>)}
            {pending.filter((item)=>!round.contributions.some((x)=>x.clientEventId===item.clientEventId)).map((item)=><li key={item.clientEventId}><ConversationBubble authorNpub={viewerNpub} authorLabel="You" profileMap={profileMap} variant="idea" status={item.status} metadata="Local idea" message={item.body} attachments={item.attachments} error={item.error} actions={item.status==="failed"?<>{item.roundId===round.id&&<button type="button" onClick={()=>onRetryIdea(item)}>Retry</button>}<button type="button" onClick={()=>onDismissIdea(item)}>Dismiss</button></>:undefined}/></li>)}
          </ol>
          {!round.contributions.length&&!pending.length&&<p className="empty-ideas" role="status">{round.brainstormSeed?.status==="running"?"lvl_up is preparing two starter ideas…":round.brainstormSeed?.status==="failed"?`${round.brainstormSeed.error??"lvl_up could not prepare starter ideas."} Level Up will retry while this room stays open; you can also add an idea now.`:"lvl_up will add two starter ideas, or you can start with a theme, character, rule, goal, or playful twist."}</p>}
          <form className="idea-form" onSubmit={onSubmitIdea}>
            <label htmlFor="round-idea">Add an idea</label>
            {ideaAttachments.length>0&&<div className="idea-attachment-preview" aria-label="Attached screenshots">{ideaAttachments.map((attachment)=><figure key={attachment.id}><img src={attachment.dataUrl} alt={attachment.filename}/><figcaption>{attachment.filename}</figcaption><button type="button" aria-label={`Remove ${attachment.filename}`} onClick={()=>onRemoveIdeaAttachment(attachment.id)}>×</button></figure>)}</div>}
            <div className="idea-composer-row">
              <label className="paperclip-button" title="Attach screenshots" aria-label="Attach screenshots"><span className="paperclip-label">Attach</span>
                <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={(event)=>{addIdeaFiles(event.currentTarget.files??[]);event.currentTarget.value="";}}/>
                <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M8.5 12.5 14 7a3.2 3.2 0 0 1 4.5 4.5l-7.2 7.2a5 5 0 0 1-7.1-7.1l8.1-8.1" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </label>
              <textarea id="round-idea" maxLength={500} rows={3} value={idea} onPaste={(event)=>{if(event.clipboardData.files.length){addIdeaFiles(event.clipboardData.files);event.preventDefault();}}} onChange={(event)=>onIdeaChange(event.target.value)} onKeyDown={(event)=>{if(shouldSubmitIdeaFromKey({...event,isComposing:event.nativeEvent.isComposing})){event.preventDefault();event.currentTarget.form?.requestSubmit();}}} placeholder="What should your team change or add?"/>
              <button className="primary-button compact-button" disabled={busy||(!idea.trim()&&!ideaAttachments.length)}>Send idea <span>→</span></button>
            </div>
          </form>
        </section>
        <aside className="round-sidebar"><TemplateVisual kind={project.selectedTemplate.visual}/><h2>{project.selectedTemplate.title}</h2><p>{round.proposalGeneration?.status==="running"?"The deadline has closed. lvl_up is reconciling every idea and carried card now.":"lvl_up reviews the room every 30 seconds. At the server deadline it automatically reconciles ideas and carried work into proposals."}</p>{round.proposalGeneration?.status==="failed"&&<div className="build-recovery-box" role="alert"><h3>Proposal agent needs another try</h3><p>{round.proposalGeneration.error??"Your ideas and backlog are safe."}</p></div>}{project.isOrganiser?<button type="button" className="close-vote" disabled={busy||round.proposalGeneration?.status==="running"} onClick={onCloseBrainstorm}>{round.proposalGeneration?.status==="failed"?"Retry proposal agent":"Close early and generate proposals"}</button>:<p className="waiting-state">{round.proposalGeneration?.status==="failed"?"Your ideas are safe. Waiting for the organiser to retry the proposal agent.":"This brainstorm closes automatically at the server deadline."}</p>}</aside>
      </div>}
      </>}
      {(round.phase==="proposals"||round.phase==="voting")&&<section className="loop-panel"><div className="section-heading"><div><p className="eyebrow">{(round.priorFeedback?.requirementBacklog?.length??0)>0?"NEW IDEAS + CARRIED BACKLOG":"SYNTHESISED FROM TEAM IDEAS"}</p><h2>{round.phase==="proposals"?"Review requirement cards":`Spend your ${round.proposalVoteAllowance} votes`}</h2></div><span>{round.phase==="voting"?`${proposalDraft.length}/${round.proposalVoteAllowance} vote tokens saved`:"READY FOR VOTE"}</span></div><div className="proposal-grid">{round.proposals.map((proposal)=>{const voteCount=proposalDraft.filter((id)=>id===proposal.id).length;const selected=voteCount>0;const traces=[...ideaTrace(proposal,round.contributions),...backlogTrace(proposal,round.priorFeedback?.requirementBacklog??[])];return <article className={selected?"proposal-card selected":"proposal-card"} key={proposal.id}><span>{selected?`${voteCount} ${voteCount===1?"VOTE":"VOTES"}`:`OPTION ${proposal.position}`}</span><h3>{proposal.title}</h3><section className="proposal-detail"><h4>Player change</h4><p>{proposal.playerChange}</p></section><section className="proposal-detail"><h4>Implementation scope</h4><p>{proposal.implementationScope}</p></section><section className="proposal-detail"><h4>Acceptance criteria</h4><ul>{proposal.acceptanceCriteria.map((criterion)=><li key={criterion}>{criterion}</li>)}</ul></section><section className="proposal-ideas"><b>Reflected sources</b>{traces.length?<ul>{traces.map((trace)=><li key={trace}>{trace}</li>)}</ul>:<span>Previous play notes</span>}</section>{round.phase==="voting"&&<div className="vote-token-controls" aria-label={`${proposal.title} vote tokens`}><button type="button" disabled={busy||voteCount===0} onClick={()=>changeProposalVotes(proposal.id,-1)} aria-label={`Remove vote from ${proposal.title}`}>−</button><strong>{voteCount}</strong><span>{voteCount===1?"vote":"votes"}</span><button type="button" disabled={busy||proposalDraft.length>=round.proposalVoteAllowance} onClick={()=>changeProposalVotes(proposal.id,1)} aria-label={`Add vote to ${proposal.title}`}>+</button></div>}</article>;})}</div>{round.phase==="proposals"?(isCaptain||isOwnerAdmin?<button className="primary-button compact-button" disabled={busy} onClick={onBeginVoting}>Open voting →</button>:<p className="waiting-state">Review the choices. Waiting for {project.captain?`${captainLabel}, this round’s captain, to open voting`:"the owner to open voting because no player captain is available"}.</p>):project.isOrganiser?<button className="close-vote" disabled={busy} onClick={onCloseProposalVoting}>Finish prioritising and start Build</button>:<p className="waiting-state">Your vote tokens are private. Waiting for the organiser or deadline.</p>}</section>}
      {round.phase==="brief"&&round.brief&&<section className="loop-panel brief-panel"><p className="eyebrow">BUILD STARTING</p><h2>Priorities are frozen</h2><p>The team’s prioritised requirement queue is moving directly into Build.</p><div className="brief-grid">{round.brief.selected.map((item,index)=><article key={item.id} className={index===0?"committed":""}><span>#{index+1} · {item.votes} vote {item.votes===1?"token":"tokens"}</span><h3>{item.title}</h3><p>{item.playerChange}</p></article>)}</div><p className="waiting-state">Waiting for the Build update…</p></section>}
      {round.phase==="building"&&round.build&&<BuildQueueExperience round={round} project={project} isOwnerAdmin={isOwnerAdmin} busy={busy} onReportBuild={onReportBuild} onStartBuild={()=>onStartBuild()} onDeferFeature={()=>onDeferFeature()} onBrainstormMore={onBrainstormMore}/>}
      {round.phase==="playtest"&&round.build?.validated&&<BuildQueueExperience round={round} project={project} isOwnerAdmin={isOwnerAdmin} busy={busy} onReportBuild={onReportBuild} onStartBuild={onStartBuild} onDeferFeature={onDeferFeature} onBrainstormMore={onBrainstormMore}/>}
      {round.phase==="failed"&&round.build&&<BuildQueueExperience round={round} project={project} isOwnerAdmin={isOwnerAdmin} busy={busy} onReportBuild={onReportBuild} onStartBuild={()=>onStartBuild()} onDeferFeature={()=>onDeferFeature()} onBrainstormMore={onBrainstormMore}/>}
      </main>
      {versionRailMode==="collapsed"?<aside className="project-utility-rail-collapsed" aria-label="Game Versions collapsed"><button type="button" aria-label="Expand Game Versions" title="Expand Game Versions" onClick={()=>setVersionRailMode("docked")}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="square"/></svg><span>Game Versions</span></button></aside>:<aside className="project-utility-rail" aria-label="Games and brainstorm"><div className="utility-rail-controls"><strong>PLAY &amp; IDEATE</strong><button type="button" onClick={()=>setVersionRailMode(versionRailMode==="popped"?"docked":"popped")}>{versionRailMode==="popped"?"Dock":"Pop out"}</button><button type="button" aria-label="Collapse Game Versions" onClick={()=>setVersionRailMode("collapsed")}>Collapse</button></div><PlayableVersions versions={round.versionHistory??[]} project={project} brainstormState={brainstormState} busy={busy} canBrainstorm={canStartIteration} onBrainstormMore={onBrainstormMore}/></aside>}
      </div>
      <p className="status" role="status" aria-live="polite">{status}</p></section>;
  }
  const selectionActive=project.selectionStartedAt>0;
  const selectionCaptainProfile=profileForNpub(project.captain?.npub,profileMap);
  const selectionCaptainLabel=selectionCaptainProfile?.displayName||friendlyName(project.captain?.npub,"another player");
  const canResolveTie=project.captain?.npub===viewerNpub||isOwnerAdmin;
  const maxVotes = Math.max(1, ...project.topThree.map((template) => template.votes ?? 0));
  return <><section className="project-hero"><div><p className="eyebrow">{project.teamName} · {selectionActive?"TEMPLATE VOTE":"TRY THE GAMES"}</p><h1>{project.name}</h1><p>{selectionActive?"Choose exactly two starting worlds. Your picks stay editable until the server closes voting.":"Try the games, soon you’ll have to select one to build on and make better."}</p></div>{selectionActive&&<div className={`voxel-timer ${countdownState(remaining)}`} role="timer" aria-live="off" aria-label={`${remaining} seconds remaining`}><small>TIME LEFT</small><strong>{formatCountdown(remaining)}</strong></div>}</section>
    {selectionActive&&<section className="ranking-panel" aria-labelledby="ranking-title"><div className="section-heading"><h2 id="ranking-title">Live top three</h2><span>SERVER-AUTHORITATIVE</span></div><ol>{project.topThree.map((template, index) => <li key={template.id}><b>{index + 1}</b><span><strong>{template.title}</strong><i style={{ width: `${Math.max(4, ((template.votes ?? 0) / maxVotes) * 100)}%` }} /></span><em>{template.votes ?? 0}</em></li>)}</ol></section>}
    {project.phase === "resolving_template_tie" ? <section className="tie-panel"><p className="eyebrow">FIRST PLACE TIE</p><h2>{canResolveTie ? "Make the final call" : "Waiting for the Round Captain"}</h2><p>{canResolveTie ? isOwnerAdmin?"Use the owner override to choose one of the tied leaders. This decision is final.":"As Round Captain, choose one of the tied leaders. This decision is final." : project.captain?`Voting is closed. ${selectionCaptainLabel}, the Round Captain, will choose from the tied leaders.`:"Voting is closed. No player captain is available, so the owner can choose from the tied leaders."}</p><div>{project.templates.filter((template) => project.tiedLeaderIds.includes(template.id)).map((template) => <button key={template.id} type="button" disabled={busy || !canResolveTie} onClick={() => onResolve(template.id)}>{template.title}</button>)}</div></section> : <>
      <section className="template-heading"><div><p className="eyebrow">CURATED FROM LEVEL UP GAMES</p><h2>{selectionActive ? "Pick your two" : "Try every game"}</h2></div>{selectionActive && <span>{draft.length}/2 selected</span>}</section>
      <div className="template-grid">{project.templates.map((template) => {
        const selectedIndex = draft.indexOf(template.id);
        return <article className={`template-card ${selectedIndex >= 0 ? "selected" : ""}`} key={template.id}><TemplateVisual kind={template.visual} /><div className="template-copy"><h3>{template.title}</h3><p>{template.description}</p><small>REMIX: {template.themePrompts.join(" · ")}</small></div><div className={`template-actions ${selectionActive && draft.length === 2 && selectedIndex < 0 ? "swap-actions" : ""}`}><a href={template.previewUrl} target="_blank" rel="noreferrer">Play preview ↗</a>{selectionActive && (draft.length === 2 && selectedIndex < 0 ? <><button type="button" disabled={busy || remaining === 0} onClick={() => onChoose(template.id, 0)}>Replace #1</button><button type="button" disabled={busy || remaining === 0} onClick={() => onChoose(template.id, 1)}>Replace #2</button></> : <button type="button" disabled={busy || remaining === 0 || selectedIndex >= 0} aria-pressed={selectedIndex >= 0} onClick={() => onChoose(template.id)}>{selectedIndex >= 0 ? `Favourite ${selectedIndex + 1}` : "Choose"}</button>)}</div></article>;
      })}</div>
      {!selectionActive ? project.isOrganiser ? <div className="template-voting-action"><button className="primary-button" type="button" disabled={busy} onClick={onClose}>Start Voting</button></div> : <p className="waiting-state template-voting-wait">The organiser will start voting when everyone has had a chance to play.</p> : project.isOrganiser && <button className="close-vote" type="button" disabled={busy || remaining === 0} onClick={onClose}>Close voting early</button>}
    </>}
    <p className="status" role="status" aria-live="polite">{selectionActive && remaining === 0 && project.phase === "selecting_template" ? "Time is up. Confirming the result with the server…" : status}</p></>;
}

export function App() {
  const [user, setUser] = useState<User | null>(null); const [team, setTeam] = useState<Team | null>(null); const [invite, setInvite] = useState<Invite | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [project, setProject] = useState<ProjectRoom | null>(null); const [projectDraft, setProjectDraft] = useState<string[]>([]); const [projectName, setProjectName] = useState("");
  const [roundIdea, setRoundIdea] = useState(""); const [roundIdeaAttachments, setRoundIdeaAttachments] = useState<RoundContributionAttachment[]>([]); const [roundOutbox, setRoundOutbox] = useState<RoundOutboxRecord[]>([]); const [roundConnection, setRoundConnection] = useState<"connecting" | "live" | "offline">("connecting");
  const selectionGate = useRef(createSelectionRequestGate(selectionContextFromPath(window.location.pathname)));
  const roundSocket = useRef<WebSocket | null>(null); const roundSequence = useRef(0); const roundOutboxRef = useRef<RoundOutboxRecord[]>([]); const roundAckTimers = useRef(new Map<string,number>());
  const proposalVotesSaving = useRef(false); const queuedProposalVotes = useRef<string[] | null>(null);
  const proposalGenerationStartingRef = useRef(false);
  const [clockSyncedAt, setClockSyncedAt] = useState(Date.now()); const [clockTick, setClockTick] = useState(Date.now());
  const [pendingInvite, setPendingInvite] = useState(() => pendingInviteFromLocation(window.location)); const [checking, setChecking] = useState(true); const [busy, setBusy] = useState(false);
  const [teamName, setTeamName] = useState(""); const [joinInput, setJoinInput] = useState(() => pendingInviteFromLocation(window.location) ?? "");
  const [status, setStatus] = useState("Create a player account on this browser, or sign in with Nostr if you already use it."); const [loginMode, setLoginMode] = useState<LoginMode>("choices");
  const [devicePubkey, setDevicePubkey] = useState<string | null>(null); const [displayName, setDisplayName] = useState(() => generatedNickname(crypto.randomUUID())); const [about, setAbout] = useState("");
  const [passphrase, setPassphrase] = useState(""); const [profileMap, setProfileMap] = useState<Record<string, PublicProfile>>({}); const [editingProfile, setEditingProfile] = useState(false);
  const [managingGames, setManagingGames] = useState(false); const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null); const [deleteCandidate, setDeleteCandidate] = useState<ProjectDeletionTarget | null>(null); const [forgetDeviceOpen, setForgetDeviceOpen] = useState(false);
  const [adminMode, setAdminMode] = useState(() => window.location.pathname === "/admin"); const [adminTab, setAdminTab] = useState<AdminTab>("monitoring"); const [adminPrompts, setAdminPrompts] = useState<AgentPromptRecord[]>([]); const [selectedPromptId, setSelectedPromptId] = useState<AgentPromptStageId | null>(null); const [promptDraft, setPromptDraft] = useState(""); const [adminSettings, setAdminSettings] = useState<AdminSettingsRecord | null>(null); const [settingsDraft, setSettingsDraft] = useState("30"); const [turnsDraft, setTurnsDraft] = useState("3"); const [votesDraft, setVotesDraft] = useState("5"); const [modelsDraft, setModelsDraft] = useState(""); const [defaultModelDraft, setDefaultModelDraft] = useState(""); const [adminProjects, setAdminProjects] = useState<AdminProjectSummary[]>([]); const [adminTeams, setAdminTeams] = useState<AdminTeamSummary[]>([]); const [adminRuns, setAdminRuns] = useState<AgentRunTrace[]>([]); const [selectedAdminProjectId, setSelectedAdminProjectId] = useState(""); const [selectedAdminRunId, setSelectedAdminRunId] = useState(""); const [adminDeleteTarget,setAdminDeleteTarget]=useState<AdminDeletionTarget|null>(null);
  const userPubkey = useMemo(() => user ? pubkeyFromNpub(user.npub) : null, [user]);
  const memberNpubs = team?.members.map((member) => member.npub).join("|") ?? "";
  const serverProfiles = project?.profiles ?? team?.profiles ?? [];
  const currentProfile = userPubkey ? profileMap[userPubkey] ?? { ...profileFromEvent(userPubkey), displayName:generatedNickname(userPubkey) } : undefined;
  const canUseAdmin = user?.npub === LEVELUP_ADMIN_NPUB;

  function rememberTeam(nextTeam: Team) {
    setTeams((existing) => mergeTeamLists([nextTeam], existing));
  }

  async function refreshTeams(): Promise<Team[]> {
    const result = await api<{ teams: Team[] }>("/api/teams");
    const refreshed = normalizeTeamListPayload(result);
    setTeams((remembered) => mergeTeamLists(refreshed, remembered));
    return refreshed;
  }

  async function restoreAuthenticatedRoute(): Promise<void> {
    const routed = selectionContextFromPath(window.location.pathname);
    const teamsPromise = refreshTeams();
    if (routed.kind === "admin") {
      await Promise.all([teamsPromise, openAdminMode(false)]);
      return;
    }
    if (routed.kind === "project") {
      const [refreshed, room] = await Promise.all([teamsPromise, loadProject(routed.id)]);
      setTeam((current) => current?.id === room.teamId ? current : refreshed.find((candidate) => candidate.id === room.teamId) ?? null);
      return;
    }
    if (routed.kind === "team") {
      await Promise.all([teamsPromise, loadTeam(routed.id)]);
      return;
    }
    if (pendingInvite) {
      await Promise.all([teamsPromise, redeem(pendingInvite)]);
      return;
    }
    await teamsPromise;
    selectionGate.current.select({ kind: "root" });
    setTeam(null);
    setStatus("Signed in. Choose your team.");
  }

  async function loadAdminPrompts(): Promise<AgentPromptRecord[]> {
    const result = await api<{ prompts: AgentPromptRecord[] }>("/api/admin/agent-prompts");
    const prompts = normalizeAdminPromptsPayload(result);
    setAdminPrompts(prompts);
    const nextSelected = selectedPromptId && prompts.some((prompt) => prompt.id === selectedPromptId) ? selectedPromptId : prompts[0]?.id ?? null;
    setSelectedPromptId(nextSelected);
    setPromptDraft(prompts.find((prompt) => prompt.id === nextSelected)?.template ?? "");
    return prompts;
  }

  async function loadAdminSettings(): Promise<AdminSettingsRecord> {
    const result = await api<{ settings: AdminSettingsRecord }>("/api/admin/settings");
    const settings = normalizeAdminSettings(result.settings);
    setAdminSettings(settings);
    setSettingsDraft(String(settings.brainstormSuggestionIntervalSeconds));
    setTurnsDraft(String(settings.agentMaxTurns));
    setVotesDraft(String(settings.proposalVoteAllowance));
    setModelsDraft(settings.allowedModels.join("\n"));
    setDefaultModelDraft(settings.defaultModel);
    return settings;
  }

  async function loadAdminProjects(): Promise<AdminProjectSummary[]> {
    const result = await api<{ projects: AdminProjectSummary[] }>("/api/admin/projects");
    const projects = normalizeAdminProjectsPayload(result);
    setAdminProjects(projects);
    setSelectedAdminProjectId((current) => current && projects.some((project) => project.id === current) ? current : projects[0]?.id ?? "");
    return projects;
  }

  async function loadAdminTeams(): Promise<AdminTeamSummary[]> {
    const result=await api<{teams:AdminTeamSummary[]}>("/api/admin/teams");const next=normalizeAdminTeamsPayload(result);setAdminTeams(next);return next;
  }

  async function loadAdminRuns(projectId = selectedAdminProjectId): Promise<AgentRunTrace[]> {
    const path = projectId ? `/api/admin/agent-runs?projectId=${encodeURIComponent(projectId)}` : "/api/admin/agent-runs";
    const result = await api<{ runs: AgentRunTrace[] }>(path);
    const runs = normalizeAgentRunsPayload(result);
    setAdminRuns(runs);
    setSelectedAdminRunId((current) => current && runs.some((run) => run.id === current) ? current : runs[0]?.id ?? "");
    return runs;
  }

  function selectAdminProject(id: string) {
    setSelectedAdminProjectId(id);
    setSelectedAdminRunId("");
    void loadAdminRuns(id).catch((error) => setStatus(error instanceof Error ? error.message : "Could not load agent runs."));
  }

  function selectPrompt(id: AgentPromptStageId) {
    const prompt = adminPrompts.find((item) => item.id === id);
    setSelectedPromptId(id);
    setPromptDraft(prompt?.template ?? "");
  }

  async function openAdminMode(navigate = true) {
    setEditingProfile(false); setManagingGames(false); setDeleteCandidate(null); setProject(null); setAdminMode(true); setAdminTab("monitoring");
    if (navigate && window.location.pathname !== "/admin") window.history.pushState({}, "", "/admin");
    selectionGate.current.select({ kind: "admin" });
    setStatus("Loading owner prompt controls...");
    setBusy(true);
    try { const [prompts, , projects] = await Promise.all([loadAdminPrompts(), loadAdminSettings(), loadAdminProjects(), loadAdminTeams()]); await loadAdminRuns(projects[0]?.id ?? ""); setStatus(prompts.length ? "Admin mode ready." : "No prompt stages are registered."); }
    catch (error) { setStatus(error instanceof Error ? error.message : "Could not open Admin mode."); }
    finally { setBusy(false); }
  }

  async function saveAdminLoopSettings() {
    setBusy(true);
    try {
      const result = await api<{ settings: AdminSettingsRecord }>("/api/admin/settings", { method: "PUT", body: JSON.stringify({ brainstormSuggestionIntervalSeconds: Number(settingsDraft), agentMaxTurns: Number(turnsDraft), proposalVoteAllowance: Number(votesDraft) }) });
      const settings = normalizeAdminSettings(result.settings);
      setAdminSettings(settings); setSettingsDraft(String(settings.brainstormSuggestionIntervalSeconds)); setTurnsDraft(String(settings.agentMaxTurns)); setVotesDraft(String(settings.proposalVoteAllowance));
      setStatus(`Saved ${settings.proposalVoteAllowance} proposal votes per player, ${settings.brainstormSuggestionIntervalSeconds}-second lvl_up checks, and up to ${settings.agentMaxTurns} Goose turns.`);
    } catch (error) { setStatus(error instanceof Error ? error.message : "Could not save that loop setting."); }
    finally { setBusy(false); }
  }

  async function saveSelectedPrompt(reset = false) {
    if (!selectedPromptId) return;
    setBusy(true);
    try {
      const result = await api<{ prompt: AgentPromptRecord }>("/api/admin/agent-prompts", { method: "PUT", body: JSON.stringify(reset ? { stageId: selectedPromptId, reset: true } : { stageId: selectedPromptId, template: promptDraft }) });
      const saved = normalizeAdminPrompt(result.prompt);
      setAdminPrompts((items) => items.map((item) => item.id === saved.id ? saved : item));
      setSelectedPromptId(saved.id); setPromptDraft(saved.template);
      setStatus(reset ? `${saved.label} is back on the compiled default.` : `${saved.label} prompt saved.`);
    } catch (error) { setStatus(error instanceof Error ? error.message : "Could not save that prompt."); }
    finally { setBusy(false); }
  }

  async function saveAdminModels() {
    setBusy(true);
    try {
      const allowedModels = modelsDraft.split(/\r?\n/).map((model) => model.trim()).filter(Boolean);
      const result = await api<{ settings: AdminSettingsRecord }>("/api/admin/settings", { method: "PUT", body: JSON.stringify({ allowedModels, defaultModel: defaultModelDraft }) });
      const settings = normalizeAdminSettings(result.settings);
      setAdminSettings(settings); setModelsDraft(settings.allowedModels.join("\n")); setDefaultModelDraft(settings.defaultModel);
      setAdminPrompts((items) => items.map((item) => ({ ...item, effectiveModel: item.model ?? settings.defaultModel })));
      setStatus(`Default model saved as ${settings.defaultModel}.`);
    } catch (error) { setStatus(error instanceof Error ? error.message : "Could not save model settings."); }
    finally { setBusy(false); }
  }

  async function saveSelectedPromptModel(stageId: AgentPromptStageId, model: string | null) {
    setBusy(true);
    try {
      const result = await api<{ prompt: AgentPromptRecord }>("/api/admin/agent-prompts", { method: "PUT", body: JSON.stringify({ stageId, modelMode: model ? "specific" : "default", model }) });
      const saved = normalizeAdminPrompt(result.prompt);
      setAdminPrompts((items) => items.map((item) => item.id === saved.id ? saved : item));
      setStatus(`${saved.label} will use ${saved.model ? saved.effectiveModel : "the default model"} on its next run.`);
    } catch (error) { setStatus(error instanceof Error ? error.message : "Could not save that prompt model."); }
    finally { setBusy(false); }
  }

  async function confirmAdminDeletion() {
    if(!adminDeleteTarget||busy)return;const target=adminDeleteTarget;setBusy(true);
    try{await api(`/api/admin/${target.kind==="team"?"teams":"projects"}/${encodeURIComponent(target.id)}`,{method:"DELETE"});setAdminDeleteTarget(null);const [projects]=await Promise.all([loadAdminProjects(),loadAdminTeams()]);await loadAdminRuns(projects[0]?.id??"");setStatus(`Deleted ${target.kind} ${target.name}.`);}
    catch(error){setStatus(error instanceof Error?error.message:`Could not delete that ${target.kind}.`);}finally{setBusy(false);}
  }

  function acceptProject(next: ProjectRoom, preservePendingDraft = false) {
    const normalized = normalizeProjectRoom(next);
    if (selectionGate.current.current() !== selectionContextKey({ kind: "project", id: normalized.id })) return;
    setProject(normalized); roundSequence.current = normalized.round?.lastSequence ?? 0; setProjectDraft((current) => preservePendingDraft && normalized.phase === "selecting_template" && normalized.selections.length === 0 && current.length === 1 ? current : normalized.selections); setClockSyncedAt(Date.now()); setClockTick(Date.now());
  }

  function acceptRound(round: RoundSnapshot) {
    const normalized = normalizeRoundSnapshot(round);
    if (selectionGate.current.current() !== selectionContextKey({ kind: "project", id: normalized.projectId })) return;
    if(normalized.phase==="brainstorm"&&normalized.number!==project?.round?.number&&normalized.summaryMessages?.length)setStatus("Next brainstorm is open with prior play notes.");
    roundSequence.current = normalized.lastSequence;
    setProject((current) => current && current.id === normalized.projectId ? { ...current, round: normalized } : current);
    const committed = new Set(normalized.contributions.map((item) => item.clientEventId));
    for (const clientEventId of committed) clearAckTimer(clientEventId);
    const nextOutbox=roundOutboxRef.current.filter((item)=>!committed.has(item.clientEventId));roundOutboxRef.current=nextOutbox;setRoundOutbox(nextOutbox);
    if (browserPersistenceAvailable() && committed.size) void clientDb().roundOutbox.bulkDelete([...committed]).catch(() => undefined);
    setClockSyncedAt(Date.now()); setClockTick(Date.now());
  }

  function rememberOutbox(record: RoundOutboxRecord) {
    const next=[...roundOutboxRef.current.filter((item)=>item.clientEventId!==record.clientEventId),record].sort((a,b)=>a.createdAt-b.createdAt);roundOutboxRef.current=next;setRoundOutbox(next);
    if (browserPersistenceAvailable()) void clientDb().roundOutbox.put(record).catch(() => undefined);
  }

  function clearAckTimer(clientEventId:string) { const timer=roundAckTimers.current.get(clientEventId);if(timer!==undefined)window.clearTimeout(timer);roundAckTimers.current.delete(clientEventId); }
  function sendOutbox(record:RoundOutboxRecord,socket=roundSocket.current) {
    if (!project?.round || record.roundId!==project.round.id || record.roundNumber!==project.round.number || socket?.readyState!==WebSocket.OPEN) return;
    clearAckTimer(record.clientEventId);
    socket.send(JSON.stringify({type:"contribution.submit",clientEventId:record.clientEventId,body:record.body,attachments:record.attachments}));
    const timer=window.setTimeout(()=>{roundAckTimers.current.delete(record.clientEventId);const current=roundOutboxRef.current.find((item)=>item.clientEventId===record.clientEventId);if(current?.status==="pending"){rememberOutbox({...current,error:"No server acknowledgement yet. Reconnecting and retrying safely…"});setStatus("The room did not acknowledge that idea. Reconnecting and retrying…");roundSocket.current?.close();}},8000);
    roundAckTimers.current.set(record.clientEventId,timer);
  }
  function retryRoundIdea(record:RoundOutboxRecord){const pending={...record,status:"pending" as const,error:undefined};rememberOutbox(pending);sendOutbox(pending);}
  function dismissRoundIdea(record:RoundOutboxRecord){clearAckTimer(record.clientEventId);const next=roundOutboxRef.current.filter((item)=>item.clientEventId!==record.clientEventId);roundOutboxRef.current=next;setRoundOutbox(next);if(browserPersistenceAvailable())void clientDb().roundOutbox.delete(record.clientEventId).catch(()=>undefined);}

  useEffect(()=>{const recover=()=>{activeSigner=null;vault.lock();roundSocket.current?.close();setUser(null);setTeam(null);setTeams([]);setProject(null);setInvite(null);setAdminMode(false);setAdminTab("monitoring");setAdminPrompts([]);setSelectedPromptId(null);setPromptDraft("");setAdminSettings(null);setSettingsDraft("30");setTurnsDraft("3");setAdminProjects([]);setAdminTeams([]);setAdminRuns([]);setSelectedAdminProjectId("");setSelectedAdminRunId("");setAdminDeleteTarget(null);setEditingProfile(false);setManagingGames(false);setDeleteCandidate(null);setForgetDeviceOpen(false);setDeletingProjectId(null);setLoginMode("choices");setChecking(false);setStatus("Your session expired after the app restarted or timed out. Sign in again to continue.");};window.addEventListener("levelup:unauthenticated",recover);return()=>window.removeEventListener("levelup:unauthenticated",recover);},[devicePubkey]);

  async function loadProject(projectId: string, navigate = false, preservePendingDraft = false): Promise<ProjectRoom> {
    const context: SelectionContext = { kind: "project", id: projectId };
    if (navigate && window.location.pathname !== `/projects/${encodeURIComponent(projectId)}`) window.history.pushState({}, "", `/projects/${encodeURIComponent(projectId)}`);
    const request = navigate ? selectionGate.current.select(context) : selectionGate.current.refresh(context);
    if (request === null) throw new Error("That project is no longer selected.");
    const result = await api<{ project: ProjectRoom }>(`/api/projects/${encodeURIComponent(projectId)}`);
    if (!selectionGate.current.accepts(context, request) || selectionContextKey(selectionContextFromPath(window.location.pathname)) !== selectionContextKey(context)) return result.project;
    setAdminMode(false);
    acceptProject(result.project, preservePendingDraft);
    setTeam((current) => current?.id === result.project.teamId ? current : teams.find((candidate) => candidate.id === result.project.teamId) ?? null);
    return result.project;
  }

  async function redeem(secret: string): Promise<Team> {
    const result = await api<{ team: Team; alreadyMember: boolean }>("/api/team-invites/redeem", { method: "POST", body: JSON.stringify({ secret }) });
    const nextTeam = normalizeTeam(result.team);
    selectionGate.current.select({ kind: "team", id: nextTeam.id });
    window.history.replaceState({}, "", `/teams/${encodeURIComponent(nextTeam.id)}`);
    setTeam(nextTeam); rememberTeam(nextTeam); setInvite(null); setPendingInvite(null); setJoinInput(""); setStatus(result.alreadyMember ? "Welcome back to your team." : `You joined ${nextTeam.name}.`); return nextTeam;
  }

  useEffect(() => {
    let active = true;
    vault.record().then((record) => { if (active) setDevicePubkey(record?.pubkey ?? null); }).catch(() => undefined);
    api<{ user: User; team: Team | null }>("/api/me").then(async (result) => { if (!active) return; const nextTeam = result.team ? normalizeTeam(result.team) : null; setUser(result.user); if (nextTeam) rememberTeam(nextTeam); await restoreAuthenticatedRoute(); }).catch(async (error) => { if (!active) return; try { const pubkey = await vault.autoUnlock(); setDevicePubkey(pubkey); await completeLogin(new DeviceSigner(vault)); setStatus(pendingInvite ? "Player recovered. Joining your team…" : "Welcome back. This device player unlocked automatically."); } catch { setStatus(error instanceof Error ? error.message : "Level Up could not open that room."); } }).finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const pubkeys = new Set<string>(); if (userPubkey) pubkeys.add(userPubkey);
    for (const member of team?.members ?? []) try { pubkeys.add(pubkeyFromNpub(member.npub)); } catch { /* safe fallback */ }
    let active = true;
    const serverByPubkey=new Map(serverProfiles.map((profile)=>[profile.pubkey,profile]));
    if(serverProfiles.length)setProfileMap((map)=>({...map,...Object.fromEntries(serverProfiles.map((profile)=>[profile.pubkey,profile]))}));
    for (const pubkey of pubkeys) {
      const shared=serverByPubkey.get(pubkey);
      if(!shared)profiles.cached(pubkey).then((profile) => { if (active && profile) setProfileMap((map) => ({ ...map, [pubkey]: profile })); });
      if(!shared?.fetchedAt||Date.now()-shared.fetchedAt>=PROFILE_STALE_MS)profiles.refresh(pubkey).then((profile) => {
        if (active) setProfileMap((map) => ({ ...map, [pubkey]: profile }));
        if(profile.event)void api("/api/profiles",{method:"PUT",body:JSON.stringify({events:[profile.event]})}).catch(()=>undefined);
      }).catch(() => undefined);
    }
    return () => { active = false; };
  }, [userPubkey, memberNpubs, team?.profiles, project?.profiles]);

  useEffect(() => { if (!team || selectionGate.current.current() !== selectionContextKey({ kind: "team", id: team.id })) return; const timer = window.setInterval(() => { void loadTeam(team.id).catch(() => undefined); }, 5000); return () => window.clearInterval(timer); }, [team?.id]);

  useEffect(() => {
    if (!project || project.phase === "round_1_brainstorm") return;
    const refresh = window.setInterval(() => loadProject(project.id, false, true).catch(() => undefined), 2000);
    return () => window.clearInterval(refresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, project?.phase]);

  useEffect(() => {
    if (!project || (project.phase !== "selecting_template" && project.round?.phase !== "brainstorm" && project.round?.phase !== "voting")) return;
    const tick = window.setInterval(() => setClockTick(Date.now()), 250);
    return () => window.clearInterval(tick);
  }, [project?.id, project?.phase, project?.round?.phase]);

  useEffect(() => {
    if (!project?.round || project.phase !== "round_1_brainstorm") { roundSocket.current?.close(); roundSocket.current = null; return; }
    let active = true; let reconnect: number | undefined;
    roundOutboxRef.current = []; setRoundOutbox([]);
    const alreadyCommitted = new Set(project.round.contributions.map((item) => item.clientEventId));
    if (browserPersistenceAvailable()) void clientDb().roundOutbox.where("projectId").equals(project.id).toArray().then((stored) => { if (active) { const items = stored.map(normalizeRoundOutboxRecord).filter((item):item is RoundOutboxRecord=>Boolean(item)).filter((item) => !alreadyCommitted.has(item.clientEventId)).map((item)=>item.roundId?item:{...item,status:"failed" as const}); roundOutboxRef.current = items; setRoundOutbox(items); if (roundSocket.current?.readyState === WebSocket.OPEN) for (const item of items.filter((entry) => entry.status === "pending")) sendOutbox(item,roundSocket.current); } }).catch(() => undefined);
    const connect = () => {
      if (!active) return;
      setRoundConnection("connecting");
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${protocol}//${window.location.host}/api/projects/${encodeURIComponent(project.id)}/round-stream?after=${roundSequence.current}`);
      roundSocket.current = socket;
      socket.onopen = () => {
        if (!active) return;
        setRoundConnection("live");
        for (const item of roundOutboxRef.current.filter((entry) => entry.status === "pending")) sendOutbox(item,socket);
      };
      socket.onmessage = (event) => {
        if (!active) return;
        try {
          const message = normalizeRoundSocketMessage(JSON.parse(String(event.data)));
          if (!message) return;
          if (message.type === "round.sync" || message.type === "round.event") acceptRound(message.round);
          if (message.type === "contribution.ack") {
            clearAckTimer(message.clientEventId);
            const existing = roundOutboxRef.current.find((item) => item.clientEventId === message.clientEventId);
            if (existing) { rememberOutbox({ ...existing, status: message.status === "sent" ? "sent" : "failed", error: message.message }); setStatus(message.status === "sent" ? "Idea committed to the room." : message.message || "That idea could not be sent."); }
          }
        } catch(error) { setStatus(error instanceof Error?`${error.message} Reconnecting…`:"The live room sent an unreadable update. Reconnecting…"); socket.close(); }
      };
      socket.onerror = () => setRoundConnection("offline");
      socket.onclose = () => {
        if (!active) return;
        setRoundConnection("offline");
        // Reconnecting sends a personalised round.sync snapshot. Replacing the
        // whole project here made every transient socket close reset local UI.
        reconnect=window.setTimeout(connect,1000);
      };
    };
    connect();
    return () => { active = false; if (reconnect) window.clearTimeout(reconnect); for(const timer of roundAckTimers.current.values())window.clearTimeout(timer);roundAckTimers.current.clear();roundSocket.current?.close(); roundSocket.current = null; };
    // Reconnect only when entering/leaving a round; sequence recovery happens within the protocol.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, project?.round?.id]);

  useEffect(() => {
    const round = project?.round;
    if (!project || !round || (round.phase !== "brainstorm" && round.phase !== "voting")) return;
    const deadline=round.phase==="voting"?round.votingDeadlineAt:round.deadlineAt;if(deadline===null)return;
    const delay = Math.max(0, deadline - round.serverTime) + 250;
    const timer = window.setTimeout(() => api<{ round: RoundSnapshot }>(`/api/projects/${encodeURIComponent(project.id)}/rounds/${round.number}`).then((result) => acceptRound(result.round)).catch(() => undefined), delay);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, project?.round?.deadlineAt, project?.round?.phase]);

  useEffect(() => {
    const onPopState = () => {
      const routed = selectionContextFromPath(window.location.pathname);
      selectionGate.current.select(routed);
      if (routed.kind === "admin") { void openAdminMode(false); return; }
      if (routed.kind === "project") { void loadProject(routed.id).catch((error) => setStatus(error instanceof Error ? error.message : "Could not open that project.")); return; }
      if (routed.kind === "team") { void loadTeam(routed.id).catch((error) => setStatus(error instanceof Error ? error.message : "Could not open that team.")); return; }
      setAdminMode(false); setProject(null); setTeam(null); setInvite(null); setStatus("Choose one of your teams or join a new crew.");
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function completeLogin(signer: NostrSigner) {
    const pubkey = (await withTimeout(signer.getPublicKey(), "Your signer took too long to share its public key. Please try again.")).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(pubkey)) throw new Error("The signer returned an invalid public key.");
    setStatus("Preparing a one-time sign-in request…"); const challenge = await api<Challenge>("/api/auth/challenge", { method: "POST", body: JSON.stringify({ pubkey }) });
    setStatus(signer.kind === "extension" ? "Check your signer and approve the Level Up request." : "Signing in with this device account…");
    const signedEvent: Event = await withTimeout(signer.signEvent(challenge.event), "Signing timed out. Nothing was shared; you can safely try again.");
    if (signedEvent.pubkey !== pubkey) throw new Error("Your active signer changed during sign-in. Switch back to the same account and try again.");
    const result = await api<{ user: User; team: Team | null }>("/api/auth/login", { method: "POST", body: JSON.stringify({ nonce: challenge.nonce, pubkey, event: signedEvent }) });
    const nextTeam = result.team ? normalizeTeam(result.team) : null;
    activeSigner = signer; setUser(result.user); if (nextTeam) rememberTeam(nextTeam); await restoreAuthenticatedRoute();
  }

  async function signIn() {
    if (busy) return; setBusy(true); setStatus("Looking for your Nostr signer…");
    try { if (!window.nostr?.getPublicKey || !window.nostr?.signEvent) throw new Error("No NIP-07 signer was found. Install a signer extension or create a player account on this device."); await completeLogin(new Nip07Signer(window.nostr)); }
    catch (error) { const message = error instanceof Error ? error.message : "Sign-in was cancelled. Please try again."; setStatus(/reject|denied|cancel/i.test(message) ? "The signature was not approved. Nothing was shared; try again when you're ready." : message); }
    finally { setBusy(false); setChecking(false); }
  }

  async function createDeviceAccount(event: React.FormEvent) {
    event.preventDefault(); setBusy(true);
    try {
      const pubkey = await vault.create(); setDevicePubkey(pubkey); const signer = new DeviceSigner(vault); await completeLogin(signer);
      try { const published = await profiles.publish(signer, undefined, { displayName, about }); setProfileMap((map) => ({ ...map, [pubkey]: published.profile })); if(published.profile.event)await api("/api/profiles",{method:"PUT",body:JSON.stringify({events:[published.profile.event]})}).catch(()=>undefined); setStatus(published.failed.length ? `Player ready. Profile reached ${published.accepted.length} of 3 relays.` : "Player ready. Joining your team now."); }
      catch (error) { setProfileMap((map) => ({ ...map, [pubkey]: { ...profileFromEvent(pubkey), displayName, about } })); setStatus(`Player ready, but the nickname could not reach the public relays: ${error instanceof Error ? error.message : "relays unavailable"}`); }
    } catch (error) { vault.lock(); setStatus(error instanceof Error ? error.message : "Could not create this device account."); } finally { setBusy(false); setChecking(false); }
  }

  async function unlockDeviceAccount(event: React.FormEvent) { event.preventDefault(); setBusy(true); try { await vault.unlock(passphrase); setPassphrase(""); await completeLogin(new DeviceSigner(vault)); } catch (error) { vault.lock(); setStatus(error instanceof Error ? error.message : "Unable to unlock this device account."); } finally { setBusy(false); setChecking(false); } }
  async function resumeDeviceAccount(){setBusy(true);try{const record=await vault.record();if(record?.formatVersion===1){setLoginMode("unlock");return;}await vault.autoUnlock();await completeLogin(new DeviceSigner(vault));}catch(error){vault.lock();setStatus(error instanceof Error?error.message:"Could not recover this device player.");}finally{setBusy(false);setChecking(false);}}
  async function logout() { setBusy(true); try { await api("/api/auth/logout", { method: "POST" }); activeSigner = null; vault.lock(); setUser(null); setTeam(null); setTeams([]); setProject(null); setInvite(null); setAdminMode(false); setAdminTab("monitoring"); setAdminPrompts([]);setSelectedPromptId(null);setPromptDraft("");setAdminSettings(null);setSettingsDraft("30");setTurnsDraft("3");setAdminProjects([]);setAdminTeams([]);setAdminRuns([]);setSelectedAdminProjectId("");setSelectedAdminRunId("");setAdminDeleteTarget(null);setEditingProfile(false);setManagingGames(false);setDeleteCandidate(null);setForgetDeviceOpen(false);setDeletingProjectId(null);window.history.replaceState({},"",signedOutPath(pendingInvite));setLoginMode("choices");setStatus(pendingInvite?"Your invite is still here. Continue as this player or sign in to finish joining.":"You’re signed out. Your encrypted device account is still stored here."); } catch (error) { setStatus(error instanceof Error ? error.message : "Could not sign out. Please try again."); } finally { setBusy(false); } }
  async function forgetDeviceAccount() { setBusy(true); try { await vault.forget(); activeSigner = null; setDevicePubkey(null); setForgetDeviceOpen(false); setLoginMode("choices"); setStatus("The encrypted device account was removed from this browser."); } catch { setStatus("The device account could not be removed. Browser storage may be unavailable."); } finally { setBusy(false); } }

  async function ensureCurrentSigner(): Promise<NostrSigner> {
    if (!userPubkey) throw new Error("Sign in before editing your profile.");
    if (activeSigner && await activeSigner.getPublicKey() === userPubkey) return activeSigner;
    if (window.nostr) { const signer = new Nip07Signer(window.nostr); if ((await signer.getPublicKey()).toLowerCase() === userPubkey) { activeSigner = signer; return signer; } }
    throw new Error("Your signing key is locked. Log out, unlock this device account, and try again.");
  }
  async function openProfileEditor() { try { await ensureCurrentSigner(); setEditingProfile(true); } catch (error) { setStatus(error instanceof Error ? error.message : "A signer is required to edit your profile."); } }
  async function saveProfile(edit: { displayName: string; about: string }) { if (!userPubkey) return; setBusy(true); try { const signer = await ensureCurrentSigner(); const result = await profiles.publish(signer, currentProfile, edit); if(result.profile.event)await api("/api/profiles",{method:"PUT",body:JSON.stringify({events:[result.profile.event]})}); setProfileMap((map) => ({ ...map, [userPubkey]: result.profile })); setEditingProfile(false); setStatus(result.failed.length ? `Profile saved for your team; ${result.accepted.length} of 3 relays acknowledged it.` : "Profile published to all relays."); } catch (error) { setStatus(error instanceof Error ? error.message : "Could not publish that profile."); } finally { setBusy(false); } }
  function openGameManager() { setEditingProfile(false); setManagingGames(true); void refreshTeams().catch((error) => setStatus(error instanceof Error ? error.message : "Could not refresh your games.")); }
  async function deleteProject(target: ProjectDeletionTarget) { const projectToDelete = target.project; setDeletingProjectId(projectToDelete.id); setBusy(true); try { const result = await api<{ team: Team; deletedProjectId: string }>(`/api/projects/${encodeURIComponent(projectToDelete.id)}`, { method: "DELETE" }); const nextTeam = normalizeTeam(result.team); rememberTeam(nextTeam); setDeleteCandidate(null); if (team?.id === nextTeam.id || project?.id === result.deletedProjectId) setTeam(nextTeam); if (project?.id === result.deletedProjectId) { selectionGate.current.select({ kind: "team", id: nextTeam.id }); setProject(null); window.history.pushState({}, "", `/teams/${encodeURIComponent(nextTeam.id)}`); setStatus(`Deleted ${projectToDelete.name}.`); } else setStatus(`Deleted ${projectToDelete.name}.`); } catch (error) { setStatus(error instanceof Error ? error.message : "Could not delete that game."); } finally { setDeletingProjectId(null); setBusy(false); } }
  async function createTeam(event: React.FormEvent) { event.preventDefault(); setBusy(true); try { const result = await api<{ team: Team; invite: Invite }>("/api/teams", { method: "POST", body: JSON.stringify({ name: teamName }) }); const nextTeam = normalizeTeam(result.team); selectionGate.current.select({ kind: "team", id: nextTeam.id }); window.history.pushState({}, "", `/teams/${encodeURIComponent(nextTeam.id)}`); setTeam(nextTeam); rememberTeam(nextTeam); setTeamName(""); setInvite(result.invite); setStatus(`${nextTeam.name} is ready for players.`); } catch (error) { setStatus(error instanceof Error ? error.message : "Could not create that team."); } finally { setBusy(false); } }
  async function joinTeam(event: React.FormEvent) { event.preventDefault(); const secret = parseInviteSecret(joinInput); if (!secret) { setStatus("Paste a complete Level Up invite link or its invite secret."); return; } setBusy(true); try { await redeem(secret); } catch (error) { setStatus(error instanceof Error ? error.message : "That invite could not be joined."); } finally { setBusy(false); } }
  async function rotateInvite() { if (!team) return; setBusy(true); try { const result = await api<{ invite: Invite }>(`/api/teams/${encodeURIComponent(team.id)}/invites/rotate`, { method: "POST" }); setInvite(result.invite); setStatus("Fresh invite ready. Older links no longer work."); } catch (error) { setStatus(error instanceof Error ? error.message : "Could not create a fresh invite."); } finally { setBusy(false); } }
  function goHome() { setManagingGames(false); setDeleteCandidate(null); setAdminMode(false); selectionGate.current.select({ kind: "root" }); setProject(null); if (team) rememberTeam(team); setTeam(null); setInvite(null); if (window.location.pathname !== "/") window.history.pushState({}, "", "/"); setStatus("Choose one of your teams or join a new crew."); void refreshTeams().catch((error) => setStatus(error instanceof Error ? error.message : "Could not refresh your teams.")); }
  function openManagedProject(projectId: string) { setManagingGames(false); setDeleteCandidate(null); void loadProject(projectId, true).catch((error) => setStatus(error instanceof Error ? error.message : "Could not open that project.")); }
  async function loadTeam(teamId: string, navigate = false): Promise<Team> { const context: SelectionContext = { kind: "team", id: teamId }; if (navigate && window.location.pathname !== `/teams/${encodeURIComponent(teamId)}`) window.history.pushState({}, "", `/teams/${encodeURIComponent(teamId)}`); const request = navigate ? selectionGate.current.select(context) : selectionGate.current.refresh(context); if (request === null) throw new Error("That team is no longer selected."); const result = await api<{ team: Team; invite?: Invite }>(`/api/teams/${encodeURIComponent(teamId)}/lobby`); const nextTeam = normalizeTeam(result.team); if (selectionGate.current.accepts(context, request) && selectionContextKey(selectionContextFromPath(window.location.pathname)) === selectionContextKey(context)) { setAdminMode(false); setProject(null); setTeam(nextTeam); rememberTeam(nextTeam); setInvite(result.invite && typeof result.invite.url === "string" && typeof result.invite.secret === "string" ? result.invite : null); setStatus(`Welcome back to ${nextTeam.name}.`); } return nextTeam; }
  async function openTeam(selected: Team) { setBusy(true); try { const nextTeam = await loadTeam(selected.id, true); const selectedContext: SelectionContext = { kind: "team", id: nextTeam.id }; if (selectionGate.current.current() !== selectionContextKey(selectedContext) || selectionContextKey(selectionContextFromPath(window.location.pathname)) !== selectionContextKey(selectedContext)) return; const destination = teamSelectionDestination(nextTeam); if (destination.kind === "project") await loadProject(destination.id, true); } catch (error) { setStatus(error instanceof Error ? error.message : "Could not open that team."); } finally { setBusy(false); } }
  async function createProject(event: React.FormEvent) { event.preventDefault(); if (!team) return; setBusy(true); try { const result = await api<{ project: ProjectRoom }>(`/api/teams/${encodeURIComponent(team.id)}/projects`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ name: projectName }) }); setProjectName(""); window.history.pushState({}, "", `/projects/${encodeURIComponent(result.project.id)}`); selectionGate.current.select({ kind: "project", id: result.project.id }); acceptProject(result.project); setStatus("Project created. Try the games before voting starts."); } catch (error) { setStatus(error instanceof Error ? error.message : "Could not create that project."); } finally { setBusy(false); } }
  async function chooseTemplate(templateId: string, replaceIndex?: number) { if (!project || project.phase !== "selecting_template") return; let next: string[]; if (projectDraft.includes(templateId)) return; else if (projectDraft.length < 2) next = [...projectDraft, templateId]; else { next = [...projectDraft]; next[replaceIndex ?? 0] = templateId; } setProjectDraft(next); if (next.length !== 2) { setStatus("One more favourite to go."); return; } setBusy(true); try { const result = await api<{ project: ProjectRoom }>(`/api/projects/${encodeURIComponent(project.id)}/template-selections`, { method: "PUT", body: JSON.stringify({ templateIds: next }) }); acceptProject(result.project); setStatus("Your two favourites are saved for everyone to see."); } catch (error) { setProjectDraft(project.selections); setStatus(error instanceof Error ? error.message : "Could not save those choices."); } finally { setBusy(false); } }
  async function closeVoting() { if (!project) return; setBusy(true); try { const starting = project.selectionStartedAt <= 0; const result = await api<{ project: ProjectRoom }>(`/api/projects/${encodeURIComponent(project.id)}/template-selection/${starting ? "start" : "close"}`, { method: "POST" }); acceptProject(result.project); setStatus(starting ? "Voting started. Choose two favourites." : result.project.phase === "resolving_template_tie" ? "Voting closed with a tie. Make the final call." : "Template locked. Round 1 is ready."); } catch (error) { setStatus(error instanceof Error ? error.message : "Could not update voting."); } finally { setBusy(false); } }
  async function resolveTie(templateId: string) { if (!project) return; setBusy(true); try { const result = await api<{ project: ProjectRoom }>(`/api/projects/${encodeURIComponent(project.id)}/template-selection/resolve`, { method: "POST", body: JSON.stringify({ templateId }) }); acceptProject(result.project); setStatus("Template locked. Round 1 is ready."); } catch (error) { setStatus(error instanceof Error ? error.message : "Could not resolve that tie."); } finally { setBusy(false); } }
  async function addRoundIdeaFiles(files:File[]){try{const added=await filesToIdeaAttachments(files,roundIdeaAttachments);setRoundIdeaAttachments((current)=>[...current,...added]);setStatus(`${added.length} screenshot${added.length===1?"":"s"} attached.`);}catch(error){setStatus(error instanceof Error?error.message:"Those screenshots could not be attached.");}}
  function removeRoundIdeaAttachment(id:string){setRoundIdeaAttachments((current)=>current.filter((attachment)=>attachment.id!==id));}
  async function submitRoundIdea(event: React.FormEvent) { event.preventDefault(); if (!project?.round || project.round.phase !== "brainstorm") return; const body = roundIdea.trim(); if (!body&&!roundIdeaAttachments.length) return; const item: RoundOutboxRecord = { clientEventId: crypto.randomUUID(), projectId: project.id, roundId:project.round.id, roundNumber:project.round.number, body, attachments:roundIdeaAttachments, status: "pending", createdAt: Date.now() }; rememberOutbox(item); setRoundIdea(""); setRoundIdeaAttachments([]); setStatus(roundSocket.current?.readyState===WebSocket.OPEN?"Sending your idea to the room…":"Idea saved on this device. Reconnecting to send it…"); sendOutbox(item); }
  async function roundCommand(path:string,statusMessage:string,init:RequestInit={method:"POST"},roundNumber?:number):Promise<boolean>{if(!project?.round)return false;setBusy(true);try{const result=await api<{round:RoundSnapshot}>(`/api/projects/${encodeURIComponent(project.id)}/rounds/${roundNumber??project.round.number}/${path}`,init);acceptRound(result.round);setStatus(statusMessage);return true;}catch(error){setStatus(error instanceof Error?error.message:"Could not update this round.");void loadProject(project.id).catch(()=>undefined);return false;}finally{setBusy(false);}}
  async function closeBrainstorm(){
    if(proposalGenerationStartingRef.current||project?.round?.proposalGeneration?.status==="running")return;
    proposalGenerationStartingRef.current=true;setStatus("lvl_up is turning the brainstorm into checked requirement cards...");
    try{await roundCommand("brainstorm/close","Proposal generation started. Cards will appear here when they are ready.");}
    finally{proposalGenerationStartingRef.current=false;}
  }
  async function beginProposalVoting(){setStatus("Opening voting for the whole room...");await roundCommand("voting",`Voting is open. Spend your ${project?.round?.proposalVoteAllowance ?? 5} vote tokens.`);}
  async function saveProposalVotes(proposalIds:string[]){
    if(!project?.round)return;
    queuedProposalVotes.current=proposalIds;
    if(proposalVotesSaving.current)return;
    proposalVotesSaving.current=true;
    try{
      while(queuedProposalVotes.current&&project?.round){
        const next=queuedProposalVotes.current;queuedProposalVotes.current=null;
        try{const result=await api<{round:RoundSnapshot}>(`/api/projects/${encodeURIComponent(project.id)}/rounds/${project.round.number}/proposal-votes`,{method:"PUT",body:JSON.stringify({proposalIds:next})});const normalized=normalizeRoundSnapshot(result.round);setStatus(`${next.length}/${normalized.proposalVoteAllowance} vote tokens saved.`);}
        catch(error){queuedProposalVotes.current=null;setStatus(error instanceof Error?error.message:"Could not save those vote tokens.");void loadProject(project.id).catch(()=>undefined);}
      }
    }finally{proposalVotesSaving.current=false;}
  }
  async function closeProposalVoting(){setStatus("Freezing the prioritised queue and starting Build...");await roundCommand("voting/close","Prioritisation closed. Build started with the frozen feature queue.");}
  async function startBuild(roundNumber?:number){setStatus("Asking the real build agent to acknowledge the frozen brief...");await roundCommand("build","Build started. Progress is shared live.",{method:"POST"},roundNumber);}
  async function reportBuildProblem(note:string,roundNumber?:number){setStatus("Interrupting the active build and preserving the prior playable release...");return await roundCommand("build/report","Report saved. The active feature was interrupted before any further publish.",{method:"POST",body:JSON.stringify({note})},roundNumber);}
  async function deferFeature(roundNumber?:number){setStatus("Deferring the interrupted feature...");await roundCommand("build/defer","Feature deferred. The previous playable release remains available.",{method:"POST"},roundNumber);}
  async function brainstormMore(){setStatus("Opening the next brainstorm while the frozen queue keeps building...");await roundCommand("brainstorm-more","Next brainstorm started. The active build is still running in the background.");}

  if (!user) {
    const deviceNpub = devicePubkey ? nip19.npubEncode(devicePubkey) : null;
    return <main className="app-shell login-shell"><div className="ambient ambient-one" aria-hidden="true" /><div className="ambient ambient-two" aria-hidden="true" /><div className="world-scene" aria-hidden="true"><span className="cloud cloud-one" /><span className="cloud cloud-two" /><span className="block-tree"><i /><b /></span><span className="world-step step-one" /><span className="world-step step-two" /><span className="world-step step-three" /></div><section className="login-card" aria-labelledby="login-title"><div className="brand-lockup"><LevelMark /><div><span>COLLABORATIVE</span><strong>LEVEL UP</strong></div></div>{pendingInvite && <div className="invite-arrival"><span aria-hidden="true">◆</span><div><strong>Team invite found</strong><small>Sign in and we’ll take you straight to the lobby.</small></div></div>}<div className="hero-copy"><p className="eyebrow">Make the next round yours</p><h1 id="login-title">Build a game.<br /><em>Together.</em></h1><p>Pick a starting world, throw ideas into the room, vote on what matters, then play the version your team just made.</p></div>
      {loginMode === "choices" && <AuthChoices deviceNpub={deviceNpub} busy={busy} checking={checking} onCreatePlayer={() => setLoginMode("create")} onResumeDevice={() => void resumeDeviceAccount()} onSignInWithNostr={() => void signIn()} />}
      {loginMode === "create" && <form className="device-form" onSubmit={createDeviceAccount}><h2>Create a player account</h2><p className="vault-warning">This throwaway player is encrypted and unlocks automatically on this browser. Use a nickname—not your full name, school, address, phone number, or other personal details.</p><label><span>Nickname</span><input required maxLength={80} value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label><label><span>About (optional)</span><textarea maxLength={500} rows={3} value={about} onChange={(event) => setAbout(event.target.value)} /></label><button className="primary-button compact-button" disabled={busy}>Create player and join</button><button className="form-back" type="button" onClick={() => setLoginMode("choices")}>Back to sign-in choices</button></form>}
      {loginMode === "unlock" && deviceNpub && <form className="device-form" onSubmit={unlockDeviceAccount}><h2>Unlock this device account</h2><p className="device-identity">Saved Level Up player</p><label><span>Passphrase</span><input type="password" required maxLength={256} autoComplete="current-password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} /></label><button className="primary-button compact-button" disabled={busy}>Unlock and sign in</button><div className="device-actions"><button className="form-back" type="button" onClick={() => setLoginMode("choices")}>Use NIP-07 instead</button><button className="danger-link" type="button" onClick={() => setForgetDeviceOpen(true)}>Forget account on this device</button></div></form>}
      {forgetDeviceOpen && <ForgetDeviceDialog busy={busy} onCancel={() => setForgetDeviceOpen(false)} onConfirm={forgetDeviceAccount} />}
      <p className="status" role="status" aria-live="polite">{status}</p></section><AppFooter /></main>;
  }

  const header = currentProfile && <AppHeader user={user} profile={currentProfile} busy={busy} atHome={!team && !project && !adminMode} onHome={goHome} onEdit={openProfileEditor} onManageGames={openGameManager} onAdmin={canUseAdmin ? () => void openAdminMode() : undefined} onLogout={logout} />;
  const dialog = <>{editingProfile && currentProfile && <ProfileDialog profile={currentProfile} busy={busy} onClose={() => setEditingProfile(false)} onSave={saveProfile} />}{managingGames && <ManageGamesDialog teams={teams} busy={busy} deletingProjectId={deletingProjectId} onClose={() => { setManagingGames(false); setDeleteCandidate(null); }} onOpenProject={openManagedProject} onDeleteProject={setDeleteCandidate} />}{deleteCandidate && <DeleteGameDialog target={deleteCandidate} busy={busy} deletingProjectId={deletingProjectId} onCancel={() => setDeleteCandidate(null)} onConfirm={deleteProject} />}{adminDeleteTarget&&<AdminDeleteDialog target={adminDeleteTarget} busy={busy} onCancel={()=>setAdminDeleteTarget(null)} onConfirm={()=>void confirmAdminDeletion()}/>}</>;
  if (adminMode) {
    return <main className="app-shell admin-shell"><div className="ambient ambient-one" aria-hidden="true" /><div className="ambient ambient-two" aria-hidden="true" /><section className="admin-card">{header}{canUseAdmin ? <AdminPromptView tab={adminTab} prompts={adminPrompts} selectedId={selectedPromptId} draft={promptDraft} settings={adminSettings} settingsDraft={settingsDraft} turnsDraft={turnsDraft} votesDraft={votesDraft} modelsDraft={modelsDraft} defaultModelDraft={defaultModelDraft} projects={adminProjects} teams={adminTeams} runs={adminRuns} selectedProjectId={selectedAdminProjectId} selectedRunId={selectedAdminRunId} busy={busy} status={status} onTab={setAdminTab} onSelect={selectPrompt} onDraft={setPromptDraft} onSettingsDraft={setSettingsDraft} onTurnsDraft={setTurnsDraft} onVotesDraft={setVotesDraft} onModelsDraft={setModelsDraft} onDefaultModelDraft={setDefaultModelDraft} onPromptModel={(id, model) => void saveSelectedPromptModel(id, model)} onSelectProject={selectAdminProject} onSelectRun={setSelectedAdminRunId} onRefreshRuns={() => { void loadAdminProjects(); void loadAdminTeams(); void loadAdminRuns(); }} onDeleteProject={(target)=>setAdminDeleteTarget({kind:"project",id:target.id,name:target.name,teamName:target.teamName})} onDeleteTeam={(target)=>setAdminDeleteTarget({kind:"team",id:target.id,name:target.name,projectCount:target.projectCount})} onSave={() => void saveSelectedPrompt()} onReset={() => void saveSelectedPrompt(true)} onSaveSettings={() => void saveAdminLoopSettings()} onSaveModels={() => void saveAdminModels()} /> : <section className="admin-mode"><div className="admin-hero"><div><p className="eyebrow">OWNER ADMIN MODE</p><h1>Unavailable</h1><p>Admin mode is only available to the Level Up owner.</p></div></div><p className="status" role="status" aria-live="polite">{status}</p></section>}</section><AppFooter />{dialog}</main>;
  }
  if (project) {
    const remaining = project.phase === "selecting_template" && project.selectionStartedAt > 0 ? remainingWholeSeconds(project.selectionDeadlineAt, project.serverTime, clockTick - clockSyncedAt) : 0;
    const activeRound=project.round; const activeDeadline=activeRound?.phase==="voting"?activeRound.votingDeadlineAt:activeRound?.deadlineAt;
    const roundRemaining = activeRound&&(activeRound.phase === "brainstorm"||activeRound.phase==="voting")&&typeof activeDeadline==="number" ? remainingWholeSeconds(activeDeadline, activeRound.serverTime, clockTick - clockSyncedAt) : 0;
    return <main className="app-shell project-shell"><div className="ambient ambient-one" aria-hidden="true" /><div className="ambient ambient-two" aria-hidden="true" /><section className="project-room">{header}<ProjectRoomView project={project} draft={projectDraft} remaining={remaining} roundRemaining={roundRemaining} pending={roundOutbox} idea={roundIdea} ideaAttachments={roundIdeaAttachments} connection={roundConnection} profileMap={profileMap} viewerNpub={user.npub} busy={busy} status={status} onChoose={chooseTemplate} onClose={closeVoting} onResolve={resolveTie} onIdeaChange={setRoundIdea} onAddIdeaFiles={addRoundIdeaFiles} onRemoveIdeaAttachment={removeRoundIdeaAttachment} onSubmitIdea={submitRoundIdea} onRetryIdea={retryRoundIdea} onDismissIdea={dismissRoundIdea} onCloseBrainstorm={closeBrainstorm} onBeginVoting={beginProposalVoting} onProposalVotes={saveProposalVotes} onCloseProposalVoting={closeProposalVoting} onStartBuild={startBuild} onReportBuild={reportBuildProblem} onDeferFeature={deferFeature} onBrainstormMore={brainstormMore}/></section><AppFooter />{dialog}</main>;
  }
  if (!team) return <main className="app-shell team-shell"><div className="ambient ambient-one" aria-hidden="true" /><div className="ambient ambient-two" aria-hidden="true" /><section className="future-card team-choice-card">{header}<TeamChooserView userNpub={user.npub} teams={teams} teamName={teamName} joinInput={joinInput} busy={busy} onTeamName={setTeamName} onJoinInput={setJoinInput} onCreate={createTeam} onJoin={joinTeam} onOpenTeam={openTeam} /><p className="status" role="status" aria-live="polite">{status}</p><div className="signed-as">SIGNED IN · {currentProfile?.displayName}</div></section><AppFooter />{dialog}</main>;
  return <main className="app-shell lobby-shell"><div className="ambient ambient-one" aria-hidden="true" /><div className="ambient ambient-two" aria-hidden="true" /><section className="lobby-card">{header}<div className="lobby-title"><div><p className="eyebrow">TEAM LOBBY</p><h1>{team.name}</h1></div><div className="lobby-voxel" aria-hidden="true"><i /><b /><span /></div></div><TeamProjectsView team={team} projectName={projectName} busy={busy} onProjectName={setProjectName} onCreateProject={createProject} onOpenProject={(projectId) => void loadProject(projectId, true).catch((error) => setStatus(error instanceof Error ? error.message : "Could not open that project."))} /><div className="lobby-grid"><section className="members-panel" aria-labelledby="members-title"><div className="section-heading"><h2 id="members-title">Players</h2><span>{team.members.length} here</span></div><ol>{team.members.map((member, index) => { let pubkey: string | undefined; try { pubkey = pubkeyFromNpub(member.npub); } catch { /* fallback */ } const profile = pubkey ? profileMap[pubkey]??profileFromEvent(pubkey) : undefined; return <li key={member.accountId}><Avatar profile={profile} variant={index} /><div><strong>{memberDisplayName(member, profile, index)}</strong><small>{member.role === "organiser" ? "Team organiser" : "Team player"}</small></div><span className="online-dot" /></li>; })}</ol></section><InvitePanel team={team} invite={invite} busy={busy} onRotate={rotateInvite} /></div><p className="status lobby-status" role="status" aria-live="polite">{status}</p></section><AppFooter />{dialog}</main>;
}
