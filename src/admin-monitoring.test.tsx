import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AdminDeleteDialog, AdminPromptView, normalizeAdminPromptsPayload, normalizeAgentRunTrace } from "./App";

const base = { id: "run-1", stage: "proposal_generation", clientName: "level-up-proposals", model: "test/model", maxTurns: 3, status: "succeeded", startedAt: 10, completedAt: 20, durationMs: 10, promptBytes: 12, maxOutputBytes: 20_000, outputBytes: 20, inputTokens: 2, outputTokens: 3, cost: null, gooseSessionId: "session", errorCode: null, errorDetail: null, outputPreview: null, fields: { projectId: "project-1" } };

test("normalizes current transcripts and the immediately previous trace shape", () => {
  const current = normalizeAgentRunTrace({ ...base, compiledInput: { value: "compiled", bytes: 8, truncated: false }, turns: [{ number: 1, observedAt: 12, source: "provider", value: "draft", bytes: 5, truncated: false }], finalPayload: { value: { ok: true }, bytes: 11, truncated: false }, transcriptTruncated: false });
  expect(current).toMatchObject({ compiledInput: { value: "compiled" }, turns: [{ number: 1, value: "draft" }], finalPayload: { value: { ok: true } } });
  expect(normalizeAgentRunTrace({ ...base, outputPreview: { old: true } })).toMatchObject({ compiledInput: null, turns: [], finalPayload: null, transcriptTruncated: false });
  expect(normalizeAgentRunTrace({ ...base, id: null })).toBeNull();
});

test("renders input, every numbered turn, final payload, truncation, and legacy unavailable states", () => {
  const current = normalizeAgentRunTrace({ ...base, compiledInput: { value: "compiled", bytes: 8, truncated: false }, turns: [{ number: 1, observedAt: 12, source: "provider", value: "draft one", bytes: 9, truncated: false }, { number: 2, observedAt: 14, source: "provider", value: "draft two", bytes: 9, truncated: true }], finalPayload: { value: { accepted: true }, bytes: 17, truncated: false }, transcriptTruncated: true })!;
  const noop = () => undefined;
  const html = renderToStaticMarkup(<AdminPromptView tab="monitoring" prompts={[]} selectedId={null} draft="" settings={null} settingsDraft="30" turnsDraft="3" projects={[]} runs={[current]} selectedProjectId="" selectedRunId="run-1" busy={false} status="" onTab={noop} onSelect={noop} onDraft={noop} onSettingsDraft={noop} onTurnsDraft={noop} onSelectProject={noop} onSelectRun={noop} onRefreshRuns={noop} onSave={noop} onReset={noop} onSaveSettings={noop} />);
  expect(html).toContain("Compiled model input"); expect(html).toContain("compiled"); expect(html).toContain("Turn 1"); expect(html).toContain("draft one"); expect(html).toContain("Turn 2"); expect(html).toContain("draft two"); expect(html).toContain("Final Level Up payload"); expect(html).toContain("accepted"); expect(html).toContain("TRUNCATED");
  const legacy = normalizeAgentRunTrace(base)!;
  const legacyHtml = renderToStaticMarkup(<AdminPromptView tab="monitoring" prompts={[]} selectedId={null} draft="" settings={null} settingsDraft="30" turnsDraft="3" projects={[]} runs={[legacy]} selectedProjectId="" selectedRunId="run-1" busy={false} status="" onTab={noop} onSelect={noop} onDraft={noop} onSettingsDraft={noop} onTurnsDraft={noop} onSelectProject={noop} onSelectRun={noop} onRefreshRuns={noop} onSave={noop} onReset={noop} onSaveSettings={noop} />);
  expect(legacyHtml).toContain("Not captured for this run."); expect(legacyHtml).toContain("No model output was observed.");
});

test("renders the owner model inventory responsively without browser modal controls", () => {
  const noop = () => undefined;
  const html = renderToStaticMarkup(<AdminPromptView tab="models" prompts={[]} selectedId={null} draft="" settings={{ brainstormSuggestionIntervalSeconds: 30, brainstormSuggestionIntervalMs: 30_000, agentMaxTurns: 3, proposalVoteAllowance: 5, allowedModels: ["openai/default", "anthropic/specific"], defaultModel: "openai/default", updatedAt: null }} settingsDraft="30" turnsDraft="3" modelsDraft={"openai/default\nanthropic/specific"} defaultModelDraft="openai/default" projects={[]} runs={[]} selectedProjectId="" selectedRunId="" busy={false} status="Ready" onTab={noop} onSelect={noop} onDraft={noop} onSettingsDraft={noop} onTurnsDraft={noop} onSelectProject={noop} onSelectRun={noop} onRefreshRuns={noop} onSave={noop} onReset={noop} onSaveSettings={noop} />);
  expect(html).toContain("Allowed model IDs");
  expect(html).toContain("Default model");
  expect(html).toContain("openai/default");
  expect(html).not.toContain("window.confirm");
});

test("keeps Monitoring, Group Mode, Models, and Prompts isolated behind their selected admin tabs", () => {
  const noop = () => undefined;
  const props = { prompts: [], selectedId: null, draft: "", settings: null, settingsDraft: "30", turnsDraft: "3", projects: [], runs: [], selectedProjectId: "", selectedRunId: "", busy: false, status: "", onTab: noop, onSelect: noop, onDraft: noop, onSettingsDraft: noop, onTurnsDraft: noop, onSelectProject: noop, onSelectRun: noop, onRefreshRuns: noop, onSave: noop, onReset: noop, onSaveSettings: noop };
  const monitoring = renderToStaticMarkup(<AdminPromptView {...props} tab="monitoring" />);
  const groupMode = renderToStaticMarkup(<AdminPromptView {...props} tab="group-mode" />);
  const models = renderToStaticMarkup(<AdminPromptView {...props} tab="models" />);
  const prompts = renderToStaticMarkup(<AdminPromptView {...props} tab="prompts" />);

  for (const html of [monitoring, groupMode, models, prompts]) {
    expect(html).toContain("Monitoring");
    expect(html).toContain("Group Mode");
    expect(html).toContain("Models");
    expect(html).toContain("Prompts");
    expect((html.match(/aria-current="page"/g) ?? [])).toHaveLength(1);
  }
  expect(monitoring).toContain('id="admin-inspector-title"');
  expect(monitoring).not.toContain('id="group-mode-title"');
  expect(groupMode).toContain('id="group-mode-title"');
  expect(groupMode).not.toContain('id="admin-inspector-title"');
  expect(groupMode).toContain("Workshop name");
  expect(groupMode).toContain("Projects and preflight");
  expect(groupMode).toContain("Save &amp; preflight");
  expect(groupMode).toContain("open play (0/0)");
  expect(groupMode).toContain("start first brainstorm (0/0)");
  expect(groupMode).toContain("Pause");
  expect(models).toContain("Allowed model IDs");
  expect(models).not.toContain('id="group-mode-title"');
  expect(prompts).toContain("Round controls");
  expect(prompts).not.toContain('id="group-mode-title"');
});

test("renders named permanent admin deletion confirmations and disables repeat submission",()=>{
  const noop=()=>undefined;const project=renderToStaticMarkup(<AdminDeleteDialog target={{kind:"project",id:"project-123",name:"Moon Game",teamName:"Rocket Crew"}} busy={false} onCancel={noop} onConfirm={noop}/>);expect(project).toContain("Moon Game");expect(project).toContain("Rocket Crew");expect(project).toContain("cannot be undone");expect(project).toContain("Delete project");
  const team=renderToStaticMarkup(<AdminDeleteDialog target={{kind:"team",id:"team-12345",name:"Rocket Crew",projectCount:3}} busy onCancel={noop} onConfirm={noop}/>);expect(team).toContain("3 projects");expect(team).toContain("Deleting…");expect(team).toContain("disabled");expect(team).not.toContain("window.confirm");
});

test("accepts current and previous prompt-stage payloads and edits each stage model beside its prompt", () => {
  const noop = () => undefined;
  const record = (id: "proposal_generation" | "feature_build", label: string) => ({ id, label, stage: "Agent task", description: "Editable task prompt.", template: `Prompt ${id} {{inputJson}}`, defaultTemplate: `Prompt ${id} {{inputJson}}`, isDefault: true, updatedAt: null, modelMode: "default" as const, model: null, effectiveModel: "openai/default" });
  const previous = normalizeAdminPromptsPayload({ prompts: [record("proposal_generation", "Proposal cards")] });
  const current = normalizeAdminPromptsPayload({ prompts: [record("proposal_generation", "Proposal cards"), record("feature_build", "Feature build")] });
  expect(previous).toHaveLength(1);
  expect(current.map((prompt) => prompt.id)).toEqual(["proposal_generation", "feature_build"]);
  const html = renderToStaticMarkup(<AdminPromptView tab="prompts" prompts={current} selectedId="feature_build" draft={current[1]!.template} settings={{ brainstormSuggestionIntervalSeconds: 30, brainstormSuggestionIntervalMs: 30_000, agentMaxTurns: 3, proposalVoteAllowance: 5, allowedModels: ["openai/default", "anthropic/specific"], defaultModel: "openai/default", updatedAt: null }} settingsDraft="30" turnsDraft="3" projects={[]} runs={[]} selectedProjectId="" selectedRunId="" busy={false} status="Ready" onTab={noop} onSelect={noop} onDraft={noop} onSettingsDraft={noop} onTurnsDraft={noop} onPromptModel={noop} onSelectProject={noop} onSelectRun={noop} onRefreshRuns={noop} onSave={noop} onReset={noop} onSaveSettings={noop} />);
  expect(html).toContain("Feature build");
  expect(html).toContain("Model for this stage");
  expect(html).toContain("Effective model: openai/default");
  expect(html).toContain("Prompt template");
});
