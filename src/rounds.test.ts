import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RepositoryError, SqliteTeamRepository } from "./storage";

const cleanup: string[] = [];
afterEach(() => { for (const path of cleanup.splice(0)) { rmSync(path, { force: true }); rmSync(`${path}-wal`, { force: true }); rmSync(`${path}-shm`, { force: true }); } });

function selectedProject(repository: SqliteTeamRepository) {
  const organiser = repository.accountForNostr("a".repeat(64), "npub-organiser");
  const player = repository.accountForNostr("b".repeat(64), "npub-player");
  const outsider = repository.accountForNostr("c".repeat(64), "npub-outsider");
  const created = repository.createTeam(organiser.id, "Round Crew");
  repository.redeemInvite(player.id, created.invite.secret);
  const project = repository.createProject(created.team.id, organiser.id, "Shared World");
  repository.startTemplateSelection(project.id, organiser.id);
  repository.replaceTemplateSelections(project.id, organiser.id, ["citadel-strike", "skyline-sprint"]);
  repository.replaceTemplateSelections(project.id, player.id, ["citadel-strike", "village-games"]);
  const selected = repository.closeTemplateSelection(project.id, organiser.id);
  return { organiser, player, outsider, project: selected };
}

describe("Round 1 collaboration domain", () => {
  test("creates exactly one durable Round 1 when selection finishes and restores it", () => {
    const path = join(tmpdir(), `level-up-round-${crypto.randomUUID()}.sqlite`); cleanup.push(path);
    const first = new SqliteTeamRepository(path, { now: () => 10_000, brainstormDurationSeconds: 300 });
    const { organiser, project } = selectedProject(first);
    expect(project.round).toEqual(expect.objectContaining({ number: 1, phase: "brainstorm", deadlineAt: 310_000 }));
    const roundId = project.round!.id;
    expect(first.round(project.id, organiser.id).id).toBe(roundId);
    first.close();

    const second = new SqliteTeamRepository(path, { now: () => 11_000 });
    const restored = second.accountForNostr("A".repeat(64), "npub-organiser");
    expect(second.project(project.id, restored.id).round?.id).toBe(roundId);
    expect(second.round(project.id, restored.id).number).toBe(1);
    second.close();
  });

  test("authorizes members, assigns one server order, and deduplicates client events", () => {
    let now = 20_000;
    const repository = new SqliteTeamRepository(":memory:", { now: () => now, brainstormDurationSeconds: 300 });
    const { organiser, player, outsider, project } = selectedProject(repository);
    expect(() => repository.round(project.id, outsider.id)).toThrow(RepositoryError);
    const first = repository.submitContribution(project.id, player.id, "player-event-0001", "Add a moon level");
    now += 1;
    const second = repository.submitContribution(project.id, organiser.id, "organiser-event-1", "Give everyone jetpacks");
    const replay = repository.submitContribution(project.id, player.id, "player-event-0001", "This retry body is ignored");
    expect(first.event?.sequence).toBe(1);
    expect(second.event?.sequence).toBe(2);
    expect(replay.duplicate).toBe(true);
    expect(replay.event?.sequence).toBe(1);
    expect(replay.round.contributions.map((idea) => idea.body)).toEqual(["Add a moon level", "Give everyone jetpacks"]);
    expect(() => repository.submitContribution(project.id, outsider.id, "outsider-event-1", "Nope")).toThrow("not a member");
    repository.close();
  });

  test("replays committed events after a known sequence", () => {
    const repository = new SqliteTeamRepository(":memory:", { now: () => 30_000 });
    const { organiser, player, project } = selectedProject(repository);
    repository.submitContribution(project.id, organiser.id, "event-catchup-01", "First");
    repository.submitContribution(project.id, player.id, "event-catchup-02", "Second");
    repository.submitContribution(project.id, organiser.id, "event-catchup-03", "Third");
    const caughtUp = repository.roundEvents(project.id, player.id, 1);
    expect(caughtUp.events.map((event) => event.sequence)).toEqual([2, 3]);
    expect(caughtUp.round.contributions).toHaveLength(3);
    repository.close();
  });

  test("stores screenshot-only brainstorm contributions as replayable thumbnails", () => {
    const repository = new SqliteTeamRepository(":memory:", { now: () => 35_000 });
    const { player, project } = selectedProject(repository);
    const attachment = { id: "shot-0001", kind: "image" as const, filename: "maze.png", contentType: "image/png" as const, dataUrl: "data:image/png;base64,aGk=", sizeBytes: 2 };
    const result = repository.submitContribution(project.id, player.id, "screenshot-event-1", "", undefined, [attachment]);
    expect(result.event?.contribution?.body).toBe("");
    expect(result.event?.contribution?.attachments).toEqual([attachment]);
    expect(repository.roundEvents(project.id, player.id, 0).events[0]?.contribution?.attachments).toEqual([attachment]);
    repository.close();
  });

  test("allows only organiser idempotent closure and freezes writes at proposals", () => {
    const repository = new SqliteTeamRepository(":memory:", { now: () => 40_000 });
    const { organiser, player, project } = selectedProject(repository);
    expect(() => repository.closeBrainstorm(project.id, player.id)).toThrow("Only the team organiser");
    repository.submitContribution(project.id, organiser.id, "closure-source", "Add a visible goal");
    const closed = repository.closeBrainstorm(project.id, organiser.id);
    expect(closed.round.phase).toBe("proposals");
    expect(closed.event).toEqual(expect.objectContaining({ type: "phase_changed", phase: "proposals", sequence: 2 }));
    const replay = repository.closeBrainstorm(project.id, organiser.id);
    expect(replay.duplicate).toBe(true);
    expect(replay.round.lastSequence).toBe(2);
    expect(() => repository.submitContribution(project.id, player.id, "too-late-event", "Too late")).toThrow("closed");
    repository.close();
  });

  test("closes on the server deadline and exposes the phase event to reconnecting clients", () => {
    let now = 50_000;
    const repository = new SqliteTeamRepository(":memory:", { now: () => now, brainstormDurationSeconds: 5 });
    const { organiser, player, project } = selectedProject(repository);
    repository.submitContribution(project.id, player.id, "before-deadline", "One last idea");
    now = project.round!.deadlineAt;
    const closed = repository.round(project.id, organiser.id);
    expect(closed.phase).toBe("proposals");
    expect(closed.closedAt).toBe(project.round!.deadlineAt);
    const catchUp = repository.roundEvents(project.id, player.id, 1);
    expect(catchUp.events).toEqual([expect.objectContaining({ sequence: 2, type: "phase_changed", phase: "proposals" })]);
    repository.close();
  });
});
