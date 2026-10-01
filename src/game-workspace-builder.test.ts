import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import {
  featureOutputTokens,
  parseBuildStatus,
  parseWorkspaceHandoff,
  WorkspaceBuildAdapter,
  type WorkspaceCodingAgent,
} from "./game-workspace-builder";
import {
  launchPlayableReleaseBrowser,
  validateFeatureModuleContract,
} from "./playable-release-validator";
import type { BuildAdapterInput, RankedProposal } from "./loop";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function root() {
  const value = mkdtempSync(join(tmpdir(), "levelup-workspace-test-"));
  roots.push(value);
  return value;
}
function proposal(id = "feature-one"): RankedProposal {
  return {
    id,
    roundId: "round-one",
    position: 1,
    title: "Moon boots",
    playerChange: "Add moon boots",
    implementationScope: "Add a visible moon boots ability.",
    acceptanceCriteria: ["Moon boots are visible"],
    ideaReferences: [1],
    backlogReferences: [],
    rank: 1,
    votes: 5,
    firstPlaceVotes: 1,
    secondPlaceVotes: 0,
    thirdPlaceVotes: 0,
  };
}
function input(p = proposal()): BuildAdapterInput {
  return {
    projectId: "project_12345678",
    projectName: "Test game",
    roundNumber: 1,
    templateTitle: "Test",
    templatePreviewUrl: "/templates/test-game/index.html",
    previousStableUrl: null,
    brief: {
      committed: p,
      stretch: [],
      selected: [p],
      frozenAt: 1,
      tieBreakRule: "stable",
    },
    activeProposal: p,
    priorImplemented: [],
  };
}
function setup() {
  const base = root(),
    templateRoot = join(base, "templates"),
    releaseRoot = join(base, "releases"),
    snapshotRoot = join(base, "snapshots"),
    workspaceRoot = join(base, "workspaces");
  mkdirSync(join(templateRoot, "test-game"), { recursive: true });
  writeFileSync(
    join(templateRoot, "test-game", "index.html"),
    '<!doctype html><html><body><main><canvas></canvas><button>Start</button></main><script>document.querySelector("canvas").getContext("2d").fillRect(0,0,5,5)</script></body></html>',
  );
  return { templateRoot, releaseRoot, snapshotRoot, workspaceRoot };
}
describe("WorkspaceBuildAdapter", () => {
  test("uses a dedicated generous feature completion budget", () => {
    expect(featureOutputTokens({})).toBe(32_768);
    expect(
      featureOutputTokens({ LEVELUP_BUILD_MAX_OUTPUT_TOKENS: "256021" }),
    ).toBe(256_021);
    expect(() =>
      featureOutputTokens({ LEVELUP_BUILD_MAX_OUTPUT_TOKENS: "6000" }),
    ).toThrow("setup_config");
    expect(() =>
      featureOutputTokens({ LEVELUP_BUILD_MAX_OUTPUT_TOKENS: "256022" }),
    ).toThrow("setup_config");
  });
  test("extracts only marked player-safe agent status lines", () => {
    expect(
      parseBuildStatus(
        "LEVELUP_STATUS: Checking whether the jump physics preserve touch controls.\n",
      ),
    ).toBe("Checking whether the jump physics preserve touch controls.");
    expect(
      parseBuildStatus(
        "LEVELUP_STATUS: Inspecting the game first.The model returned an empty response. Please resend.",
      ),
    ).toBe("Inspecting the game first.");
    expect(
      parseBuildStatus("LEVELUP_STATUS: Running bun test with token abc"),
    ).toBeNull();
    expect(parseBuildStatus("private reasoning only")).toBeNull();
  });
  test("accepts plain and markdown-fenced completion handoffs", () => {
    const handoff =
      '{"status":"complete","notes":"Done","evidence":["tests pass"]}';
    expect(parseWorkspaceHandoff(handoff)?.status).toBe("complete");
    expect(
      parseWorkspaceHandoff(`\`\`\`json\n${handoff}\n\`\`\``)?.status,
    ).toBe("complete");
    expect(
      parseWorkspaceHandoff(`Finished.\n\`\`\`json\n${handoff}\n\`\`\``)?.notes,
    ).toBe("Done");
    expect(parseWorkspaceHandoff("Finished without a handoff")).toBeNull();
  });
  test("recursively copies a multi-file template into the isolated package", async () => {
    const paths = setup();
    mkdirSync(join(paths.templateRoot, "test-game", "assets"), {
      recursive: true,
    });
    writeFileSync(
      join(paths.templateRoot, "test-game", "assets", "cabinet.txt"),
      "three games",
    );
    let observed = "";
    const agent: WorkspaceCodingAgent = {
      async run({ workspace }) {
        observed = workspace;
        expect(
          readFileSync(join(workspace, "assets", "cabinet.txt"), "utf8"),
        ).toBe("three games");
        return {
          handoff: {
            status: "no_change",
            notes: "already present",
            evidence: ["source"],
          },
          progress: {
            providerAttempts: 1,
            meaningfulTurns: 1,
            emptyAttempts: 0,
            phase: "testing",
            lastProgressAt: 2,
            changedFiles: [],
            diagnostics: [],
            usage: { inputTokens: 1, outputTokens: 1, cost: null },
          },
        };
      },
    };
    const adapter = new WorkspaceBuildAdapter({
      templateRoot: relative(process.cwd(), paths.templateRoot),
      workspaceRoot: relative(process.cwd(), paths.workspaceRoot),
      snapshotRoot: relative(process.cwd(), paths.snapshotRoot),
      releaseRoot: relative(process.cwd(), paths.releaseRoot),
      agent,
    });
    await adapter.validate(input());
    expect(isAbsolute(observed)).toBe(true);
    expect(existsSync(join(observed, "assets", "cabinet.txt"))).toBe(true);
  });
  test("gives one feature a test-first implementation session and one independent read-only review", async () => {
    const paths = setup();
    const prompts: string[] = [],
      budgets: Array<[number, number]> = [];
    const agent: WorkspaceCodingAgent = {
      async run({
        workspace,
        prompt,
        onProgress,
        inactivityBudgetMs,
        totalBudgetMs,
      }) {
        prompts.push(prompt);
        budgets.push([inactivityBudgetMs!, totalBudgetMs!]);
        const state = join(workspace, "src", "state.ts");
        writeFileSync(
          state,
          prompts.length === 1
            ? readFileSync(state, "utf8").replace("features: []", 'features: ["moon-boots"]')
            : `${readFileSync(state, "utf8")}\n// reviewer mutation must remain disposable\n`,
        );
        onProgress({
          sessionId: "session-one",
          providerAttempts: 2,
          meaningfulTurns: 1,
          emptyAttempts: 1,
          phase: "testing",
          lastProgressAt: 2,
          changedFiles: ["src/state.ts"],
          diagnostics: [],
          usage: { inputTokens: 4, outputTokens: 5, cost: null },
        });
        return {
          handoff: {
            status: prompts.length === 1 ? "complete" : "approved",
            notes:
              prompts.length === 1 ? "Moon boots added." : "Review passed.",
            evidence: ["tests pass"],
          },
          progress: {
            sessionId: "session-one",
            providerAttempts: 2,
            meaningfulTurns: 1,
            emptyAttempts: 1,
            phase: "testing",
            lastProgressAt: 2,
            changedFiles: ["src/state.ts"],
            diagnostics: [],
            usage: { inputTokens: 4, outputTokens: 5, cost: null },
          },
        };
      },
    };
    const adapter = new WorkspaceBuildAdapter({ ...paths, agent });
    const result = await adapter.validate(input());
    expect(result.validated).toBe(true);
    expect(result.releaseUrl).toBe("/projects/project_12345678/versions/v2/");
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain(
      "feature-specific automated tests written before implementation",
    );
    expect(prompts[1]).toContain(
      "Independently review the frozen Level Up primary candidate",
    );
    expect(prompts[1]).toContain("Do not edit any file");
    expect(budgets).toEqual([
      [120_000, 900_000],
      [120_000, 600_000],
    ]);
    expect(
      readFileSync(
        join(paths.snapshotRoot, "project_12345678", "v2", "src", "state.ts"),
        "utf8",
      ),
    ).toContain("moon-boots");
    expect(
      readFileSync(
        join(paths.snapshotRoot, "project_12345678", "v2", "src", "state.ts"),
        "utf8",
      ),
    ).not.toContain("reviewer mutation");
    const manifest = readFileSync(
      join(paths.releaseRoot, "project_12345678", "v2", "manifest.json"),
      "utf8",
    );
    expect(manifest).toContain('"sourceSnapshot"');
    expect(manifest).toContain('"review": "approved"');
  });
  test("loads and executes the compiled feature module from an immutable version directory", async () => {
    const paths = setup();
    const agent: WorkspaceCodingAgent = {
      async run({ workspace }) {
        const state = join(workspace, "src", "state.ts");
        writeFileSync(
          state,
          readFileSync(state, "utf8").replace(
            "features: []",
            'features: ["moon-boots"]',
          ),
        );
        return {
          handoff: { status: "complete", notes: "done", evidence: ["state"] },
          progress: {
            providerAttempts: 1,
            meaningfulTurns: 1,
            emptyAttempts: 0,
            phase: "testing",
            lastProgressAt: 2,
            changedFiles: ["src/state.ts"],
            diagnostics: [],
            usage: { inputTokens: 1, outputTokens: 1, cost: null },
          },
        };
      },
    };
    const adapter = new WorkspaceBuildAdapter({ ...paths, agent });
    await adapter.validate(input());
    const release = join(paths.releaseRoot, "project_12345678", "v2");
    expect(readFileSync(join(release, "index.html"), "utf8")).toContain(
      'src="./assets/main.js"',
    );
    const browser = await launchPlayableReleaseBrowser();
    try {
      expect(await validateFeatureModuleContract(browser, release)).toEqual({
        featureModuleRequested: true,
        featureModuleExecuted: true,
      });
      writeFileSync(
        join(release, "index.html"),
        readFileSync(join(release, "index.html"), "utf8").replace(
          '<script type="module" src="./assets/main.js"></script>',
          "",
        ),
      );
      await expect(
        validateFeatureModuleContract(browser, release),
      ).rejects.toThrow("was not requested");
    } finally {
      await browser.close();
    }
  });
  test("rejects an unproven unchanged handoff", async () => {
    const paths = setup();
    const agent: WorkspaceCodingAgent = {
      async run() {
        return {
          handoff: {
            status: "no_change",
            notes: "Already there",
            evidence: [],
          },
          progress: {
            providerAttempts: 1,
            meaningfulTurns: 1,
            emptyAttempts: 0,
            phase: "testing",
            lastProgressAt: 2,
            changedFiles: [],
            diagnostics: [],
            usage: { inputTokens: 1, outputTokens: 1, cost: null },
          },
        };
      },
    };
    const adapter = new WorkspaceBuildAdapter({ ...paths, agent });
    const result = await adapter.validate(input());
    expect(result.validated).toBe(false);
    expect(result.failure).toBe("no_change_not_proven");
  });
  test("publishes the checked primary when independent review fails", async () => {
    const paths=setup();let calls=0;const agent:WorkspaceCodingAgent={async run({workspace}){calls++;if(calls===2)throw new Error("review_provider_timeout");const state=join(workspace,"src","state.ts");writeFileSync(state,readFileSync(state,"utf8").replace("features: []",'features: ["primary"]'));return{handoff:{status:"complete",notes:"primary",evidence:["checked"]},progress:{providerAttempts:1,meaningfulTurns:1,emptyAttempts:0,phase:"testing",lastProgressAt:2,changedFiles:[],diagnostics:[],usage:{inputTokens:1,outputTokens:1,cost:null}}};}};
    const result=await new WorkspaceBuildAdapter({...paths,agent}).validate(input());expect(result.validated).toBe(true);expect(calls).toBe(2);expect(result.featureResults?.[0]?.delivery).toMatchObject({review:"failed",selectedCandidate:"primary"});
  });
  test("runs one corrective build for changes_required and never reviews it again", async () => {
    const paths=setup();let calls=0;const agent:WorkspaceCodingAgent={async run({workspace}){calls++;const state=join(workspace,"src","state.ts");if(calls===1)writeFileSync(state,readFileSync(state,"utf8").replace("features: []",'features: ["primary"]'));if(calls===3)writeFileSync(state,readFileSync(state,"utf8").replace("primary","corrected"));return{handoff:{status:calls===2?"changes_required":"complete",notes:`call ${calls}`,evidence:calls===2?["Correct the state marker"]:["checked"]},progress:{providerAttempts:1,meaningfulTurns:1,emptyAttempts:0,phase:"testing",lastProgressAt:2,changedFiles:[],diagnostics:[],usage:{inputTokens:1,outputTokens:1,cost:null}}};}};
    const result=await new WorkspaceBuildAdapter({...paths,agent}).validate(input());expect(calls).toBe(3);expect(result.featureResults?.[0]?.delivery).toMatchObject({review:"changes_required",correction:"checked",selectedCandidate:"corrected"});expect(readFileSync(join(paths.snapshotRoot,"project_12345678","v2","src","state.ts"),"utf8")).toContain("corrected");
  });
  test("treats invalid review output as review failure and preserves the primary", async () => {
    const paths=setup();let calls=0;const agent:WorkspaceCodingAgent={async run({workspace}){calls++;const state=join(workspace,"src","state.ts");if(calls===1)writeFileSync(state,readFileSync(state,"utf8").replace("features: []",'features: ["primary"]'));return{handoff:{status:"complete",notes:"result",evidence:calls===2?[]:["checked"]},progress:{providerAttempts:1,meaningfulTurns:1,emptyAttempts:0,phase:"testing",lastProgressAt:2,changedFiles:[],diagnostics:[],usage:{inputTokens:1,outputTokens:1,cost:null}}};}};
    const result=await new WorkspaceBuildAdapter({...paths,agent}).validate(input());expect(calls).toBe(2);expect(result.featureResults?.[0]?.delivery).toMatchObject({review:"failed",selectedCandidate:"primary"});
  });
  test("falls back to the primary when the one corrective build fails", async () => {
    const paths=setup();let calls=0;const agent:WorkspaceCodingAgent={async run({workspace}){calls++;if(calls===3)throw new Error("correction_provider_failure");const state=join(workspace,"src","state.ts");if(calls===1)writeFileSync(state,readFileSync(state,"utf8").replace("features: []",'features: ["primary"]'));return{handoff:{status:calls===2?"changes_required":"complete",notes:"result",evidence:calls===2?["Fix collision"]:["checked"]},progress:{providerAttempts:1,meaningfulTurns:1,emptyAttempts:0,phase:"testing",lastProgressAt:2,changedFiles:[],diagnostics:[],usage:{inputTokens:1,outputTokens:1,cost:null}}};}};
    const result=await new WorkspaceBuildAdapter({...paths,agent}).validate(input());expect(calls).toBe(3);expect(result.validated).toBe(true);expect(result.featureResults?.[0]?.delivery).toMatchObject({correction:"failed",selectedCandidate:"primary"});
  });
  test("falls back to the frozen primary when the corrective package check fails", async () => {
    const paths=setup();let calls=0;const agent:WorkspaceCodingAgent={async run({workspace}){calls++;const state=join(workspace,"src","state.ts");if(calls===1)writeFileSync(state,readFileSync(state,"utf8").replace("features: []",'features: ["primary"]'));if(calls===3)writeFileSync(join(workspace,"package.json"),"{}");return{handoff:{status:calls===2?"changes_required":"complete",notes:"result",evidence:calls===2?["Fix package output"]:["checked"]},progress:{providerAttempts:1,meaningfulTurns:1,emptyAttempts:0,phase:"testing",lastProgressAt:2,changedFiles:[],diagnostics:[],usage:{inputTokens:1,outputTokens:1,cost:null}}};}};
    const result=await new WorkspaceBuildAdapter({...paths,agent}).validate(input());expect(calls).toBe(3);expect(result.validated).toBe(true);expect(result.featureResults?.[0]?.delivery).toMatchObject({review:"changes_required",correction:"failed",selectedCandidate:"primary",correctionFailure:"workspace_final_check_failed"});expect(readFileSync(join(paths.snapshotRoot,"project_12345678","v2","src","state.ts"),"utf8")).toContain("primary");
  });
  test("does not review or publish a primary candidate whose deterministic check fails", async () => {
    const paths=setup();let calls=0;const agent:WorkspaceCodingAgent={async run({workspace}){calls++;writeFileSync(join(workspace,"package.json"),"{}");return{handoff:{status:"complete",notes:"done",evidence:["claimed"]},progress:{providerAttempts:1,meaningfulTurns:1,emptyAttempts:0,phase:"testing",lastProgressAt:2,changedFiles:[],diagnostics:[],usage:{inputTokens:1,outputTokens:1,cost:null}}};}};
    const result=await new WorkspaceBuildAdapter({...paths,agent}).validate(input());expect(result.validated).toBe(false);expect(calls).toBe(1);expect(existsSync(join(paths.releaseRoot,"project_12345678","v2"))).toBe(false);
  });
});
