import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalPlayableBuildAdapter, releaseFile } from "./local-build-adapter";
import type { GameEditAgent, GameEditAgentInput } from "./build-agent";
import type { FrozenBrief, RankedProposal } from "./loop";

const cleanup: string[] = [];
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); });

function proposal(id: string, rank: number): RankedProposal {
  const titles = ["Crystal Gates", "Comet Trails", "Moon Keys"];
  return { id, roundId: "round", position: rank, rank, votes: 4 - rank, firstPlaceVotes: rank === 1 ? 1 : 0, secondPlaceVotes: rank === 2 ? 1 : 0, thirdPlaceVotes: rank === 3 ? 1 : 0, title: titles[rank - 1] ?? `Proposal ${rank}`, playerChange: `Add ${titles[rank - 1] ?? `change ${rank}`} during play`, implementationScope: "Small scope", acceptanceCriteria: ["Playable"], ideaReferences: [rank] };
}

function brief(): FrozenBrief {
  const selected = [proposal("committed", 1), proposal("stretch-one", 2), proposal("stretch-two", 3)] as [RankedProposal, RankedProposal, RankedProposal];
  return { committed: selected[0], stretch: [selected[1], selected[2]], selected, frozenAt: 100, tieBreakRule: "Vote tokens descending." };
}

function playableHtml(title = "Maze", color = "#d7f64a"): string {
  return `<!doctype html><html><head><title>${title}</title><style>body{margin:0}main{text-align:center}canvas{width:120px;height:120px;background:#111}</style></head><body><main><h1>${title}</h1><canvas width="120" height="120"></canvas><p id="s">Ready</p><button data-d="1,0">Move</button></main><script>const c=document.querySelector('canvas'),g=c.getContext('2d');let x=10,timer;function draw(){g.fillStyle='#111';g.fillRect(0,0,120,120);g.fillStyle='${color}';g.fillRect(x,45,24,24)}function step(){x=(x+8)%96;draw()}function start(){s.textContent='${title} running';clearInterval(timer);timer=setInterval(step,80);draw()}function move(){x=(x+16)%96;s.textContent='${title} moved';draw()}document.querySelector('[data-d]').onclick=move;addEventListener('keydown',move);start();</script></body></html>`;
}

function passingValidation() {
  return { renderedPixels: 800, changedPixels: 240, visibleTextChanged: true, visibleControls: 2, startupHooksPresent: true };
}

function buildInput(overrides: Partial<Parameters<LocalPlayableBuildAdapter["validate"]>[0]> = {}): Parameters<LocalPlayableBuildAdapter["validate"]>[0] {
  return {
    projectId: "project_12345678",
    projectName: "Moon Maze",
    roundNumber: 1,
    templateTitle: "Maze",
    templatePreviewUrl: "/templates/maze-minotaur/index.html",
    previousStableUrl: null,
    brief: brief(),
    ...overrides,
  };
}

describe("LocalPlayableBuildAdapter", () => {
  test("does not publish a deterministic fallback when the game edit agent is missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "levelup-local-build-"));
    cleanup.push(root);
    const templateRoot = join(root, "templates");
    const releaseRoot = join(root, "releases");
    mkdirSync(join(templateRoot, "maze-minotaur"), { recursive: true });
    writeFileSync(join(templateRoot, "maze-minotaur", "index.html"), playableHtml());

    const adapter = new LocalPlayableBuildAdapter({ templateRoot, releaseRoot });
    const result = await adapter.validate(buildInput());

    expect(result).toEqual(expect.objectContaining({ validated: false, includedProposalIds: [], deferredProposalIds: ["committed", "stretch-one", "stretch-two"], releaseUrl: null }));
    expect(result.failure).toContain("Game edit agent is not configured");
    expect(existsSync(join(releaseRoot, "project_12345678", "v1", "index.html"))).toBe(false);
  });

  test("uses the game edit agent to publish v2 then v3 when budget remains", async () => {
    const root = mkdtempSync(join(tmpdir(), "levelup-agent-build-"));
    cleanup.push(root);
    const templateRoot = join(root, "templates");
    const releaseRoot = join(root, "releases");
    mkdirSync(join(templateRoot, "maze-minotaur"), { recursive: true });
    writeFileSync(join(templateRoot, "maze-minotaur", "index.html"), playableHtml());
    const calls: string[] = [];
    const gameEditAgent: GameEditAgent = {
      async edit(input: GameEditAgentInput) {
        calls.push(`${input.version}:${input.proposal.id}`);
        return {
          schemaVersion: 1,
          indexHtml: playableHtml(input.proposal.title, input.version === "v2" ? "#6be3ff" : "#ff8a3d"),
          notes: `Implemented ${input.proposal.title}.`,
        };
      },
    };

    const adapter = new LocalPlayableBuildAdapter({ templateRoot, releaseRoot, gameEditAgent, playableValidator: async () => passingValidation() });
    const result = await adapter.validate(buildInput());

    expect(calls).toEqual(["v2:committed", "v3:stretch-one"]);
    expect(result).toEqual(expect.objectContaining({ validated: true, includedProposalIds: ["committed", "stretch-one"], deferredProposalIds: ["stretch-two"], releaseUrl: "/projects/project_12345678/versions/v3/", failure: null }));
    const v2 = readFileSync(join(releaseRoot, "project_12345678", "v2", "index.html"), "utf8");
    const v3 = readFileSync(join(releaseRoot, "project_12345678", "v3", "index.html"), "utf8");
    expect(v2).toContain("Crystal Gates running");
    expect(v3).toContain("Comet Trails running");
    expect(readFileSync(join(releaseRoot, "project_12345678", "v3", "manifest.json"), "utf8")).toContain("\"id\": \"stretch-one\"");
    expect(releaseFile("/projects/project_12345678/play/", releaseRoot)).toBe(join(releaseRoot, "project_12345678", "v3", "index.html"));
    expect(releaseFile("/projects/project_12345678/play/", releaseRoot, "/projects/project_12345678/versions/v2/")).toBe(join(releaseRoot, "project_12345678", "v2", "index.html"));
  });

  test("uses the previous stable release as the base for the next version", async () => {
    const root = mkdtempSync(join(tmpdir(), "levelup-agent-build-cumulative-"));
    cleanup.push(root);
    const templateRoot = join(root, "templates");
    const releaseRoot = join(root, "releases");
    mkdirSync(join(templateRoot, "maze-minotaur"), { recursive: true });
    mkdirSync(join(releaseRoot, "project_12345678", "v2"), { recursive: true });
    writeFileSync(join(templateRoot, "maze-minotaur", "index.html"), playableHtml("Template Base", "#d7f64a"));
    writeFileSync(join(releaseRoot, "project_12345678", "v2", "index.html"), playableHtml("V2 Kept Feature", "#6be3ff"));
    const sources: string[] = [];
    const gameEditAgent: GameEditAgent = {
      async edit(input: GameEditAgentInput) {
        sources.push(input.sourceHtml);
        return {
          schemaVersion: 1,
          indexHtml: input.sourceHtml.replace("</main>", `<p id="new-feature">${input.proposal.title}</p></main>`).replace("V2 Kept Feature running", "V2 Kept Feature running plus new work"),
          notes: `Extended ${input.version}.`,
        };
      },
    };

    const adapter = new LocalPlayableBuildAdapter({ templateRoot, releaseRoot, gameEditAgent, playableValidator: async () => passingValidation() });
    const result = await adapter.validate(buildInput({ roundNumber: 2, previousStableUrl: "/projects/project_12345678/versions/v2/" }));

    expect(sources[0]).toContain("V2 Kept Feature");
    expect(sources[0]).not.toContain("Template Base");
    expect(result.releaseUrl).toBe("/projects/project_12345678/versions/v4/");
    const v3 = readFileSync(join(releaseRoot, "project_12345678", "v3", "index.html"), "utf8");
    const v4 = readFileSync(join(releaseRoot, "project_12345678", "v4", "index.html"), "utf8");
    expect(v3).toContain("V2 Kept Feature");
    expect(v3).toContain("Crystal Gates");
    expect(v4).toContain("V2 Kept Feature");
    expect(v4).toContain("Crystal Gates");
    expect(v4).toContain("Comet Trails");
    expect(readFileSync(join(releaseRoot, "project_12345678", "v3", "manifest.json"), "utf8")).toContain("\"baseReleaseUrl\": \"/projects/project_12345678/versions/v2/\"");
  });

  test("keeps v2 when an optional stretch edit cannot produce v3", async () => {
    const root = mkdtempSync(join(tmpdir(), "levelup-agent-build-partial-"));
    cleanup.push(root);
    const templateRoot = join(root, "templates");
    const releaseRoot = join(root, "releases");
    mkdirSync(join(templateRoot, "maze-minotaur"), { recursive: true });
    writeFileSync(join(templateRoot, "maze-minotaur", "index.html"), playableHtml());
    const gameEditAgent: GameEditAgent = {
      async edit(input: GameEditAgentInput) {
        if (input.version === "v3") throw new Error("invalid stretch edit");
        return {
          schemaVersion: 1,
          indexHtml: playableHtml(input.proposal.title, "#6be3ff"),
          notes: "Implemented committed work.",
        };
      },
    };

    const adapter = new LocalPlayableBuildAdapter({ templateRoot, releaseRoot, gameEditAgent, playableValidator: async () => passingValidation() });
    const result = await adapter.validate(buildInput());

    expect(result).toEqual(expect.objectContaining({ validated: true, includedProposalIds: ["committed"], deferredProposalIds: ["stretch-one", "stretch-two"], releaseUrl: "/projects/project_12345678/versions/v2/", failure: null }));
    expect(existsSync(join(releaseRoot, "project_12345678", "v2", "index.html"))).toBe(true);
    expect(existsSync(join(releaseRoot, "project_12345678", "v3", "index.html"))).toBe(false);
  });

  test("does not write a release when browser validation fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "levelup-agent-build-broken-"));
    cleanup.push(root);
    const templateRoot = join(root, "templates");
    const releaseRoot = join(root, "releases");
    mkdirSync(join(templateRoot, "maze-minotaur"), { recursive: true });
    writeFileSync(join(templateRoot, "maze-minotaur", "index.html"), playableHtml());
    const gameEditAgent: GameEditAgent = { async edit() { return { schemaVersion: 1, indexHtml: playableHtml("Crystal Gates", "#6be3ff"), notes: "Implemented Crystal Gates." }; } };
    const validationError = new Error("Generated game did not draw anything into its visible canvas.");
    validationError.name = "PlayableReleaseValidationError";

    const adapter = new LocalPlayableBuildAdapter({ templateRoot, releaseRoot, gameEditAgent, playableValidator: async () => { throw validationError; } });
    await expect(adapter.validate(buildInput())).rejects.toThrow("Generated game did not draw anything");
    expect(existsSync(join(releaseRoot, "project_12345678", "v2", "index.html"))).toBe(false);
  });

  test("publishes the stable source as an immutable no-change version", async () => {
    const root = mkdtempSync(join(tmpdir(), "levelup-agent-build-no-change-"));
    cleanup.push(root);
    const templateRoot = join(root, "templates");
    const releaseRoot = join(root, "releases");
    mkdirSync(join(templateRoot, "maze-minotaur"), { recursive: true });
    const stable = playableHtml("Minotaur Maze", "#d7f64a");
    writeFileSync(join(templateRoot, "maze-minotaur", "index.html"), stable);
    const gameEditAgent: GameEditAgent = { async edit() { return { schemaVersion: 1, indexHtml: stable, notes: "The requested chase is already present." }; } };
    const adapter = new LocalPlayableBuildAdapter({ templateRoot, releaseRoot, gameEditAgent, playableValidator: async () => ({ ...passingValidation(), changedPixels: 3136, visibleTextChanged: false, materialChanged: false }) });

    const result = await adapter.validate(buildInput({ activeProposal: brief().committed }));

    expect(result).toEqual(expect.objectContaining({ validated: true, includedProposalIds: ["committed"], deferredProposalIds: [], releaseUrl: "/projects/project_12345678/versions/v2/" }));
    expect(result.featureResults).toEqual([expect.objectContaining({ proposalId: "committed", status: "no_change" })]);
    const published = readFileSync(join(releaseRoot, "project_12345678", "v2", "index.html"), "utf8");
    expect(published).toContain("Minotaur Maze running");
    const manifest = JSON.parse(readFileSync(join(releaseRoot, "project_12345678", "v2", "manifest.json"), "utf8"));
    expect(manifest).toEqual(expect.objectContaining({ schemaVersion: 2, status: "no_change", statusReason: "The feature was already present or produced no material change." }));
  });
});
