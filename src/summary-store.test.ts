import { expect, test } from "bun:test";
import { normalizeRoundSnapshot, normalizeRoundSocketMessage } from "./App";
import { SqliteTeamRepository } from "./storage";
import { validateSummary } from "./feedback-summary";
import { playtestFixture } from "../test-support/summary-fixtures";

test("feedback close starts the next brainstorm without a summary gate", () => {
  const repo = new SqliteTeamRepository(":memory:");
  const { project, organiser } = playtestFixture(repo);
  const next = repo.closeFeedback(project.id, organiser.id, 1).round;
  expect(next).toEqual(expect.objectContaining({ number: 2, phase: "brainstorm" }));
  expect(next.summaryRun).toBeNull();
  expect(next.summaryMessages).toEqual([]);
  expect(next.priorFeedback?.nextIdeas).toContain("Add optional practice");
  repo.close();
});

test("previous cached summary fields still normalize safely", () => {
  const repo = new SqliteTeamRepository(":memory:");
  const { project, organiser } = playtestFixture(repo);
  const previous = repo.round(project.id, organiser.id);
  delete previous.summaryRun;
  delete previous.summaryMessages;
  delete previous.brainstormSeed;
  expect(normalizeRoundSnapshot(JSON.parse(JSON.stringify(previous))).summaryMessages).toEqual([]);
  expect(normalizeRoundSnapshot(JSON.parse(JSON.stringify(previous))).brainstormSeed).toEqual({status:"idle",error:null,attempts:0});
  expect(normalizeRoundSocketMessage({ type: "round.sync", round: previous })).toMatchObject({ round: { summaryRun: null, summaryMessages: [] } });
  repo.close();
});

test("legacy summary validator still rejects foreign references", () => {
  expect(() => validateSummary({ schemaVersion: 1, overview: "x", worked: [{ text: "Bad", feedbackIds: ["foreign"] }], needsAttention: [], suggestedUpdates: [], questions: [] }, new Set(["known"]))).toThrow();
});
