import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { RepositoryError, SqliteTeamRepository } from "./storage";

function setup(now: () => number = () => 1_000_000) {
  const repository = new SqliteTeamRepository(":memory:", { now });
  const organiser = repository.accountForNostr("1".repeat(64), "npub-organiser");
  const player = repository.accountForNostr("2".repeat(64), "npub-player");
  const outsider = repository.accountForNostr("3".repeat(64), "npub-outsider");
  const created = repository.createTeam(organiser.id, "Pixel Pioneers");
  repository.redeemInvite(player.id, created.invite.secret);
  return { repository, organiser, player, outsider, team: created.team };
}

describe("project template selection domain", () => {
  test("persists Group Mode selection and isolates bulk project failures idempotently", () => {
    const {repository,organiser,team}=setup();
    const ready=repository.createProject(team.id,organiser.id,"Ready team");
    const blocked=repository.createProject(team.id,organiser.id,"Blocked team");
    const run=repository.saveGroupRun(organiser.id,{name:"Scout workshop",projectIds:[ready.id,blocked.id]});
    expect(repository.groupRun()?.selectedProjectIds).toEqual([ready.id,blocked.id]);
    const first=repository.runGroupCommand(organiser.id,"start_voting","request-12345678");
    expect(first.results).toHaveLength(2);expect(first.results.every(result=>result.status==="succeeded")).toBe(true);
    repository.closeTemplateSelection(ready.id,organiser.id);
    const partial=repository.runGroupCommand(organiser.id,"extend_voting","request-abcdefgh");
    expect(partial.results.map(result=>result.status).sort()).toEqual(["skipped","succeeded"]);
    const replay=repository.runGroupCommand(organiser.id,"extend_voting","request-abcdefgh");
    expect(replay.duplicate).toBe(true);expect(repository.groupRun()?.id).toBe(run.id);
    const later=repository.runGroupCommand(organiser.id,"close_voting","request-ijklmnop");
    expect(later.results.every(result=>result.at===partial.results[0]!.at)).toBe(true);
    expect(repository.runGroupCommand(organiser.id,"extend_voting","request-abcdefgh").results).toEqual(partial.results);
    repository.close();
  });

  test("assigns a stable non-organiser Round Captain and enforces the discretionary transition", () => {
    const {repository,organiser,player,team}=setup();const other=repository.accountForNostr("4".repeat(64),"npub-other");const invite=repository.rotateInvite(team.id,organiser.id);repository.redeemInvite(other.id,invite.secret);
    const project=repository.createProject(team.id,organiser.id,"Captain game");repository.startTemplateSelection(project.id,organiser.id);
    repository.replaceTemplateSelections(project.id,organiser.id,["citadel-strike","skyline-sprint"]);repository.closeTemplateSelection(project.id,organiser.id);
    const initial=repository.project(project.id,organiser.id);expect(initial.captain?.roundNumber).toBe(1);expect([player.id,other.id]).toContain(initial.captain!.accountId);
    expect(()=>repository.resolveTemplateTie(project.id,organiser.id,"citadel-strike")).toThrow("Round Captain");
    repository.resolveTemplateTie(project.id,initial.captain!.accountId,"citadel-strike");
    const ensure=(repository as unknown as {ensureRoundCaptain(projectId:string,roundNumber:number):{accountId:string}}).ensureRoundCaptain.bind(repository);const successorCaptain=ensure(project.id,2);
    const nonCaptain=successorCaptain.accountId===player.id?other:player;
    expect(()=>repository.startSuccessorBrainstorm(project.id,nonCaptain.id,1)).toThrow("captain");
    expect(()=>repository.startSuccessorBrainstorm(project.id,successorCaptain.accountId,1)).toThrow("Wait for Build to start");
    repository.close();
  });
  test("persists shuffled captain cycles and handles additions and removals without repeating or skipping", () => {
    const {repository,organiser,player,team}=setup();
    const database=(repository as unknown as {db:Database}).db;const project=repository.createProject(team.id,organiser.id,"Captain cycle");
    const add=(digit:string)=>{const account=repository.accountForNostr(digit.repeat(64),`npub-${digit}`);repository.redeemInvite(account.id,repository.rotateInvite(team.id,organiser.id).secret);return account;};
    const second=add("4"),third=add("5");const ensure=(repository as unknown as {ensureRoundCaptain(projectId:string,roundNumber:number):{accountId:string}}).ensureRoundCaptain.bind(repository);
    const cycle=[ensure(project.id,2).accountId,ensure(project.id,3).accountId,ensure(project.id,4).accountId];expect(new Set(cycle)).toEqual(new Set([player.id,second.id,third.id]));
    const newcomer=add("6");const next=ensure(project.id,5).accountId;expect([player.id,second.id,third.id,newcomer.id]).toContain(next);
    const assignedForSix=ensure(project.id,6).accountId;database.query("DELETE FROM team_members WHERE team_id=? AND account_id=?").run(team.id,assignedForSix);const replacement=ensure(project.id,6).accountId;expect(replacement).not.toBe(assignedForSix);
    expect(ensure(project.id,6).accountId).toBe(replacement);repository.close();
  });

  test("migrates existing captain rows into the remaining persisted cycle", () => {
    const {repository,organiser,player,team}=setup();const second=repository.accountForNostr("4".repeat(64),"npub-second");repository.redeemInvite(second.id,repository.rotateInvite(team.id,organiser.id).secret);const project=repository.createProject(team.id,organiser.id,"Legacy captains");const database=(repository as unknown as {db:Database}).db;
    database.query("DELETE FROM round_captain_cycles WHERE project_id=?").run(project.id);database.query("DELETE FROM round_captains WHERE project_id=?").run(project.id);
    database.query("INSERT INTO round_captains(project_id,round_number,account_id,assigned_at) VALUES(?,?,?,?)").run(project.id,2,player.id,1);
    const ensure=(repository as unknown as {ensureRoundCaptain(projectId:string,roundNumber:number):{accountId:string}}).ensureRoundCaptain.bind(repository);expect(ensure(project.id,3).accountId).toBe(second.id);expect([player.id,second.id]).toContain(ensure(project.id,4).accountId);repository.close();
  });

  test("excludes the configured owner as team creator and organiser from snapshots and persisted cycles", () => {
    const ownerNpub="npub-owner";const repository=new SqliteTeamRepository(":memory:",{now:()=>1_000_000,ownerNpub});
    const owner=repository.accountForNostr("1".repeat(64),ownerNpub);const first=repository.accountForNostr("2".repeat(64),"npub-first");const second=repository.accountForNostr("3".repeat(64),"npub-second");
    const created=repository.createTeam(owner.id,"Owner crew");repository.redeemInvite(first.id,created.invite.secret);repository.redeemInvite(second.id,created.invite.secret);const project=repository.createProject(created.team.id,owner.id,"Owner-free cycle");
    const ensure=(repository as unknown as {ensureRoundCaptain(projectId:string,roundNumber:number):{accountId:string}|null}).ensureRoundCaptain.bind(repository);const assignments=[ensure(project.id,1)?.accountId,ensure(project.id,2)?.accountId];
    expect(new Set(assignments)).toEqual(new Set([first.id,second.id]));expect(repository.project(project.id,owner.id).captain?.accountId).not.toBe(owner.id);
    const database=(repository as unknown as {db:Database}).db;const cycle=database.query("SELECT order_json FROM round_captain_cycles WHERE project_id=?").get(project.id) as {order_json:string};
    expect(JSON.parse(cycle.order_json)).not.toContain(owner.id);expect(database.query("SELECT 1 FROM round_captains WHERE project_id=? AND account_id=?").get(project.id,owner.id)).toBeNull();repository.close();
  });

  test("repairs a migrated owner captain from the remaining unconsumed player order", () => {
    const ownerNpub="npub-owner";const repository=new SqliteTeamRepository(":memory:",{now:()=>1_000_000,ownerNpub});const organiser=repository.accountForNostr("1".repeat(64),"npub-organiser");const owner=repository.accountForNostr("2".repeat(64),ownerNpub);const player=repository.accountForNostr("3".repeat(64),"npub-player");
    const created=repository.createTeam(organiser.id,"Migration crew");repository.redeemInvite(owner.id,created.invite.secret);repository.redeemInvite(player.id,created.invite.secret);const project=repository.createProject(created.team.id,organiser.id,"Migrated owner");const database=(repository as unknown as {db:Database}).db;
    database.query("INSERT INTO round_captains(project_id,round_number,account_id,assigned_at) VALUES(?,?,?,?)").run(project.id,2,owner.id,1);database.query("UPDATE round_captain_cycles SET cycle_number=1,order_json=?,next_index=1,updated_at=1 WHERE project_id=?").run(JSON.stringify([owner.id,player.id]),project.id);
    const ensure=(repository as unknown as {ensureRoundCaptain(projectId:string,roundNumber:number):{accountId:string}|null}).ensureRoundCaptain.bind(repository);expect(ensure(project.id,2)?.accountId).toBe(player.id);
    const cycle=database.query("SELECT order_json,next_index FROM round_captain_cycles WHERE project_id=?").get(project.id) as {order_json:string;next_index:number};expect(JSON.parse(cycle.order_json)).toEqual([player.id]);expect(cycle.next_index).toBe(1);expect(database.query("SELECT account_id FROM round_captains WHERE project_id=? AND round_number=2").get(project.id)).toEqual({account_id:player.id});repository.close();
  });

  test("uses no captain for an owner-only team while keeping owner override outside the shuffle", () => {
    const ownerNpub="npub-owner";const repository=new SqliteTeamRepository(":memory:",{now:()=>1_000_000,ownerNpub});const owner=repository.accountForNostr("1".repeat(64),ownerNpub);const created=repository.createTeam(owner.id,"Solo owner");const project=repository.createProject(created.team.id,owner.id,"No captain");const ensure=(repository as unknown as {ensureRoundCaptain(projectId:string,roundNumber:number):{accountId:string}|null}).ensureRoundCaptain.bind(repository);
    expect(ensure(project.id,2)).toBeNull();expect(repository.project(project.id,owner.id).captain).toBeNull();const database=(repository as unknown as {db:Database}).db;expect(database.query("SELECT 1 FROM round_captains WHERE project_id=?").get(project.id)).toBeNull();expect(database.query("SELECT 1 FROM round_captain_cycles WHERE project_id=?").get(project.id)).toBeNull();repository.close();
  });

  test("allows a non-owner organiser fallback without admitting an owner member", () => {
    const repository=new SqliteTeamRepository(":memory:",{now:()=>1_000_000,ownerNpub:"npub-owner"});const organiser=repository.accountForNostr("1".repeat(64),"npub-organiser");const owner=repository.accountForNostr("2".repeat(64),"npub-owner");const created=repository.createTeam(organiser.id,"Fallback crew");repository.redeemInvite(owner.id,created.invite.secret);const project=repository.createProject(created.team.id,organiser.id,"Organiser fallback");const ensure=(repository as unknown as {ensureRoundCaptain(projectId:string,roundNumber:number):{accountId:string}|null}).ensureRoundCaptain.bind(repository);
    expect(ensure(project.id,2)?.accountId).toBe(organiser.id);repository.close();
  });
  test("creates one idempotent project for an organiser and exposes it only to team members", () => {
    const { repository, organiser, player, outsider, team } = setup();
    const first = repository.createProject(team.id, organiser.id, "Moon Maze", "request-1");
    const replay = repository.createProject(team.id, organiser.id, "Ignored retry name", "request-1");
    expect(replay.id).toBe(first.id);
    expect(first.phase).toBe("selecting_template");
    expect(first.selectionStartedAt).toBe(0);
    expect(first.selectionDeadlineAt).toBe(0);
    expect(first.templates).toHaveLength(4);
    expect(first.templates.map((template) => template.id)).toEqual(["citadel-strike", "skyline-sprint", "village-games", "arcade-cabinet"]);
    expect(repository.lobby(team.id, player.id)?.projects).toEqual([expect.objectContaining({ id: first.id })]);
    expect(() => repository.project(first.id, outsider.id)).toThrow(RepositoryError);
    expect(() => repository.createProject(team.id, player.id, "Player project")).toThrow("Only the account that created this team");
    repository.close();
  });

  test("uses the team's creator account rather than a membership role to authorize project creation", () => {
    const { repository, organiser, player, team } = setup();
    const database = (repository as unknown as { db: Database }).db;
    database.query("UPDATE team_members SET role = 'organiser' WHERE team_id = ? AND account_id = ?").run(team.id, player.id);
    database.query("UPDATE team_members SET role = 'player' WHERE team_id = ? AND account_id = ?").run(team.id, organiser.id);

    expect(() => repository.createProject(team.id, player.id, "Role Escalation")).toThrow("Only the account that created this team");
    expect(repository.createProject(team.id, organiser.id, "Creator Authority").name).toBe("Creator Authority");
    repository.close();
  });

  test("requires two distinct choices and atomically replaces them with live deterministic rankings", () => {
    const { repository, organiser, player, team } = setup();
    const project = repository.createProject(team.id, organiser.id, "Neon Night");
    expect(() => repository.replaceTemplateSelections(project.id, organiser.id, ["citadel-strike", "skyline-sprint"])).toThrow("has not started voting");
    expect(() => repository.startTemplateSelection(project.id, player.id)).toThrow("Only the team organiser");
    const started = repository.startTemplateSelection(project.id, organiser.id);
    expect(started.selectionDeadlineAt - started.selectionStartedAt).toBe(176_000);
    expect(repository.startTemplateSelection(project.id, organiser.id).selectionStartedAt).toBe(started.selectionStartedAt);
    expect(() => repository.replaceTemplateSelections(project.id, organiser.id, ["citadel-strike"])).toThrow("exactly two");
    expect(() => repository.replaceTemplateSelections(project.id, organiser.id, ["citadel-strike", "citadel-strike"])).toThrow("different");
    expect(() => repository.replaceTemplateSelections(project.id, organiser.id, ["citadel-strike", "missing"])).toThrow("available gallery");

    repository.replaceTemplateSelections(project.id, organiser.id, ["citadel-strike", "skyline-sprint"]);
    repository.replaceTemplateSelections(project.id, player.id, ["citadel-strike", "village-games"]);
    const ranked = repository.project(project.id, player.id);
    expect(ranked.topThree.map(({ id, votes }) => [id, votes])).toEqual([
      ["citadel-strike", 2], ["skyline-sprint", 1], ["village-games", 1],
    ]);

    repository.replaceTemplateSelections(project.id, player.id, ["arcade-cabinet", "village-games"]);
    repository.replaceTemplateSelections(project.id, player.id, ["arcade-cabinet", "village-games"]);
    const replaced = repository.project(project.id, organiser.id);
    expect(replaced.rankings.find((item) => item.id === "citadel-strike")?.votes).toBe(1);
    expect(replaced.rankings.find((item) => item.id === "arcade-cabinet")?.votes).toBe(1);
    expect(replaced.selections.sort()).toEqual(["citadel-strike", "skyline-sprint"]);
    repository.close();
  });

  test("closes at the server deadline, rejects late changes, and advances a unique winner", () => {
    let now = 5_000_000;
    const { repository, organiser, player, team } = setup(() => now);
    const project = repository.createProject(team.id, organiser.id, "Deadline Dash");
    const started = repository.startTemplateSelection(project.id, organiser.id);
    repository.replaceTemplateSelections(project.id, organiser.id, ["citadel-strike", "skyline-sprint"]);
    repository.replaceTemplateSelections(project.id, player.id, ["citadel-strike", "village-games"]);
    now = started.selectionDeadlineAt;
    const closed = repository.project(project.id, player.id);
    expect(closed.phase).toBe("round_1_brainstorm");
    expect(closed.selectionClosedAt).toBe(started.selectionDeadlineAt);
    expect(closed.selectedTemplateId).toBe("citadel-strike");
    expect(closed.selectedTemplate?.title).toBe("First-Person Shooter — Citadel Strike");
    expect(() => repository.replaceTemplateSelections(project.id, player.id, ["arcade-cabinet", "skyline-sprint"])).toThrow("closed");
    repository.close();
  });

  test("allows organiser early closure and only the Round Captain's choice from tied leaders", () => {
    const { repository, organiser, player, team } = setup();
    const project = repository.createProject(team.id, organiser.id, "Tied Worlds");
    repository.startTemplateSelection(project.id, organiser.id);
    repository.replaceTemplateSelections(project.id, organiser.id, ["citadel-strike", "skyline-sprint"]);
    expect(() => repository.closeTemplateSelection(project.id, player.id)).toThrow("Only the team organiser");
    const tied = repository.closeTemplateSelection(project.id, organiser.id);
    expect(tied.phase).toBe("resolving_template_tie");
    expect(tied.tiedLeaderIds).toEqual(["citadel-strike", "skyline-sprint"]);
    expect(repository.closeTemplateSelection(project.id, organiser.id).phase).toBe("resolving_template_tie");
    const captain=tied.captain!;expect(captain.accountId).toBe(player.id);
    expect(() => repository.resolveTemplateTie(project.id, organiser.id, "citadel-strike")).toThrow("Round Captain");
    expect(() => repository.resolveTemplateTie(project.id, captain.accountId, "arcade-cabinet")).toThrow("tied leaders");
    const final = repository.resolveTemplateTie(project.id, captain.accountId, "skyline-sprint");
    expect(final.phase).toBe("round_1_brainstorm");
    expect(final.selectedTemplateId).toBe("skyline-sprint");
    expect(repository.resolveTemplateTie(project.id, captain.accountId, "skyline-sprint").selectedTemplateId).toBe("skyline-sprint");
    expect(() => repository.resolveTemplateTie(project.id, captain.accountId, "citadel-strike")).toThrow("final");
    repository.close();
  });

  test("persists project, votes, closure, and selected template through repository restart", () => {
    const path = join(tmpdir(), `level-up-project-${crypto.randomUUID()}.sqlite`);
    try {
      const first = new SqliteTeamRepository(path, { now: () => 8_000_000 });
      const organiser = first.accountForNostr("4".repeat(64), "npub-persistent");
      const created = first.createTeam(organiser.id, "Durable Crew");
      const player = first.accountForNostr("5".repeat(64), "npub-persistent-player");first.redeemInvite(player.id,created.invite.secret);
      const team = created.team;
      const project = first.createProject(team.id, organiser.id, "Durable Game");
      const captain=first.project(project.id,organiser.id).captain!;expect(captain.accountId).toBe(player.id);expect(captain.roundNumber).toBe(1);
      first.startTemplateSelection(project.id, organiser.id);
      first.replaceTemplateSelections(project.id, organiser.id, ["citadel-strike", "arcade-cabinet"]);
      first.closeTemplateSelection(project.id, organiser.id);
      first.resolveTemplateTie(project.id, captain.accountId, "arcade-cabinet");
      first.close();

      const second = new SqliteTeamRepository(path, { now: () => 8_001_000 });
      const restored = second.project(project.id, organiser.id);
      expect(restored.phase).toBe("round_1_brainstorm");
      expect(restored.selections).toEqual(["arcade-cabinet", "citadel-strike"]);
      expect(restored.selectedTemplateId).toBe("arcade-cabinet");
      expect(restored.captain).toEqual(captain);
      expect(second.lobby(team.id, organiser.id)?.projects).toHaveLength(1);
      second.close();
    } finally {
      rmSync(path, { force: true }); rmSync(`${path}-wal`, { force: true }); rmSync(`${path}-shm`, { force: true });
    }
  });

  test("adds new catalogue seeds to an existing database without changing saved projects or selections", () => {
    const path = join(tmpdir(), `level-up-catalogue-${crypto.randomUUID()}.sqlite`);
    try {
      const first = new SqliteTeamRepository(path, { now: () => 9_000_000 });
      const organiser = first.accountForNostr("5".repeat(64), "npub-catalogue");
      const team = first.createTeam(organiser.id, "Catalogue Crew").team;
      const project = first.createProject(team.id, organiser.id, "Saved Choice");
      first.startTemplateSelection(project.id, organiser.id);
      first.replaceTemplateSelections(project.id, organiser.id, ["citadel-strike", "arcade-cabinet"]);
      first.close();

      const raw = new Database(path, { strict: true });
      raw.query("UPDATE game_templates SET title='Old Skyline', selectable=0 WHERE id='skyline-sprint'").run();
      raw.close();

      const upgraded = new SqliteTeamRepository(path, { now: () => 9_001_000 });
      const restored = upgraded.project(project.id, organiser.id);
      expect(restored.templates).toHaveLength(4);
      expect(restored.templates.map(template => template.id)).toEqual(["citadel-strike","skyline-sprint","village-games","arcade-cabinet"]);
      expect(restored.templates.find(template => template.id === "skyline-sprint")?.title).toBe("Platformer — Skyline Sprinter");
      expect(restored.selections.sort()).toEqual(["arcade-cabinet", "citadel-strike"]);
      expect(upgraded.lobby(team.id, organiser.id)?.projects).toEqual([expect.objectContaining({ id: project.id, name: "Saved Choice" })]);
      upgraded.close();
    } finally {
      rmSync(path, { force: true }); rmSync(`${path}-wal`, { force: true }); rmSync(`${path}-shm`, { force: true });
    }
  });

  test("keeps a legacy selected project playable while hiding legacy choices",()=>{
    const {repository,organiser,team}=setup();const project=repository.createProject(team.id,organiser.id,"Legacy maze");const database=(repository as unknown as {db:Database}).db;
    database.query("UPDATE projects SET selected_template_id='maze-minotaur',phase='round_1_brainstorm' WHERE id=?").run(project.id);
    const restored=repository.project(project.id,organiser.id);expect(restored.templates).toHaveLength(4);expect(restored.templates.some(template=>template.id==="maze-minotaur")).toBe(false);expect(restored.selectedTemplate).toEqual(expect.objectContaining({id:"maze-minotaur",previewUrl:"/templates/maze-minotaur/index.html"}));repository.close();
  });
});
