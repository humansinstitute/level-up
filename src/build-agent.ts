import { renderAgentPrompt } from "./admin-prompts";
import { agentConfig, runGooseJson, type AgentConfig } from "./feedback-agent";
import { SummaryError, invalidAgentOutput, object } from "./feedback-summary";
import type { BuildAdapter, BuildAdapterInput, BuildAdapterResult, RankedProposal } from "./loop";
import { activityLog } from "./activity-log";

export const BUILD_RUN_SCHEMA_VERSION = 1;
const MAX_BUILD_RUN_BYTES = 8_000;
export const GAME_EDIT_SCHEMA_VERSION = 1;
const MAX_GAME_EDIT_BYTES = 120_000;

export interface BuildRunAgentOutput {
  schemaVersion: 1;
  status: "ready";
  notes: string;
}

export interface BuildRunAgent {
  run(input: BuildAdapterInput): Promise<BuildRunAgentOutput>;
}

export interface GameEditAgentInput {
  projectId?: string;
  projectName: string;
  templateTitle: string;
  version: string;
  sourceHtml: string;
  proposal: RankedProposal;
  priorImplemented: RankedProposal[];
}

export interface GameEditAgentOutput {
  schemaVersion: 1;
  indexHtml: string;
  notes: string;
}

export interface GameEditAgent {
  edit(input: GameEditAgentInput): Promise<GameEditAgentOutput>;
}

export function buildRunPrompt(input: BuildAdapterInput): string {
  return renderAgentPrompt("build_run", input);
}

export function gameEditPrompt(input: GameEditAgentInput): string {
  return renderAgentPrompt("game_edit", {
    projectName: input.projectName,
    templateTitle: input.templateTitle,
    version: input.version,
    proposal: input.proposal,
    priorImplemented: input.priorImplemented.map((proposal) => ({ id: proposal.id, title: proposal.title, playerChange: proposal.playerChange })),
    sourceHtml: input.sourceHtml,
  });
}

function text(value: unknown, limit: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit) invalidAgentOutput("text field", `provide non-empty text no longer than ${limit} characters`);
  return value.trim();
}

function optionalTextAlias(record: Record<string, unknown>, keys: string[], limit: number): string | null {
  for (const key of keys) {
    if (!(key in record)) continue;
    return text(record[key], limit);
  }
  return null;
}

const READY_STATUSES = new Set(["ready", "approved"]);
const REJECTED_STATUSES = new Set(["blocked", "error", "failed", "failure", "impossible", "invalid", "not-ready", "not_ready", "rejected", "unsafe"]);
const DEFAULT_BUILD_RUN_NOTES = "Frozen voted brief is ready for the Level Up release adapter.";

function statusValue(value: unknown): string | null {
  return typeof value === "string" ? value.trim().toLowerCase().replace(/\s+/g, "_") : null;
}

function rejectIfNegativeSignal(record: Record<string, unknown>): void {
  for (const key of ["status", "state", "outcome"]) {
    const status = statusValue(record[key]);
    if (status && REJECTED_STATUSES.has(status)) invalidAgentOutput(key, "return a correctable schema payload instead of a rejected status, or correct the unsafe input claim");
  }
  if (record.ready === false || record.approved === false || record.safe === false || record.feasible === false || record.possible === false) invalidAgentOutput("status", "return the requested valid payload only after all readiness and safety conditions are true");
  if (typeof record.error === "string" && record.error.trim()) invalidAgentOutput("error", "remove the error field and return the corrected requested payload");
  if (typeof record.failure === "string" && record.failure.trim()) invalidAgentOutput("failure", "remove the failure field and return the corrected requested payload");
}

function normalizeBuildRunRecord(record: Record<string, unknown>): BuildRunAgentOutput | null {
  rejectIfNegativeSignal(record);
  if ("schemaVersion" in record && record.schemaVersion !== BUILD_RUN_SCHEMA_VERSION) invalidAgentOutput("schemaVersion", `use ${BUILD_RUN_SCHEMA_VERSION}`);
  const status = statusValue(record.status);
  const ready = status ? READY_STATUSES.has(status) : record.ready === true || record.approved === true;
  if (!ready) return null;
  return {
    schemaVersion: 1,
    status: "ready",
    notes: optionalTextAlias(record, ["notes", "note", "message", "summary", "acknowledgement", "acknowledgment"], 1000) ?? DEFAULT_BUILD_RUN_NOTES,
  };
}

function validateBuildRun(value: unknown): BuildRunAgentOutput {
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_BUILD_RUN_BYTES) throw new SummaryError("output_too_large");
  const root = object(value);
  const seen = new Set<Record<string, unknown>>();
  const queue: Record<string, unknown>[] = [root];
  for (const record of queue) {
    if (seen.has(record)) continue;
    seen.add(record);
    const normalized = normalizeBuildRunRecord(record);
    if (normalized) return normalized;
    for (const key of ["payload", "arguments", "input", "result", "output", "response", "buildRun", "build_run"]) {
      const nested = record[key];
      if (nested && typeof nested === "object" && !Array.isArray(nested)) queue.push(nested as Record<string, unknown>);
    }
  }
  invalidAgentOutput("build acknowledgement", "provide status ready (or ready/approved true) in the requested JSON payload");
}

function normalizeGameEditRecord(record: Record<string, unknown>): GameEditAgentOutput | null {
  rejectIfNegativeSignal(record);
  if ("schemaVersion" in record && record.schemaVersion !== GAME_EDIT_SCHEMA_VERSION) invalidAgentOutput("schemaVersion", `use ${GAME_EDIT_SCHEMA_VERSION}`);
  const indexHtml = record.indexHtml ?? record.index_html ?? record.html ?? record.document;
  if (indexHtml === undefined) return null;
  const html = text(indexHtml, MAX_GAME_EDIT_BYTES);
  if (!/<!doctype\s+html/i.test(html) || !/<html[\s>]/i.test(html) || !/<\/html>/i.test(html)) invalidAgentOutput("indexHtml", "return one complete HTML document with doctype, opening html, and closing html tags");
  if (!/<script[\s>]/i.test(html) || !/<(canvas|main)[\s>]/i.test(html)) invalidAgentOutput("indexHtml", "include inline game logic and a visible main or canvas render surface");
  if (/<script\b[^>]*\bsrc\s*=/i.test(html) || /\b(?:fetch|importScripts|indexedDB|localStorage|sessionStorage)\s*\(/i.test(html)) invalidAgentOutput("indexHtml", "remove external scripts, network calls, and browser persistence APIs");
  if (/https?:\/\//i.test(html) || /\bimport\s*\(/i.test(html)) invalidAgentOutput("indexHtml", "remove external URLs and dynamic imports so the game is self-contained");
  return {
    schemaVersion: 1,
    indexHtml: html,
    notes: optionalTextAlias(record, ["notes", "note", "message", "summary"], 1000) ?? "Implemented the voted requirement in the playable game source.",
  };
}

function validateGameEdit(value: unknown): GameEditAgentOutput {
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_GAME_EDIT_BYTES + 12_000) throw new SummaryError("output_too_large");
  const root = object(value);
  const seen = new Set<Record<string, unknown>>();
  const queue: Record<string, unknown>[] = [root];
  for (const record of queue) {
    if (seen.has(record)) continue;
    seen.add(record);
    const normalized = normalizeGameEditRecord(record);
    if (normalized) return normalized;
    for (const key of ["payload", "arguments", "input", "result", "output", "response", "gameEdit", "game_edit"]) {
      const nested = record[key];
      if (nested && typeof nested === "object" && !Array.isArray(nested)) queue.push(nested as Record<string, unknown>);
    }
  }
  invalidAgentOutput("game edit", "provide indexHtml containing the complete corrected self-contained game document");
}

export class GooseBuildRunAgent implements BuildRunAgent {
  constructor(readonly config: AgentConfig = agentConfig(), private readonly localPreflightHost?: string) {}
  async run(input: BuildAdapterInput): Promise<BuildRunAgentOutput> {
    const result = await runGooseJson(
      this.config,
      buildRunPrompt(input),
      new AbortController().signal,
      () => undefined,
      validateBuildRun,
      { localPreflightHost: this.localPreflightHost, maxOutputBytes: MAX_BUILD_RUN_BYTES, clientName: "level-up-build-run", stage: "build_run", fields: { projectId: input.projectId, roundNumber: input.roundNumber } },
    );
    activityLog("agent.build_run.validated", { projectId: input.projectId, roundNumber: input.roundNumber, notes: result.output.notes });
    return result.output;
  }
}

export class GooseGameEditAgent implements GameEditAgent {
  constructor(readonly config: AgentConfig = agentConfig(), private readonly localPreflightHost?: string) {}
  async edit(input: GameEditAgentInput): Promise<GameEditAgentOutput> {
    const result = await runGooseJson(
      this.config,
      gameEditPrompt(input),
      new AbortController().signal,
      () => undefined,
      validateGameEdit,
      { localPreflightHost: this.localPreflightHost, maxOutputBytes: MAX_GAME_EDIT_BYTES, clientName: "level-up-game-edit", stage: "game_edit", fields: { projectId: input.projectId ?? null, version: input.version, proposalId: input.proposal.id } },
    );
    activityLog("agent.game_edit.validated", { version: input.version, proposalId: input.proposal.id, htmlBytes: Buffer.byteLength(result.output.indexHtml), notes: result.output.notes });
    return result.output;
  }
}

export class AgentBackedBuildAdapter implements BuildAdapter {
  readonly simulated = false;
  constructor(private readonly agent: BuildRunAgent, private readonly delegate: BuildAdapter) {}
  async validate(input: BuildAdapterInput): Promise<BuildAdapterResult> {
    activityLog("build.agent_ack.start", { projectId: input.projectId, roundNumber: input.roundNumber });
    await this.agent.run(input);
    activityLog("build.agent_ack.complete", { projectId: input.projectId, roundNumber: input.roundNumber });
    return await this.delegate.validate(input);
  }
}
