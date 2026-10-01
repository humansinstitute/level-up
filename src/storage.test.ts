import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { RepositoryError, SqliteTeamRepository } from "./storage";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("SQLite team repository", () => {
  test("rehydrates the saved Group Mode name and ordered selection and replays command outcomes idempotently", () => {
    const directory = mkdtempSync(join(tmpdir(), "level-up-group-mode-"));
    cleanup.push(directory);
    const path = join(directory, "levelup.sqlite");
    const ownerNpub = "npub-owner";
    const first = new SqliteTeamRepository(path, { ownerNpub, now: () => 10_000 });
    const owner = first.accountForNostr("9".repeat(64), ownerNpub);
    const teamThree = first.createTeam(owner.id, "Team 3").team;
    const teamTwo = first.createTeam(owner.id, "Team 2").team;
    const projectThree = first.createProject(teamThree.id, owner.id, "Team 3 game");
    const projectTwo = first.createProject(teamTwo.id, owner.id, "Team 2 game");
    first.saveGroupRun(owner.id, { name: "Pete's workshop", projectIds: [projectThree.id, projectTwo.id] });
    const original = first.runGroupCommand(owner.id, "start_voting", "group-command-one");
    const replay = first.runGroupCommand(owner.id, "start_voting", "group-command-one");
    expect(replay.duplicate).toBeTrue();
    expect(replay.results).toEqual(original.results);
    first.close();

    const fresh = new SqliteTeamRepository(path, { ownerNpub, now: () => 20_000 });
    const restored = fresh.groupRun();
    expect(restored).toMatchObject({ name: "Pete's workshop", selectedProjectIds: [projectThree.id, projectTwo.id] });
    expect([...(restored?.results ?? [])].sort((a,b)=>a.projectId.localeCompare(b.projectId))).toEqual([...original.results].sort((a,b)=>a.projectId.localeCompare(b.projectId)));
    fresh.close();
  });

  test("owner deletion cascades populated projects and teams while preserving unrelated records", () => {
    const ownerNpub="npub-owner";const repository=new SqliteTeamRepository(":memory:",{ownerNpub});
    const owner=repository.accountForNostr("0".repeat(64),ownerNpub);const organiser=repository.accountForNostr("1".repeat(64),"npub-organiser");const member=repository.accountForNostr("2".repeat(64),"npub-member");
    const target=repository.createTeam(organiser.id,"Target Team");repository.redeemInvite(member.id,target.invite.secret);const project=repository.createProject(target.team.id,organiser.id,"Populated Project","populated-request");repository.startTemplateSelection(project.id,organiser.id);repository.replaceTemplateSelections(project.id,organiser.id,["citadel-strike","skyline-sprint"]);repository.closeTemplateSelection(project.id,organiser.id);
    const survivor=repository.createTeam(owner.id,"Survivor Team");const survivorProject=repository.createProject(survivor.team.id,owner.id,"Survivor Project");
    expect(()=>repository.adminDeleteProject(project.id,member.id)).toThrow();
    expect(repository.adminDeleteProject(project.id,owner.id)).toEqual({deletedProjectId:project.id,deletedTeamId:target.team.id});
    expect(repository.adminTeams().find(team=>team.id===target.team.id)?.projectCount).toBe(0);
    const second=repository.createProject(target.team.id,organiser.id,"Second Populated");
    expect(repository.adminDeleteTeam(target.team.id,owner.id)).toEqual({deletedTeamId:target.team.id,deletedProjectIds:[second.id]});
    expect(repository.adminTeams().map(team=>team.id)).toEqual([survivor.team.id]);
    expect(repository.adminProjects().map(item=>item.id)).toEqual([survivorProject.id]);
    repository.close();
  });

  test("stores only the invite hash and restores team state through a fresh instance", () => {
    const directory = mkdtempSync(join(tmpdir(), "level-up-storage-"));
    cleanup.push(directory);
    const path = join(directory, "levelup.sqlite");
    const first = new SqliteTeamRepository(path, { now: () => 1_800_000_000_000 });
    const organiser = first.accountForNostr("a".repeat(64), "npub-organiser");
    const created = first.createTeam(organiser.id, "Persistent Players");
    const expectedHash = createHash("sha256").update(created.invite.secret, "utf8").digest("hex");
    first.close();

    const raw = new Database(path, { readonly: true, strict: true });
    const inviteRow = raw.query("SELECT secret_hash FROM team_invites").get() as { secret_hash: string };
    expect(inviteRow.secret_hash).toBe(expectedHash);
    expect(inviteRow.secret_hash).not.toContain(created.invite.secret);
    raw.close();
    expect(readFileSync(path).includes(Buffer.from(created.invite.secret))).toBe(false);

    const fresh = new SqliteTeamRepository(path);
    const restoredAccount = fresh.accountForNostr("A".repeat(64), "npub-organiser");
    const restored = fresh.currentTeam(restoredAccount.id);
    expect(restored?.id).toBe(created.team.id);
    expect(restored?.members).toEqual([expect.objectContaining({ accountId: organiser.id, role: "organiser" })]);
    fresh.close();
  });

  test("retries short-code collisions and fails safely after the bounded attempt limit", () => {
    const codes = ["Same01", "Same01", "Next02"];
    const repository = new SqliteTeamRepository(":memory:", { inviteCodeGenerator: () => codes.shift() ?? "Same01" });
    const organiser = repository.accountForNostr("e".repeat(64), "npub-organiser");
    expect(repository.createTeam(organiser.id, "First short crew").invite.secret).toBe("Same01");
    expect(repository.createTeam(organiser.id, "Retry short crew").invite.secret).toBe("Next02");
    expect(() => repository.createTeam(organiser.id, "Exhausted short crew")).toThrow(expect.objectContaining({ code: "invite_namespace_exhausted" }));
    expect(repository.teamsForAccount(organiser.id).map(team => team.name)).not.toContain("Exhausted short crew");
    repository.close();
  });

  test("keeps a pre-change long hash redeemable while adding a persistent short share code", () => {
    const legacySecret = "AbCdEf0123456789_-AbCdEf0123456789_-AbCdE12";
    const repository = new SqliteTeamRepository(":memory:", { inviteCodeGenerator: () => "New123" });
    const organiser = repository.accountForNostr("f".repeat(64), "npub-organiser");
    const player = repository.accountForNostr("0".repeat(64), "npub-player");
    const created = repository.createTeam(organiser.id, "Legacy link crew");
    const database = (repository as unknown as { db: Database }).db;
    database.query("UPDATE team_invites SET secret_hash=?,short_code=NULL WHERE team_id=?").run(createHash("sha256").update(legacySecret).digest("hex"), created.team.id);
    expect(repository.activeInvite(created.team.id, organiser.id).secret).toBe("New123");
    expect(repository.redeemInvite(player.id, legacySecret).team.id).toBe(created.team.id);
    repository.close();
  });

  test("rejects expired invites with the same opaque error as unknown invites", () => {
    const directory = mkdtempSync(join(tmpdir(), "level-up-storage-"));
    cleanup.push(directory);
    const path = join(directory, "levelup.sqlite");
    const repository = new SqliteTeamRepository(path, { now: () => 2_000 });
    const organiser = repository.accountForNostr("b".repeat(64), "npub-organiser");
    const player = repository.accountForNostr("c".repeat(64), "npub-player");
    const created = repository.createTeam(organiser.id, "Clock Watchers");
    repository.close();

    const raw = new Database(path, { strict: true });
    raw.query("UPDATE team_invites SET expires_at = ?").run(1_999);
    raw.close();

    const fresh = new SqliteTeamRepository(path, { now: () => 2_000 });
    for (const secret of [created.invite.secret, "Z".repeat(43)]) {
      try {
        fresh.redeemInvite(player.id, secret);
        throw new Error("expected redemption to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(RepositoryError);
        expect((error as RepositoryError).code).toBe("invite_invalid");
        expect((error as RepositoryError).message).toBe("That invite is not valid. Ask the organiser for a fresh link.");
      }
    }
    fresh.close();
  });

  test("lists every team an account belongs to with the newest first", () => {
    let now = 1_000;
    const repository = new SqliteTeamRepository(":memory:", { now: () => now++ });
    const organiser = repository.accountForNostr("d".repeat(64), "npub-organiser");
    const first = repository.createTeam(organiser.id, "First Crew").team;
    const second = repository.createTeam(organiser.id, "Second Crew").team;

    expect(repository.teamsForAccount(organiser.id).map((team) => team.id)).toEqual([second.id, first.id]);
    repository.close();
  });
});
