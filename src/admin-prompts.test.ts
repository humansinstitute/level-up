import { afterEach, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PROMPT_INPUT_PLACEHOLDER, agentPromptRecords, renderAgentPrompt, resetAgentPrompt, saveAgentPrompt } from "./admin-prompts";

const paths: string[] = [];
const previous = process.env.LEVELUP_AGENT_PROMPTS_PATH;

afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
  if (previous === undefined) delete process.env.LEVELUP_AGENT_PROMPTS_PATH;
  else process.env.LEVELUP_AGENT_PROMPTS_PATH = previous;
});

function promptPath() {
  const path = join(tmpdir(), `level-up-prompts-${crypto.randomUUID()}`, "agent-prompts.json");
  paths.push(path.split("/agent-prompts.json")[0]!);
  process.env.LEVELUP_AGENT_PROMPTS_PATH = path;
  return path;
}

test("renders compiled defaults with frozen input JSON", () => {
  promptPath();
  const rendered = renderAgentPrompt("proposal_generation", { templateTitle: "Maze", contributions: [] });
  expect(rendered).toContain("FROZEN INPUT (quoted data):");
  expect(rendered).toContain('"templateTitle":"Maze"');
  expect(rendered).not.toContain(PROMPT_INPUT_PLACEHOLDER);
  expect(agentPromptRecords().every((prompt) => prompt.isDefault)).toBe(true);
});

test("saves, reads, and resets admin prompt overrides", () => {
  const path = promptPath();
  const custom = `Custom proposal prompt. Return JSON only and keep the Level Up bounded contract.\n${PROMPT_INPUT_PLACEHOLDER}\n${"x".repeat(120)}`;
  const saved = saveAgentPrompt("proposal_generation", custom, 1234);
  expect(saved.isDefault).toBe(false);
  expect(saved.updatedAt).toBe(1234);
  expect(readFileSync(path, "utf8")).toContain("Custom proposal prompt");
  expect(renderAgentPrompt("proposal_generation", { ok: true })).toContain('"ok":true');
  expect(resetAgentPrompt("proposal_generation").isDefault).toBe(true);
});

test("rejects prompts that remove the frozen input placeholder", () => {
  promptPath();
  expect(() => saveAgentPrompt("feedback_summary", "x".repeat(500))).toThrow("invalid_prompt_template");
  expect(() => saveAgentPrompt("unknown", `${PROMPT_INPUT_PLACEHOLDER}${"x".repeat(500)}`)).toThrow("unknown_prompt_stage");
});
