import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { assignedAgentModels } from "./admin-prompts";

export const DEFAULT_BRAINSTORM_SUGGESTION_INTERVAL_SECONDS = 30;
export const MIN_BRAINSTORM_SUGGESTION_INTERVAL_SECONDS = 5;
export const MAX_BRAINSTORM_SUGGESTION_INTERVAL_SECONDS = 600;
export const DEFAULT_AGENT_MAX_TURNS = 3;
export const MIN_AGENT_MAX_TURNS = 1;
export const MAX_AGENT_MAX_TURNS = 5;
export const DEFAULT_PROPOSAL_VOTE_ALLOWANCE = 5;
export const MIN_PROPOSAL_VOTE_ALLOWANCE = 1;
export const MAX_PROPOSAL_VOTE_ALLOWANCE = 20;
export const MAX_ALLOWED_MODELS = 24;
export const MAX_MODEL_ID_LENGTH = 128;

export interface AdminSettingsRecord {
  brainstormSuggestionIntervalSeconds: number;
  brainstormSuggestionIntervalMs: number;
  agentMaxTurns: number;
  proposalVoteAllowance: number;
  allowedModels: string[];
  defaultModel: string;
  updatedAt: number | null;
}

type SettingsFile = {
  schemaVersion?: unknown;
  brainstormSuggestionIntervalSeconds?: unknown;
  agentMaxTurns?: unknown;
  proposalVoteAllowance?: unknown;
  updatedAt?: unknown;
  allowedModels?: unknown;
  defaultModel?: unknown;
};

function bootModel(): string { return process.env.LEVELUP_AGENT_MODEL?.trim() || ""; }

function normalizeModelId(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid_agent_model");
  const model = value.trim();
  if (!model || model.length > MAX_MODEL_ID_LENGTH || !/^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model)) throw new Error("invalid_agent_model");
  return model;
}

function normalizeModels(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ALLOWED_MODELS) throw new Error("invalid_allowed_models");
  const models = value.map(normalizeModelId);
  if (new Set(models).size !== models.length) throw new Error("duplicate_agent_model");
  return models;
}

function settingsPath(): string {
  return process.env.LEVELUP_ADMIN_SETTINGS_PATH?.trim() || "runtime-data/admin-settings.json";
}

function normalizeIntervalSeconds(value: unknown): number {
  const numeric = typeof value === "string" && value.trim() ? Number(value) : value;
  if (
    typeof numeric !== "number"
    || !Number.isSafeInteger(numeric)
    || numeric < MIN_BRAINSTORM_SUGGESTION_INTERVAL_SECONDS
    || numeric > MAX_BRAINSTORM_SUGGESTION_INTERVAL_SECONDS
  ) {
    throw new Error("invalid_brainstorm_suggestion_interval");
  }
  return numeric;
}

function normalizeAgentMaxTurns(value: unknown): number {
  const numeric = typeof value === "string" && value.trim() ? Number(value) : value;
  if (
    typeof numeric !== "number"
    || !Number.isSafeInteger(numeric)
    || numeric < MIN_AGENT_MAX_TURNS
    || numeric > MAX_AGENT_MAX_TURNS
  ) {
    throw new Error("invalid_agent_max_turns");
  }
  return numeric;
}

function normalizeProposalVoteAllowance(value: unknown): number {
  const numeric = typeof value === "string" && value.trim() ? Number(value) : value;
  if (
    typeof numeric !== "number"
    || !Number.isSafeInteger(numeric)
    || numeric < MIN_PROPOSAL_VOTE_ALLOWANCE
    || numeric > MAX_PROPOSAL_VOTE_ALLOWANCE
  ) throw new Error("invalid_proposal_vote_allowance");
  return numeric;
}

function readSettingsFile(): SettingsFile | null {
  try {
    return JSON.parse(readFileSync(settingsPath(), "utf8")) as SettingsFile;
  } catch {
    return null;
  }
}

function writeSettingsFile(settings: AdminSettingsRecord): void {
  const path = settingsPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({
    schemaVersion: 3,
    brainstormSuggestionIntervalSeconds: settings.brainstormSuggestionIntervalSeconds,
    agentMaxTurns: settings.agentMaxTurns,
    proposalVoteAllowance: settings.proposalVoteAllowance,
    allowedModels: settings.allowedModels,
    defaultModel: settings.defaultModel,
    updatedAt: settings.updatedAt,
  }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function adminSettings(): AdminSettingsRecord {
  const parsed = readSettingsFile();
  const fallbackModel = bootModel();
  const fallbackModels = fallbackModel ? [fallbackModel] : [];
  if (parsed?.schemaVersion !== 1 && parsed?.schemaVersion !== 2 && parsed?.schemaVersion !== 3) {
    return {
      brainstormSuggestionIntervalSeconds: DEFAULT_BRAINSTORM_SUGGESTION_INTERVAL_SECONDS,
      brainstormSuggestionIntervalMs: DEFAULT_BRAINSTORM_SUGGESTION_INTERVAL_SECONDS * 1000,
      agentMaxTurns: DEFAULT_AGENT_MAX_TURNS,
      proposalVoteAllowance: DEFAULT_PROPOSAL_VOTE_ALLOWANCE,
      allowedModels: fallbackModels,
      defaultModel: fallbackModel,
      updatedAt: null,
    };
  }
  try {
    const seconds = normalizeIntervalSeconds(parsed.brainstormSuggestionIntervalSeconds);
    const agentMaxTurns = parsed.agentMaxTurns === undefined ? DEFAULT_AGENT_MAX_TURNS : normalizeAgentMaxTurns(parsed.agentMaxTurns);
    const proposalVoteAllowance = parsed.proposalVoteAllowance === undefined ? DEFAULT_PROPOSAL_VOTE_ALLOWANCE : normalizeProposalVoteAllowance(parsed.proposalVoteAllowance);
    const allowedModels = parsed.allowedModels === undefined ? fallbackModels : normalizeModels(parsed.allowedModels);
    const defaultModel = parsed.defaultModel === undefined ? fallbackModel : normalizeModelId(parsed.defaultModel);
    if (!allowedModels.includes(defaultModel)) throw new Error("default_model_not_allowed");
    return {
      brainstormSuggestionIntervalSeconds: seconds,
      brainstormSuggestionIntervalMs: seconds * 1000,
      agentMaxTurns,
      proposalVoteAllowance,
      allowedModels,
      defaultModel,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : null,
    };
  } catch {
    return {
      brainstormSuggestionIntervalSeconds: DEFAULT_BRAINSTORM_SUGGESTION_INTERVAL_SECONDS,
      brainstormSuggestionIntervalMs: DEFAULT_BRAINSTORM_SUGGESTION_INTERVAL_SECONDS * 1000,
      agentMaxTurns: DEFAULT_AGENT_MAX_TURNS,
      proposalVoteAllowance: DEFAULT_PROPOSAL_VOTE_ALLOWANCE,
      allowedModels: fallbackModels,
      defaultModel: fallbackModel,
      updatedAt: null,
    };
  }
}

export function saveAdminSettings(input: { brainstormSuggestionIntervalSeconds?: unknown; agentMaxTurns?: unknown; proposalVoteAllowance?: unknown; allowedModels?: unknown; defaultModel?: unknown }, now = Date.now()): AdminSettingsRecord {
  const current = adminSettings();
  const seconds = input.brainstormSuggestionIntervalSeconds === undefined ? current.brainstormSuggestionIntervalSeconds : normalizeIntervalSeconds(input.brainstormSuggestionIntervalSeconds);
  const agentMaxTurns = input.agentMaxTurns === undefined ? current.agentMaxTurns : normalizeAgentMaxTurns(input.agentMaxTurns);
  const proposalVoteAllowance = input.proposalVoteAllowance === undefined ? current.proposalVoteAllowance : normalizeProposalVoteAllowance(input.proposalVoteAllowance);
  const allowedModels = input.allowedModels === undefined ? current.allowedModels : normalizeModels(input.allowedModels);
  const defaultModel = input.defaultModel === undefined ? current.defaultModel : normalizeModelId(input.defaultModel);
  if (!allowedModels.includes(defaultModel)) throw new Error("default_model_not_allowed");
  if (assignedAgentModels().some((model) => !allowedModels.includes(model))) throw new Error("assigned_model_not_allowed");
  const record = {
    brainstormSuggestionIntervalSeconds: seconds,
    brainstormSuggestionIntervalMs: seconds * 1000,
    agentMaxTurns,
    proposalVoteAllowance,
    allowedModels,
    defaultModel,
    updatedAt: now,
  };
  writeSettingsFile(record);
  return record;
}
