import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRunPrompt, gameEditPrompt, GooseBuildRunAgent, GooseGameEditAgent } from "./build-agent";
import { agentConfig } from "./feedback-agent";
import type { BuildAdapterInput, FrozenBrief, RankedProposal } from "./loop";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixtureBinary() {
  const dir = mkdtempSync(join(tmpdir(), "levelup-fake-goose-"));
  dirs.push(dir);
  const path = join(dir, "goose");
  writeFileSync(path, `#!${process.execPath}\n` + require("node:fs").readFileSync(new URL("../test-support/fake-goose.ts", import.meta.url), "utf8"));
  chmodSync(path, 0o700);
  return path;
}

function proposal(id: string, rank: number): RankedProposal {
  return {
    id, roundId: "round", position: rank, rank, votes: 4 - rank,
    firstPlaceVotes: rank === 1 ? 1 : 0,
    secondPlaceVotes: rank === 2 ? 1 : 0,
    thirdPlaceVotes: rank === 3 ? 1 : 0,
    title: `Proposal ${rank}`,
    playerChange: `Visible player change ${rank}`,
    implementationScope: "Bounded scope for the release adapter.",
    acceptanceCriteria: ["Visible in normal play"],
    ideaReferences: [rank],
  };
}

function brief(): FrozenBrief {
  const selected = [proposal("committed", 1), proposal("stretch-one", 2), proposal("stretch-two", 3)] as [RankedProposal, RankedProposal, RankedProposal];
  return { committed: selected[0], stretch: [selected[1], selected[2]], selected, frozenAt: 100, tieBreakRule: "Vote tokens descending." };
}

function input(): BuildAdapterInput {
  return { projectId: "project_12345678", projectName: "Moon Maze", roundNumber: 1, templateTitle: "Maze", templatePreviewUrl: "/templates/maze-minotaur/index.html", previousStableUrl: null, brief: brief() };
}

const sentinel = "LEVELUP_BUILD_SECRET_NOT_REAL";
function config(binary: string, model = "test/success") {
  return { ...agentConfig({ env: { OPENROUTER_API_KEY: sentinel, LEVELUP_AGENT_MODEL: model, LEVELUP_GOOSE_BIN: binary } }), timeoutMs: 1000 };
}

test("Goose build runner accepts the canonical ready acknowledgement", async () => {
  const result = await new GooseBuildRunAgent(config(fixtureBinary())).run(input());
  expect(result).toEqual({ schemaVersion: 1, status: "ready", notes: "Frozen voted brief is ready for the release adapter." });
  expect(buildRunPrompt(input())).not.toContain(sentinel);
});

test("build and game-edit structured calls repair malformed first turns", async () => {
  expect(await new GooseBuildRunAgent(config(fixtureBinary(), "test/repair")).run(input())).toMatchObject({ status: "ready" });
  const edited = await new GooseGameEditAgent(config(fixtureBinary(), "test/repair")).edit({
    projectName: "Moon Maze", templateTitle: "Maze", version: "v2",
    sourceHtml: "<!doctype html><html><body><main><canvas></canvas><p>Ready</p></main><script>let score=0;</script></body></html>",
    proposal: proposal("committed", 1), priorImplemented: [],
  });
  expect(edited.indexHtml).toContain("Implemented Proposal 1");
});

test("Goose build runner accepts common affirmative JSON variants", async () => {
	for (const [mode, notes] of [
	  ["test/build-fenced", "Fenced acknowledgement is ready."],
	  ["test/build-ready-boolean", "Frozen voted brief is ready for the Level Up release adapter."],
	  ["test/build-approved-status", "Approved for the release adapter."],
	  ["test/build-result-wrapper", "Nested acknowledgement is ready."],
	  ["test/build-api-call", "Schema-call acknowledgement is ready."],
	  ["test/build-note-alias", "Ready with a message alias."],
	] as const) {
    const result = await new GooseBuildRunAgent(config(fixtureBinary(), mode)).run(input());
    expect(result).toEqual({ schemaVersion: 1, status: "ready", notes });
  }
});

test("Goose build runner rejects negative or unsafe build acknowledgements", async () => {
  for (const mode of ["test/build-rejected", "test/build-ready-false", "test/build-unsafe"]) {
    await expect(new GooseBuildRunAgent(config(fixtureBinary(), mode)).run(input())).rejects.toMatchObject({ code: "invalid_output" });
  }
});

test("Goose game edit agent requires a complete playable HTML schema call", async () => {
  const result = await new GooseGameEditAgent(config(fixtureBinary(), "test/game-api-call")).edit({
    projectName: "Moon Maze",
    templateTitle: "Maze",
    version: "v2",
    sourceHtml: "<!doctype html><html><head><title>Maze</title></head><body><main><h1>Maze</h1><canvas></canvas><p id=\"s\">Ready</p></main><script>let score=0;</script></body></html>",
    proposal: proposal("committed", 1),
    priorImplemented: [],
  });
  expect(result.indexHtml).toContain("Implemented Proposal 1");
  expect(result.notes).toBe("Implemented Proposal 1.");
  expect(gameEditPrompt({ projectName: "Moon Maze", templateTitle: "Maze", version: "v2", sourceHtml: "<!doctype html><html><body><main><canvas></canvas></main><script></script></body></html>", proposal: proposal("committed", 1), priorImplemented: [] })).not.toContain(sentinel);
});

test("Goose game edit agent rejects non-implementation responses", async () => {
  await expect(new GooseGameEditAgent(config(fixtureBinary(), "test/game-rejected")).edit({
    projectName: "Moon Maze",
    templateTitle: "Maze",
    version: "v2",
    sourceHtml: "<!doctype html><html><head><title>Maze</title></head><body><main><h1>Maze</h1><canvas></canvas><p id=\"s\">Ready</p></main><script>let score=0;</script></body></html>",
    proposal: proposal("committed", 1),
    priorImplemented: [],
  })).rejects.toMatchObject({ code: "invalid_output" });
});
