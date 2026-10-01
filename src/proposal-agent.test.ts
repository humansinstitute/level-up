import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brainstormSuggestionPrompt, GooseBrainstormSuggestionGenerator, GooseProposalGenerator, proposalAgentConfig, proposalPrompt, validateSuggestion } from "./proposal-agent";
import { SqliteTeamRepository } from "./storage";

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

function selectedRound(proposalGenerator?: GooseProposalGenerator) {
  const repository = new SqliteTeamRepository(":memory:", { now: () => 123_000, proposalGenerator });
  const organiser = repository.accountForNostr("1".repeat(64), "npub-organiser");
  const player = repository.accountForNostr("2".repeat(64), "npub-player");
  const created = repository.createTeam(organiser.id, "Proposal Crew");
  repository.redeemInvite(player.id, created.invite.secret);
  const project = repository.createProject(created.team.id, organiser.id, "Proposal Game");
  repository.startTemplateSelection(project.id, organiser.id);
  repository.replaceTemplateSelections(project.id, organiser.id, ["citadel-strike", "skyline-sprint"]);
  repository.replaceTemplateSelections(project.id, player.id, ["citadel-strike", "village-games"]);
  const room = repository.closeTemplateSelection(project.id, organiser.id);
  repository.submitContribution(room.id, organiser.id, "proposal-agent-idea-1", "Add moon boots");
  repository.submitContribution(room.id, player.id, "proposal-agent-idea-2", "Add crystal portals");
  return { repository, organiser, room };
}

const sentinel = "LEVELUP_PROPOSAL_SECRET_NOT_REAL";
function config(binary: string, model = "test/success") {
  return { ...proposalAgentConfig({ env: { OPENROUTER_API_KEY: sentinel, LEVELUP_AGENT_MODEL: model, LEVELUP_GOOSE_BIN: binary } }), timeoutMs: 1000 };
}

test("Goose proposal generator closes brainstorming with ACP-generated cards", async () => {
  const { repository, organiser, room } = selectedRound(new GooseProposalGenerator(config(fixtureBinary())));
  const result = await repository.closeBrainstorm(room.id, organiser.id);
  expect(result.round.phase).toBe("proposals");
  expect(result.round.proposals).toHaveLength(2);
  expect(result.round.proposals[0]).toEqual(expect.objectContaining({ title: "Agent proposal 1", ideaReferences: [1] }));
  const prompt = proposalPrompt({ templateTitle: "Maze", contributions: [], priorFeedback: null });
  expect(prompt).not.toContain(sentinel);
  expect(prompt).toContain("ordered most important first");
  expect(prompt).toContain("Do not return decision arrays");
  repository.close();
});

test("Goose proposal generator accepts canonical and schema-call version 2 output", async () => {
  for (const mode of ["test/fenced-proposal", "test/proposal-api-call"]) {
    const { repository, organiser, room } = selectedRound();
    const generator = new GooseProposalGenerator(config(fixtureBinary(), mode));
    const proposals = await generator.generate({ templateTitle: "Maze", contributions: repository.round(room.id, organiser.id).contributions, priorFeedback: null });
    expect(proposals.proposals).toHaveLength(2);
    expect(proposals.proposals[0]).toEqual(expect.objectContaining({ title: "Agent proposal 1", playerChange: "Use Maze idea 1", implementationScope: "Bounded Goose-generated scope.", ideaReferences: [1] }));
    repository.close();
  }
});

test("proposal repair keeps one Goose session and accepts a corrected later turn", async () => {
  const { repository, organiser, room } = selectedRound();
  const generator = new GooseProposalGenerator(config(fixtureBinary(), "test/repair"));
  const result = await generator.generate({ templateTitle: "Maze", contributions: repository.round(room.id, organiser.id).contributions, priorFeedback: null });
  expect(result.proposals).toHaveLength(2);
  repository.close();
});

test("proposal repair retains a truncated valid prefix and accepts only its missing suffix", async () => {
  const { repository, organiser, room } = selectedRound();
  const generator = new GooseProposalGenerator(config(fixtureBinary(), "test/proposal-truncated-continuation"));
  const result = await generator.generate({ templateTitle: "Maze", contributions: repository.round(room.id, organiser.id).contributions, priorFeedback: null });
  expect(result.proposals.map((proposal) => proposal.ideaReferences)).toEqual([[1], [2]]);
  repository.close();
});

test("proposal generation uses stage-specific timeout defaults instead of the generic structured-agent timeout", () => {
  const configured = proposalAgentConfig({ env: {
    OPENROUTER_API_KEY: sentinel,
    LEVELUP_AGENT_MODEL: "test/success",
    LEVELUP_GOOSE_BIN: fixtureBinary(),
    LEVELUP_AGENT_TIMEOUT_SECONDS: "150",
    LEVELUP_AGENT_TOTAL_TIMEOUT_SECONDS: "300",
  } });
  expect(configured.timeoutMs).toBe(180_000);
  expect(configured.totalTimeoutMs).toBe(900_000);
  expect(configured.maxOutputTokens).toBe(6_000);
});

test("proposal normalization accepts captured missing empty backlog lists and repairs captured foreign provenance", async () => {
  const { repository, organiser, room } = selectedRound();
  const input = { templateTitle: "Maze", contributions: repository.round(room.id, organiser.id).contributions, priorFeedback: null };
  const normalized = await new GooseProposalGenerator(config(fixtureBinary(), "test/proposal-missing-empty-lists")).generate(input);
  expect(normalized.proposals.every((proposal) => proposal.backlogReferences.length === 0)).toBe(true);
  const repaired = await new GooseProposalGenerator(config(fixtureBinary(), "test/proposal-repair")).generate(input);
  expect(repaired.proposals.flatMap((proposal) => proposal.ideaReferences)).toEqual([1, 2]);
  repository.close();
});

test("Goose proposal generator rejects ungrounded textual idea references", async () => {
  const { repository, organiser, room } = selectedRound();
  const generator = new GooseProposalGenerator(config(fixtureBinary(), "test/proposal-textual-refs"));
  await expect(generator.generate({ templateTitle: "Maze", contributions: repository.round(room.id, organiser.id).contributions, priorFeedback: null })).rejects.toMatchObject({ code: "invalid_output" });
  repository.close();
});

test("Goose proposal generator rejects foreign contribution references", async () => {
  const { repository, organiser, room } = selectedRound();
  const generator = new GooseProposalGenerator(config(fixtureBinary(), "test/foreign-proposal"));
  await expect(generator.generate({ templateTitle: "Maze", contributions: repository.round(room.id, organiser.id).contributions, priorFeedback: null })).rejects.toMatchObject({ code: "invalid_output" });
  repository.close();
});

test("Goose proposal validation keeps the first five priority cards and rejects unreasonable source counts", async () => {
  const { repository, organiser, room } = selectedRound();
  for (let index = 3; index <= 6; index++) repository.submitContribution(room.id, organiser.id, `proposal-agent-idea-${index}`, `Add distinct requirement ${index}`);
  const generator = new GooseProposalGenerator(config(fixtureBinary()));
  const contributions = repository.round(room.id, organiser.id).contributions;
  const capped=await generator.generate({ templateTitle: "Maze", contributions, priorFeedback: null });
  expect(capped.proposals).toHaveLength(5);
  expect(capped.contributionDecisions.find((decision)=>decision.contributionSequence===6)).toEqual(expect.objectContaining({operation:"reject",resultingCardKey:null}));
  const excessive = Array.from({ length: 51 }, (_, index) => ({ ...contributions[0]!, id: `idea-${index}`, clientEventId: `event-${index}`, sequence: index + 1, body: `Requirement ${index + 1}` }));
  await expect(generator.generate({ templateTitle: "Maze", contributions: excessive, priorFeedback: null })).rejects.toMatchObject({ code: "invalid_output" });
  repository.close();
});

test("Goose brainstorm suggester returns one short chat message", async () => {
  const { repository, organiser, room } = selectedRound();
  const contributions = repository.round(room.id, organiser.id).contributions;
  const generator = new GooseBrainstormSuggestionGenerator(config(fixtureBinary()));
  const message = await generator.suggest({ templateTitle: "Maze", contributions, priorFeedback: null, roundNumber: 1, previousSuggestions: [] });
  expect(message).toContain("clear goal");
  expect(message.length).toBeLessThanOrEqual(320);
  expect(brainstormSuggestionPrompt({ templateTitle: "Maze", contributions, priorFeedback: null, roundNumber: 1, previousSuggestions: [] })).not.toContain(sentinel);
  repository.close();
});

test("empty-room suggestion schema requires exactly two distinct starter ideas", () => {
  expect(validateSuggestion({schemaVersion:2,starterIdeas:["Add a torch that reveals hidden maze doors.","Let treasure pickups rotate one wall section."]},"seed")).toContain("1. Add a torch");
  for(const invalid of [{schemaVersion:2,starterIdeas:["Only one"]},{schemaVersion:2,starterIdeas:["Same idea","Same idea"]},{schemaVersion:1,message:"A normal nudge"}]) expect(()=>validateSuggestion(invalid,"seed")).toThrow("invalid_output");
});

test("agent prompts retain screenshot metadata without embedding image bytes", () => {
  const dataUrl = `data:image/png;base64,${"A".repeat(630_000)}`;
  const contribution = {
    id: "idea-1", roundId: "round-1", authorAccountId: "account-1", authorNpub: "npub1player",
    body: "Use this screenshot as visual direction", clientEventId: "event-1", sequence: 1, createdAt: 1,
    attachments: [{ id: "image-1", kind: "image" as const, filename: "reference.png", contentType: "image/png" as const, dataUrl, sizeBytes: 472_500 }],
  };
  const input = { templateTitle: "Maze", contributions: [contribution], priorFeedback: null };
  for (const prompt of [proposalPrompt(input), brainstormSuggestionPrompt({ ...input, roundNumber: 1, previousSuggestions: [] })]) {
    expect(prompt).not.toContain(dataUrl);
    expect(prompt).not.toContain("base64");
    expect(prompt).toContain("reference.png");
    expect(prompt).toContain('"sizeBytes":472500');
    expect(prompt).not.toContain("account-1");
    expect(prompt).not.toContain("npub1player");
    expect(prompt).not.toContain("round-1");
    expect(prompt).not.toContain("event-1");
    expect(Buffer.byteLength(prompt)).toBeLessThan(10_000);
  }
});

test("brainstorm suggestion repairs malformed structured output in the same session", async () => {
  const { repository, organiser, room } = selectedRound();
  const contributions = repository.round(room.id, organiser.id).contributions;
  const message = await new GooseBrainstormSuggestionGenerator(config(fixtureBinary(), "test/repair")).suggest({ templateTitle: "Maze", contributions, priorFeedback: null, roundNumber: 1, previousSuggestions: [] });
  expect(message).toContain("clear goal");
  repository.close();
});
