import { beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentTraces, appendAgentTraceTurn, beginAgentTrace, clearAgentTracesForTests, completeAgentTrace, configureAgentTraceStore, failAgentTrace, MAX_TRACE_ITEM_BYTES, sanitizeAgentTraceValue } from "./agent-trace";
import { SqliteTeamRepository } from "./storage";

beforeEach(clearAgentTracesForTests);
function begin(prompt = "Exact compiled prompt") { return beginAgentTrace({ stage: "proposal_generation", clientName: "test", model: "test/model", maxTurns: 3, prompt, maxOutputBytes: 20_000, fields: { projectId: "project-1" } }); }

test("retains ordered turns and a distinct validated final payload", () => {
  const id = begin(); appendAgentTraceTurn(id, "first draft"); appendAgentTraceTurn(id, { answer: "second draft" });
  completeAgentTrace(id, { outputBytes: 12, inputTokens: 3, outputTokens: 4, cost: null, outputPreview: { schemaVersion: 1, proposals: [] } });
  const trace = agentTraces()[0]!;
  expect(trace.compiledInput).toEqual({ value: "Exact compiled prompt", bytes: 21, truncated: false });
  expect(trace.turns.map(({ number, value }) => ({ number, value }))).toEqual([{ number: 1, value: "first draft" }, { number: 2, value: { answer: "second draft" } }]);
  expect(trace.finalPayload?.value).toEqual({ schemaVersion: 1, proposals: [] }); expect(trace.status).toBe("succeeded");
});

test("recursively redacts secrets before retention and again on serialization", () => {
  const id = begin("Authorization: Bearer abcdefghijklmnop\nKeep this instruction");
  appendAgentTraceTurn(id, { nested: { apiKey: "provider-secret", note: "cookie=session-value" }, safe: "visible" });
  completeAgentTrace(id, { outputBytes: 1, inputTokens: null, outputTokens: null, cost: null, outputPreview: { private_key: "nope", safe: "accepted" } });
  const serialized = JSON.stringify(agentTraces()[0]); expect(serialized).not.toContain("abcdefghijklmnop"); expect(serialized).not.toContain("provider-secret"); expect(serialized).not.toContain("session-value"); expect(serialized).not.toContain("nope"); expect(serialized).toContain("visible"); expect(serialized).toContain("accepted");
  expect(sanitizeAgentTraceValue({ signedEvent: { content: "secret" } })).toEqual({ signedEvent: "[redacted]" });
});

test("labels item and total truncation, preserves empty output, and keeps failed traces recoverable", () => {
  const id = begin("p".repeat(MAX_TRACE_ITEM_BYTES + 100)); appendAgentTraceTurn(id, ""); failAgentTrace(id, "provider_error");
  const trace = agentTraces()[0]!; expect(trace.compiledInput?.truncated).toBe(true); expect(trace.turns[0]).toMatchObject({ value: "", truncated: false, number: 1 }); expect(trace.finalPayload).toBeNull(); expect(trace.transcriptTruncated).toBe(true); expect(trace.status).toBe("failed");
});

test("persists running, failed, and completed transcripts across repository reopen with filtering and newest-first ordering", () => {
  const dir = mkdtempSync(join(tmpdir(), "level-up-agent-traces-"));
  const path = join(dir, "levelup.sqlite");
  let repository = new SqliteTeamRepository(path);
  try {
    configureAgentTraceStore(repository);
    const completed = beginAgentTrace({ stage: "proposal_generation", clientName: "test", model: "test/model", maxTurns: 3, prompt: "Authorization: Bearer abcdefghijklmnop\ncompiled", maxOutputBytes: 20_000, fields: { projectId: "project-a", callbackToken: "hidden" } });
    appendAgentTraceTurn(completed, { draft: 1, apiKey: "hidden-provider-key" });
    appendAgentTraceTurn(completed, { draft: 2 });
    completeAgentTrace(completed, { outputBytes: 20, inputTokens: 11, outputTokens: 7, cost: 0.01, outputPreview: { accepted: true, privateKey: "hidden-private-key" } });
    const failed = beginAgentTrace({ stage: "game_edit", clientName: "test", model: null, maxTurns: 2, prompt: "failed prompt", maxOutputBytes: 10, fields: { projectId: "project-b" } });
    failAgentTrace(failed, "provider_error", "cookie=session-secret");
    const running = beginAgentTrace({ stage: "build_run", clientName: "test", model: null, maxTurns: 1, prompt: "running prompt", maxOutputBytes: 10, fields: { projectId: "project-a" } });
    repository.close();

    repository = new SqliteTeamRepository(path);
    configureAgentTraceStore(repository);
    const all = repository.listAgentTraces();
    expect(all.map((trace) => trace.id)).toEqual([running, failed, completed]);
    expect(all.map((trace) => trace.status)).toEqual(["running", "failed", "succeeded"]);
    expect(repository.listAgentTraces("project-a").map((trace) => trace.id)).toEqual([running, completed]);
    expect(repository.getAgentTrace(completed)?.turns.map((turn) => turn.number)).toEqual([1, 2]);
    expect(repository.getAgentTrace(completed)?.finalPayload?.value).toEqual({ accepted: true, privateKey: "[redacted]" });
    expect(JSON.stringify(all)).not.toContain("abcdefghijklmnop");
    expect(JSON.stringify(all)).not.toContain("hidden-provider-key");
    expect(JSON.stringify(all)).not.toContain("hidden-private-key");
    expect(JSON.stringify(all)).not.toContain("session-secret");
  } finally {
    repository.close();
    clearAgentTracesForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("additively migrates a legacy database with ai_runs without fabricating monitoring transcripts", () => {
  const dir = mkdtempSync(join(tmpdir(), "level-up-agent-traces-legacy-"));
  const path = join(dir, "levelup.sqlite");
  const legacy = new Database(path);
  legacy.exec("CREATE TABLE ai_runs (id TEXT PRIMARY KEY, status TEXT NOT NULL); INSERT INTO ai_runs VALUES ('legacy-summary','succeeded')");
  legacy.close();
  const repository = new SqliteTeamRepository(path);
  try {
    expect(repository.listAgentTraces()).toEqual([]);
    const raw = new Database(path, { readonly: true });
    expect(raw.query("SELECT status FROM ai_runs WHERE id='legacy-summary'").get()).toEqual({ status: "succeeded" });
    expect(raw.query("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_run_traces'").get()).toEqual({ name: "agent_run_traces" });
    raw.close();
  } finally {
    repository.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
