import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { adminSettings, saveAdminSettings } from "./admin-settings";
import { saveAgentPromptModel } from "./admin-prompts";
import { agentConfig, invocationAgentConfig } from "./feedback-agent";
import { proposalAgentConfig } from "./proposal-agent";

const roots: string[] = [];
const previous = { settings: process.env.LEVELUP_ADMIN_SETTINGS_PATH, prompts: process.env.LEVELUP_AGENT_PROMPTS_PATH, model: process.env.LEVELUP_AGENT_MODEL };

function paths() {
  const root = join(tmpdir(), `levelup-model-settings-${crypto.randomUUID()}`);
  roots.push(root);
  process.env.LEVELUP_ADMIN_SETTINGS_PATH = join(root, "admin-settings.json");
  process.env.LEVELUP_AGENT_PROMPTS_PATH = join(root, "agent-prompts.json");
  process.env.LEVELUP_AGENT_MODEL = "openai/boot-model";
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries(previous)) {
    const envKey = key === "settings" ? "LEVELUP_ADMIN_SETTINGS_PATH" : key === "prompts" ? "LEVELUP_AGENT_PROMPTS_PATH" : "LEVELUP_AGENT_MODEL";
    if (value === undefined) delete process.env[envKey]; else process.env[envKey] = value;
  }
});

test("legacy settings seed the boot model without losing loop settings", () => {
  const root = paths();
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "admin-settings.json"), JSON.stringify({ schemaVersion: 1, brainstormSuggestionIntervalSeconds: 45, agentMaxTurns: 4, updatedAt: 12 }));
  expect(adminSettings()).toMatchObject({ brainstormSuggestionIntervalSeconds: 45, agentMaxTurns: 4, proposalVoteAllowance: 5, allowedModels: ["openai/boot-model"], defaultModel: "openai/boot-model" });
});

test("persists and validates the proposal vote allowance", () => {
  paths();
  expect(saveAdminSettings({ proposalVoteAllowance: 8 }).proposalVoteAllowance).toBe(8);
  expect(adminSettings().proposalVoteAllowance).toBe(8);
  expect(() => saveAdminSettings({ proposalVoteAllowance: 0 })).toThrow("invalid_proposal_vote_allowance");
  expect(() => saveAdminSettings({ proposalVoteAllowance: 21 })).toThrow("invalid_proposal_vote_allowance");
  expect(() => saveAdminSettings({ proposalVoteAllowance: 2.5 })).toThrow("invalid_proposal_vote_allowance");
});

test("validates bounded unique provider/model IDs and protects assigned models", () => {
  paths();
  const saved = saveAdminSettings({ allowedModels: ["openai/boot-model", "anthropic/claude-test"], defaultModel: "anthropic/claude-test" });
  expect(saved.defaultModel).toBe("anthropic/claude-test");
  expect(() => saveAdminSettings({ allowedModels: [] })).toThrow("invalid_allowed_models");
  expect(() => saveAdminSettings({ allowedModels: ["bad"] })).toThrow("invalid_agent_model");
  expect(() => saveAdminSettings({ allowedModels: ["openai/same", "openai/same"] })).toThrow("duplicate_agent_model");
  expect(() => saveAdminSettings({ allowedModels: Array.from({ length: 25 }, (_, index) => `test/model-${index}`) })).toThrow("invalid_allowed_models");
  saveAgentPromptModel("proposal_generation", "openai/boot-model", saved.allowedModels);
  expect(() => saveAdminSettings({ allowedModels: ["anthropic/claude-test"] })).toThrow("assigned_model_not_allowed");
});

test("production configs resolve a fresh default or stage-specific model for every agent stage", () => {
  paths();
  const feedbackConfig = agentConfig();
  const clonedProposalConfig = proposalAgentConfig();
  saveAdminSettings({ allowedModels: ["openai/first", "openai/second"], defaultModel: "openai/first" });
  for (const stage of ["brainstorm_suggestion", "proposal_generation", "feature_build", "build_run", "game_edit", "feedback_summary"]) {
    const config = stage === "feedback_summary" ? feedbackConfig : clonedProposalConfig;
    expect(invocationAgentConfig(config, stage).model).toBe("openai/first");
  }
  saveAgentPromptModel("game_edit", "openai/second", ["openai/first", "openai/second"]);
  saveAgentPromptModel("feedback_summary", "openai/second", ["openai/first", "openai/second"]);
  expect(invocationAgentConfig(clonedProposalConfig, "game_edit").model).toBe("openai/second");
  expect(invocationAgentConfig(feedbackConfig, "feedback_summary").model).toBe("openai/second");
  saveAdminSettings({ allowedModels: ["openai/first", "openai/second"], defaultModel: "openai/second" });
  expect(invocationAgentConfig(clonedProposalConfig, "build_run").model).toBe("openai/second");
  expect(feedbackConfig.model).toBe("openai/boot-model");
  expect(clonedProposalConfig.model).toBe("openai/boot-model");
});

test("injected configs remain isolated from durable admin model settings", () => {
  paths();
  saveAdminSettings({ allowedModels: ["openai/admin"], defaultModel: "openai/admin" });
  const injected = { LEVELUP_AGENT_MODEL: "test/fixture" };
  expect(invocationAgentConfig(agentConfig({ env: injected }), "feedback_summary").model).toBe("test/fixture");
  expect(invocationAgentConfig(proposalAgentConfig({ env: injected }), "proposal_generation").model).toBe("test/fixture");
});
