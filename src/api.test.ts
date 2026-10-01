import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalizeEvent, generateSecretKey, nip19, type EventTemplate } from "nostr-tools";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createApp } from "./api";
import { normalizeProjectRoom, ProjectRoomView } from "./App";
import { LEVELUP_ADMIN_NPUB, PROMPT_INPUT_PLACEHOLDER } from "./admin-prompts";
import { AuthService, type SessionRecord } from "./auth";
import { SummaryError } from "./feedback-summary";
import { SqliteTeamRepository } from "./storage";
import { appendAgentTraceTurn, beginAgentTrace, clearAgentTracesForTests, completeAgentTrace, configureAgentTraceStore } from "./agent-trace";

const ORIGIN = "http://level.test";

function signer() {
  const secret = generateSecretKey();
  const signedProbe = finalizeEvent({ kind: 1, created_at: 1, tags: [], content: "" }, secret);
  return { secret, pubkey: signedProbe.pubkey, npub: nip19.npubEncode(signedProbe.pubkey) };
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`${ORIGIN}${path}`, init);
}

function testApp(allowedNpubs: string[], now: () => number = () => 1_800_000_000, accessMode: "open" | "restricted" = "restricted") {
  const auth = new AuthService({ allowedNpubs, accessMode, now, challengeTtlSeconds: 90, sessionTtlSeconds: 300 });
  const repository = new SqliteTeamRepository(":memory:", { now: () => now() * 1000, ownerNpub: allowedNpubs[0] });
  return { auth, repository, app: createApp({ auth, repository, staticRoot: "/tmp/level-up-test-static", ownerNpub: allowedNpubs[0] }) };
}

async function challenge(app: ReturnType<typeof createApp>, pubkey: string) {
  const response = await app(request("/api/auth/challenge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pubkey }),
  }));
  expect(response.status).toBe(200);
  return response.json() as Promise<{ nonce: string; expiresAt: number; event: EventTemplate }>;
}

async function signedLogin(
  app: ReturnType<typeof createApp>,
  identity: ReturnType<typeof signer>,
  issued: Awaited<ReturnType<typeof challenge>>,
) {
  const event = finalizeEvent(issued.event, identity.secret);
  return app(request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nonce: issued.nonce, pubkey: identity.pubkey, event }),
  }));
}

async function loginCookie(app: ReturnType<typeof createApp>, identity: ReturnType<typeof signer>): Promise<string> {
  const login = await signedLogin(app, identity, await challenge(app, identity.pubkey));
  expect(login.status).toBe(200);
  return login.headers.get("set-cookie")!.split(";", 1)[0]!;
}

describe("Level Up API", () => {
  test("shares bounded verified profiles only among authenticated teammates", async () => {
    const owner=signer(),member=signer(),outsider=signer();const {app,repository}=testApp([owner.npub,member.npub,outsider.npub]);
    const ownerCookie=await loginCookie(app,owner),memberCookie=await loginCookie(app,member),outsiderCookie=await loginCookie(app,outsider);
    const ownerAccount=repository.accountForNostr(owner.pubkey,owner.npub),memberAccount=repository.accountForNostr(member.pubkey,member.npub);const created=repository.createTeam(ownerAccount.id,"Profile API crew");repository.redeemInvite(memberAccount.id,created.invite.secret);
    const profileEvent=finalizeEvent({kind:0,created_at:10,tags:[],content:JSON.stringify({display_name:"Shared Player"})},member.secret);
    const stored=await app(request("/api/profiles",{method:"PUT",headers:{"Content-Type":"application/json",Cookie:memberCookie},body:JSON.stringify({events:[profileEvent]})}));
    expect(stored.status).toBe(200);expect((await stored.json()).profiles[0].displayName).toBe("Shared Player");
    const hydrated=await app(request(`/api/profiles?pubkey=${member.pubkey}`,{headers:{Cookie:ownerCookie}}));expect((await hydrated.json()).profiles[0].displayName).toBe("Shared Player");
    const hidden=await app(request(`/api/profiles?pubkey=${member.pubkey}`,{headers:{Cookie:outsiderCookie}}));expect((await hidden.json()).profiles).toEqual([]);
    const oversized=await app(request(`/api/profiles?${Array.from({length:33},(_,index)=>`pubkey=${index.toString(16).padStart(64,"0")}`).join("&")}`,{headers:{Cookie:ownerCookie}}));expect(oversized.status).toBe(400);
  });

  test("creates a project in the untimed try-games state until the organiser starts voting", async () => {
    const identity = signer();
    const { app } = testApp([identity.npub]);
    const cookie = await loginCookie(app, identity);
    const authenticated = { "Content-Type": "application/json", Cookie: cookie };

    const teamResponse = await app(request("/api/teams", {
      method: "POST",
      headers: authenticated,
      body: JSON.stringify({ name: "Fresh Crew" }),
    }));
    expect(teamResponse.status).toBe(201);
    const teamPayload = await teamResponse.json() as { team: { id: string } };

    const createResponse = await app(request(`/api/teams/${teamPayload.team.id}/projects`, {
      method: "POST",
      headers: { ...authenticated, "Idempotency-Key": "fresh-project" },
      body: JSON.stringify({ name: "Fresh Project" }),
    }));
    expect(createResponse.status).toBe(201);
    const createPayload = await createResponse.json() as { project: unknown };
    const project = normalizeProjectRoom(createPayload.project);
    expect(project.selectionStartedAt).toBe(0);
    expect(project.selectionDeadlineAt).toBe(0);

    const html = renderToStaticMarkup(createElement(ProjectRoomView, {
      project,
      draft: [],
      remaining: 0,
      busy: false,
      status: "Project created. Try the games before voting starts.",
      onChoose: () => undefined,
      onClose: () => undefined,
      onResolve: () => undefined,
    }));
    expect(html).toContain("TRY THE GAMES");
    expect(html).toContain("Try every game");
    expect(html).toContain("Start Voting");
    expect(html).not.toContain("TIME LEFT");
    expect(html).not.toContain("Live top three");
    expect(html).not.toContain("Favourite 1");
    expect(html).not.toContain("Favourite 2");
    expect(html).not.toContain("Close voting early");

    const startResponse = await app(request(`/api/projects/${project.id}/template-selection/start`, {
      method: "POST",
      headers: authenticated,
    }));
    expect(startResponse.status).toBe(200);
    const startPayload = await startResponse.json() as { project: unknown };
    const started = normalizeProjectRoom(startPayload.project);
    expect(started.selectionDeadlineAt - started.selectionStartedAt).toBe(176_000);
  });

  test("health route identifies a ready WApp", async () => {
    const { app } = testApp([]);
    const response = await app(request("/api/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, app: "level-up", status: "ready" });
    expect(response.headers.get("content-security-policy")).toContain("connect-src 'self' wss://relay.primal.net wss://nos.lol wss://purplepag.es");
    expect(response.headers.get("content-security-policy")).toContain("img-src 'self' data: https:");
  });

  test("hashed client assets are immutable while app HTML revalidates", async () => {
    const staticRoot = join(tmpdir(), `level-up-static-${crypto.randomUUID()}`);
    mkdirSync(join(staticRoot, "assets"), { recursive: true });
    writeFileSync(join(staticRoot, "assets", "index-abc123.js"), "export {};\n");
    writeFileSync(join(staticRoot, "index.html"), "<!doctype html><title>Level Up</title>");
    const { auth, repository } = testApp([]);
    const app = createApp({ auth, repository, staticRoot });
    try {
      const asset = await app(request("/assets/index-abc123.js"));
      const document = await app(request("/"));
      expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(document.headers.get("cache-control")).toBe("no-cache");
    } finally {
      repository.close();
      rmSync(staticRoot, { recursive: true, force: true });
    }
  });

  test("allows only Pete's verified session to create multiple teams", async () => {
    const repository = new SqliteTeamRepository(":memory:");
    const sessionAuth = (npub: string, pubkey: string) => ({
      readSession: () => ({ npub, pubkey, expiresAt: 1_900_000_000 }),
    }) as unknown as AuthService;
    try {
      const nonPete = createApp({ auth: sessionAuth("npub1ordinarymember", "1".repeat(64)), repository, staticRoot: "/tmp/level-up-test-static" });
      const denied = await nonPete(request("/api/teams", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Not Allowed", npub: LEVELUP_ADMIN_NPUB }) }));
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual(expect.objectContaining({ error: "forbidden", message: "New team creation is currently limited to Pete." }));
      expect(repository.teamsForAccount(repository.accountForNostr("1".repeat(64), "npub1ordinarymember").id)).toHaveLength(0);

      const pete = createApp({ auth: sessionAuth(LEVELUP_ADMIN_NPUB, "2".repeat(64)), repository, staticRoot: "/tmp/level-up-test-static" });
      for (const name of ["Pete's First Team", "Pete's Second Team"]) {
        expect((await pete(request("/api/teams", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, npub: "npub1spoofed" }) }))).status).toBe(201);
      }
      const listed = await pete(request("/api/teams"));
      expect((await listed.json()).teams.map((team: { name: string }) => team.name)).toEqual(["Pete's Second Team", "Pete's First Team"]);
    } finally {
      repository.close();
    }
  });

  test("serves generated playable project releases", async () => {
    const previous = process.env.LEVELUP_RELEASES_PATH;
    const releaseRoot = join(tmpdir(), `level-up-api-release-${crypto.randomUUID()}`);
    process.env.LEVELUP_RELEASES_PATH = releaseRoot;
    try {
      mkdirSync(join(releaseRoot, "project_12345678", "v1"), { recursive: true });
      writeFileSync(join(releaseRoot, "project_12345678", "v1", "index.html"), "<!doctype html><title>Generated</title><h1>Playable</h1>");
      const { app } = testApp([]);
      const response = await app(request("/projects/project_12345678/versions/v1/"));
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Playable");
      expect(response.headers.get("content-security-policy")).toContain("script-src 'unsafe-inline'");
    } finally {
      if (previous === undefined) delete process.env.LEVELUP_RELEASES_PATH;
      else process.env.LEVELUP_RELEASES_PATH = previous;
      rmSync(releaseRoot, { recursive: true, force: true });
    }
  });

  test("issues a server-bound challenge and accepts a valid signed login", async () => {
    const identity = signer();
    const { app } = testApp([identity.npub]);
    const issued = await challenge(app, identity.pubkey);

    expect(issued.nonce.length).toBeGreaterThan(32);
    expect(issued.expiresAt).toBe(1_800_000_090);
    expect(issued.event.tags).toContainEqual(["origin", ORIGIN]);
    expect(issued.event.tags).toContainEqual(["challenge", issued.nonce]);

    const login = await signedLogin(app, identity, issued);
    expect(login.status).toBe(200);
    expect(login.headers.get("set-cookie")).toContain("HttpOnly");
    expect(login.headers.get("set-cookie")).toContain("SameSite=Lax");
    expect(await login.json()).toEqual({ ok: true, user: { npub: identity.npub }, team: null });
  });

  test("rejects replay of a consumed challenge", async () => {
    const identity = signer();
    const { app } = testApp([identity.npub]);
    const issued = await challenge(app, identity.pubkey);
    expect((await signedLogin(app, identity, issued)).status).toBe(200);

    const replay = await signedLogin(app, identity, issued);
    expect(replay.status).toBe(401);
    expect((await replay.json()).error).toBe("challenge_unknown");
  });

  test("rejects expired and unknown challenges", async () => {
    let now = 1_800_000_000;
    const identity = signer();
    const { app } = testApp([identity.npub], () => now);
    const issued = await challenge(app, identity.pubkey);
    now += 91;
    const expired = await signedLogin(app, identity, issued);
    expect(expired.status).toBe(401);
    expect((await expired.json()).error).toBe("challenge_expired");

    const unknown = await app(request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nonce: "not-issued", pubkey: identity.pubkey, event: {} }),
    }));
    expect(unknown.status).toBe(401);
    expect((await unknown.json()).error).toBe("challenge_unknown");
  });

  test("rejects an invalid signature and consumes its challenge", async () => {
    const identity = signer();
    const { app } = testApp([identity.npub]);
    const issued = await challenge(app, identity.pubkey);
    const event = finalizeEvent(issued.event, identity.secret);
    event.sig = `${event.sig.slice(0, -1)}${event.sig.endsWith("0") ? "1" : "0"}`;
    const attempt = await app(request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nonce: issued.nonce, pubkey: identity.pubkey, event }),
    }));
    expect(attempt.status).toBe(401);
    expect((await attempt.json()).error).toBe("invalid_signature");

    const secondAttempt = await app(request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nonce: issued.nonce, pubkey: identity.pubkey, event }),
    }));
    expect((await secondAttempt.json()).error).toBe("challenge_unknown");
  });

  test("rejects malformed and altered signed events without an internal error", async () => {
    const identity = signer();
    const { app } = testApp([identity.npub]);
    const malformedChallenge = await challenge(app, identity.pubkey);
    const malformed = await app(request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nonce: malformedChallenge.nonce, pubkey: identity.pubkey, event: { pubkey: identity.pubkey } }),
    }));
    expect(malformed.status).toBe(401);
    expect((await malformed.json()).error).toBe("challenge_altered");

    const alteredChallenge = await challenge(app, identity.pubkey);
    const alteredTemplate = {
      ...alteredChallenge.event,
      tags: [...alteredChallenge.event.tags, ["extra", "not-allowed"]],
    };
    const altered = finalizeEvent(alteredTemplate, identity.secret);
    const response = await app(request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nonce: alteredChallenge.nonce, pubkey: identity.pubkey, event: altered }),
    }));
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe("challenge_altered");
  });

  test("rejects a signer mismatch before accepting a valid signature", async () => {
    const expected = signer();
    const changed = signer();
    const { app } = testApp([expected.npub, changed.npub]);
    const issued = await challenge(app, expected.pubkey);
    const event = finalizeEvent(issued.event, changed.secret);
    const response = await app(request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nonce: issued.nonce, pubkey: expected.pubkey, event }),
    }));
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe("signer_mismatch");
  });

  test("rejects a valid signer who is not allowlisted", async () => {
    const identity = signer();
    const { app } = testApp([]);
    const issued = await challenge(app, identity.pubkey);
    const response = await signedLogin(app, identity, issued);
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("access_denied");
  });

  test("defaults to open verified-signature signup when restriction mode is off", async () => {
    const identity = signer();
    const { app } = testApp([], undefined, "open");
    const response = await signedLogin(app, identity, await challenge(app, identity.pubkey));
    expect(response.status).toBe(200);
    expect((await response.json()).user.npub).toBe(identity.npub);
  });

  test("protects /api/me, accepts its session cookie, and logout invalidates it", async () => {
    const identity = signer();
    const { app } = testApp([identity.npub]);
    expect((await app(request("/api/me"))).status).toBe(401);

    const issued = await challenge(app, identity.pubkey);
    const login = await signedLogin(app, identity, issued);
    const cookie = login.headers.get("set-cookie")!.split(";", 1)[0]!;
    const authenticated = await app(request("/api/me", { headers: { Cookie: cookie } }));
    expect(authenticated.status).toBe(200);
    expect(await authenticated.json()).toEqual({ ok: true, user: { npub: identity.npub }, team: null });

    const logout = await app(request("/api/auth/logout", { method: "POST", headers: { Cookie: cookie } }));
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await app(request("/api/me", { headers: { Cookie: cookie } }))).status).toBe(401);
  });

  test("admin prompt routes require Pete's npub and persist safe overrides", async () => {
    const previous = process.env.LEVELUP_AGENT_PROMPTS_PATH;
    const promptPath = join(tmpdir(), `level-up-api-prompts-${crypto.randomUUID()}`, "agent-prompts.json");
    process.env.LEVELUP_AGENT_PROMPTS_PATH = promptPath;
    const repository = new SqliteTeamRepository(":memory:");
    const fakeAuth = (npub: string) => ({
      readSession: (): SessionRecord => ({ pubkey: "0".repeat(64), npub, expiresAt: 9_999 }),
    }) as unknown as AuthService;
    try {
      const outsider = createApp({ auth: fakeAuth("npub1notpete"), repository, staticRoot: "/tmp/level-up-test-static" });
      expect((await outsider(request("/api/admin/agent-prompts"))).status).toBe(403);

      const app = createApp({ auth: fakeAuth(LEVELUP_ADMIN_NPUB), repository, staticRoot: "/tmp/level-up-test-static" });
      const list = await app(request("/api/admin/agent-prompts"));
      expect(list.status).toBe(200);
      expect((await list.json()).prompts).toHaveLength(6);

      const template = `Owner edited brainstorm prompt. Return JSON only and keep the Level Up boundaries.\n${PROMPT_INPUT_PLACEHOLDER}\n${"x".repeat(140)}`;
      const saved = await app(request("/api/admin/agent-prompts", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stageId: "brainstorm_suggestion", template }),
      }));
      expect(saved.status).toBe(200);
      expect((await saved.json()).prompt.isDefault).toBe(false);

      const invalid = await app(request("/api/admin/agent-prompts", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stageId: "brainstorm_suggestion", template: "missing frozen input" }),
      }));
      expect(invalid.status).toBe(400);

      const reset = await app(request("/api/admin/agent-prompts", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stageId: "brainstorm_suggestion", reset: true }),
      }));
      expect(reset.status).toBe(200);
      expect((await reset.json()).prompt.isDefault).toBe(true);
    } finally {
      repository.close();
      rmSync(promptPath.split("/agent-prompts.json")[0]!, { recursive: true, force: true });
      if (previous === undefined) delete process.env.LEVELUP_AGENT_PROMPTS_PATH;
      else process.env.LEVELUP_AGENT_PROMPTS_PATH = previous;
    }
  });

  test("admin settings route saves the brainstorm loop and turn limit", async () => {
    const previous = process.env.LEVELUP_ADMIN_SETTINGS_PATH;
    const previousPrompts = process.env.LEVELUP_AGENT_PROMPTS_PATH;
    const settingsPath = join(tmpdir(), `level-up-api-settings-${crypto.randomUUID()}`, "admin-settings.json");
    process.env.LEVELUP_ADMIN_SETTINGS_PATH = settingsPath;
    process.env.LEVELUP_AGENT_PROMPTS_PATH = settingsPath.replace("admin-settings.json", "agent-prompts.json");
    const repository = new SqliteTeamRepository(":memory:");
    const fakeAuth = (npub: string) => ({
      readSession: (): SessionRecord => ({ pubkey: "0".repeat(64), npub, expiresAt: 9_999 }),
    }) as unknown as AuthService;
    let changed = 0;
    try {
      const outsider = createApp({ auth: fakeAuth("npub1notpete"), repository, staticRoot: "/tmp/level-up-test-static" });
      expect((await outsider(request("/api/admin/settings"))).status).toBe(403);

      const app = createApp({ auth: fakeAuth(LEVELUP_ADMIN_NPUB), repository, staticRoot: "/tmp/level-up-test-static", onAdminSettingsChanged: () => { changed += 1; } });
      const list = await app(request("/api/admin/settings"));
      expect(list.status).toBe(200);
      expect((await list.json()).settings).toEqual(expect.objectContaining({ brainstormSuggestionIntervalSeconds: 30, brainstormSuggestionIntervalMs: 30_000, agentMaxTurns: 3, proposalVoteAllowance: 5 }));

      const saved = await app(request("/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brainstormSuggestionIntervalSeconds: 12, agentMaxTurns: 5, proposalVoteAllowance: 8 }),
      }));
      expect(saved.status).toBe(200);
      expect((await saved.json()).settings).toEqual(expect.objectContaining({ brainstormSuggestionIntervalSeconds: 12, brainstormSuggestionIntervalMs: 12_000, agentMaxTurns: 5, proposalVoteAllowance: 8 }));
      expect(changed).toBe(1);

      const invalid = await app(request("/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brainstormSuggestionIntervalSeconds: 12, agentMaxTurns: 5, proposalVoteAllowance: 21 }),
      }));
      expect(invalid.status).toBe(400);
      expect(changed).toBe(1);
    } finally {
      repository.close();
      rmSync(settingsPath.split("/admin-settings.json")[0]!, { recursive: true, force: true });
      if (previousPrompts === undefined) delete process.env.LEVELUP_AGENT_PROMPTS_PATH;
      else process.env.LEVELUP_AGENT_PROMPTS_PATH = previousPrompts;
      if (previous === undefined) delete process.env.LEVELUP_ADMIN_SETTINGS_PATH;
      else process.env.LEVELUP_ADMIN_SETTINGS_PATH = previous;
    }
  });

  test("admin project and agent run routes require Pete's npub", async () => {
    clearAgentTracesForTests();
    const repository = new SqliteTeamRepository(":memory:");
    const fakeAuth = (npub: string) => ({
      readSession: (): SessionRecord => ({ pubkey: "0".repeat(64), npub, expiresAt: 9_999 }),
    }) as unknown as AuthService;
    try {
      const organiser = repository.accountForNostr("1".repeat(64), "npub-organiser");
      const team = repository.createTeam(organiser.id, "Admin Browse Crew").team;
      repository.createProject(team.id, organiser.id, "Inspectable Game");
      configureAgentTraceStore(repository);
      const traceId = beginAgentTrace({ stage: "proposal_generation", clientName: "test", model: "test/model", maxTurns: 3, prompt: "compiled prompt", maxOutputBytes: 1000, fields: { projectId: "project-visible", authorization: "Bearer should-not-leak" } });
      appendAgentTraceTurn(traceId, "model turn");
      completeAgentTrace(traceId, { outputBytes: 12, inputTokens: 1, outputTokens: 2, cost: null, outputPreview: { schemaVersion: 1, result: "accepted" } });

      const outsider = createApp({ auth: fakeAuth("npub1notpete"), repository, staticRoot: "/tmp/level-up-test-static" });
      expect((await outsider(request("/api/admin/projects"))).status).toBe(403);
      expect((await outsider(request("/api/admin/agent-runs"))).status).toBe(403);

      const app = createApp({ auth: fakeAuth(LEVELUP_ADMIN_NPUB), repository, staticRoot: "/tmp/level-up-test-static" });
      const projects = await app(request("/api/admin/projects"));
      expect(projects.status).toBe(200);
      expect((await projects.json()).projects).toEqual([expect.objectContaining({ name: "Inspectable Game", teamName: "Admin Browse Crew", round: null })]);

      const runs = await app(request("/api/admin/agent-runs"));
      expect(runs.status).toBe(200);
      const payload = await runs.json();
      expect(payload.runs[0]).toMatchObject({ compiledInput: { value: "compiled prompt", truncated: false }, turns: [{ number: 1, value: "model turn" }], finalPayload: { value: { schemaVersion: 1, result: "accepted" } }, fields: { authorization: "[redacted]" } });
      expect(JSON.stringify(payload)).not.toContain("should-not-leak");
    } finally {
      clearAgentTracesForTests();
      repository.close();
    }
  });

  test("admin deletion endpoints reject members and let the configured owner delete another creator's project and populated team", async () => {
    const owner=signer(),organiser=signer(),member=signer();const {app,repository}=testApp([owner.npub,organiser.npub,member.npub]);
    const ownerCookie=await loginCookie(app,owner),organiserCookie=await loginCookie(app,organiser),memberCookie=await loginCookie(app,member);
    const created=repository.createTeam(repository.accountForNostr(organiser.pubkey,organiser.npub).id,"Admin Delete Team");
    repository.redeemInvite(repository.accountForNostr(member.pubkey,member.npub).id,created.invite.secret);
    const project=repository.createProject(created.team.id,repository.accountForNostr(organiser.pubkey,organiser.npub).id,"Other Creator Project");
    expect((await app(request(`/api/admin/projects/${project.id}`,{method:"DELETE",headers:{Cookie:memberCookie}}))).status).toBe(403);
    expect((await app(request(`/api/projects/${project.id}`,{method:"DELETE",headers:{Cookie:organiserCookie}}))).status).toBe(200);
    const ownerDeleted=repository.createProject(created.team.id,repository.accountForNostr(organiser.pubkey,organiser.npub).id,"Other Creator Admin Project");
    expect((await app(request(`/api/admin/projects/${ownerDeleted.id}`,{method:"DELETE",headers:{Cookie:ownerCookie}}))).status).toBe(200);
    const populated=repository.createProject(created.team.id,repository.accountForNostr(organiser.pubkey,organiser.npub).id,"Populated Admin Project");
    repository.startTemplateSelection(populated.id,repository.accountForNostr(organiser.pubkey,organiser.npub).id);repository.replaceTemplateSelections(populated.id,repository.accountForNostr(organiser.pubkey,organiser.npub).id,["citadel-strike","skyline-sprint"]);
    expect((await app(request(`/api/admin/teams/${created.team.id}`,{method:"DELETE",headers:{Cookie:memberCookie}}))).status).toBe(403);
    const deleted=await app(request(`/api/admin/teams/${created.team.id}`,{method:"DELETE",headers:{Cookie:ownerCookie}}));expect(deleted.status).toBe(200);expect(await deleted.json()).toEqual(expect.objectContaining({deletedTeamId:created.team.id,deletedProjectIds:[populated.id]}));
    expect((await app(request("/api/admin/teams",{headers:{Cookie:ownerCookie}}))).json()).resolves.toEqual(expect.objectContaining({teams:[]}));
    repository.close();
  });

  test("creates a team, joins a second user idempotently, protects the lobby, and rejects a rotated invite", async () => {
    const organiser = signer();
    const player = signer();
    const outsider = signer();
    const { app } = testApp([organiser.npub, player.npub, outsider.npub]);
    expect((await app(request("/api/teams", { method: "POST" }))).status).toBe(401);
    expect((await app(request("/api/team-invites/redeem", { method: "POST" }))).status).toBe(401);
    const organiserCookie = await loginCookie(app, organiser);
    const playerCookie = await loginCookie(app, player);
    const outsiderCookie = await loginCookie(app, outsider);

    const createdResponse = await app(request("/api/teams", {
      method: "POST",
      headers: { Cookie: organiserCookie, "Content-Type": "application/json", "x-forwarded-proto": "https", "x-forwarded-host": "play.levelup.test" },
      body: JSON.stringify({ name: "Pixel Pioneers" }),
    }));
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json();
    expect(created.team.name).toBe("Pixel Pioneers");
    expect(created.team.members).toHaveLength(1);
    expect(created.team.members[0].role).toBe("organiser");
    expect(created.invite.secret).toMatch(/^[A-Za-z0-9]{6}$/);
    expect(created.invite.url).toBe(`https://play.levelup.test/#join=${created.invite.secret}`);
    const reloadedLobby = await app(request(`/api/teams/${created.team.id}/lobby`, { headers: { Cookie: organiserCookie, "x-forwarded-proto": "https", "x-forwarded-host": "play.levelup.test" } }));
    const reloadedLobbyBody = await reloadedLobby.json() as { invite: { secret: string; url: string; expiresAt: string | null } };
    expect(reloadedLobbyBody.invite).toEqual({ secret: created.invite.secret, url: created.invite.url, expiresAt: null });

    const forbidden = await app(request(`/api/teams/${created.team.id}/lobby`, { headers: { Cookie: outsiderCookie } }));
    expect(forbidden.status).toBe(403);

    const join = await app(request("/api/team-invites/redeem", {
      method: "POST", headers: { Cookie: playerCookie, "Content-Type": "application/json" }, body: JSON.stringify({ secret: created.invite.secret }),
    }));
    expect(join.status).toBe(200);
    expect((await join.json()).alreadyMember).toBe(false);

    const repeated = await app(request("/api/team-invites/redeem", {
      method: "POST", headers: { Cookie: playerCookie, "Content-Type": "application/json" }, body: JSON.stringify({ secret: created.invite.secret }),
    }));
    const repeatedBody = await repeated.json();
    expect(repeatedBody.alreadyMember).toBe(true);
    expect(repeatedBody.team.members).toHaveLength(2);

    const rotate = await app(request(`/api/teams/${created.team.id}/invites/rotate`, {
      method: "POST", headers: { Cookie: organiserCookie },
    }));
    expect(rotate.status).toBe(201);

    const revoked = await app(request("/api/team-invites/redeem", {
      method: "POST", headers: { Cookie: outsiderCookie, "Content-Type": "application/json" }, body: JSON.stringify({ secret: created.invite.secret }),
    }));
    expect(revoked.status).toBe(400);
    expect((await revoked.json()).error).toBe("invite_invalid");

    const unknown = await app(request("/api/team-invites/redeem", {
      method: "POST", headers: { Cookie: outsiderCookie, "Content-Type": "application/json" }, body: JSON.stringify({ secret: "A".repeat(43) }),
    }));
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error).toBe("invite_invalid");

    const playerRotate = await app(request(`/api/teams/${created.team.id}/invites/rotate`, {
      method: "POST", headers: { Cookie: playerCookie },
    }));
    expect(playerRotate.status).toBe(403);

    const reloaded = await app(request("/api/me", { headers: { Cookie: playerCookie } }));
    expect((await reloaded.json()).team.id).toBe(created.team.id);

    const teams = await app(request("/api/teams", { headers: { Cookie: playerCookie } }));
    expect(teams.status).toBe(200);
    expect((await teams.json()).teams).toEqual([
      expect.objectContaining({ id: created.team.id, name: "Pixel Pioneers" }),
    ]);
  });

  test("excludes the configured owner from captain API snapshots while preserving owner override authorization", async () => {
    const owner=signer();const player=signer();const {app}=testApp([owner.npub,player.npub]);const ownerCookie=await loginCookie(app,owner);const playerCookie=await loginCookie(app,player);
    const created=await (await app(request("/api/teams",{method:"POST",headers:{Cookie:ownerCookie,"Content-Type":"application/json"},body:JSON.stringify({name:"Owner API crew"})}))).json();
    await app(request("/api/team-invites/redeem",{method:"POST",headers:{Cookie:playerCookie,"Content-Type":"application/json"},body:JSON.stringify({secret:created.invite.secret})}));
    const project=(await (await app(request(`/api/teams/${created.team.id}/projects`,{method:"POST",headers:{Cookie:ownerCookie,"Content-Type":"application/json"},body:JSON.stringify({name:"Owner-free API"})}))).json()).project;
    await app(request(`/api/projects/${project.id}/template-selection/start`,{method:"POST",headers:{Cookie:ownerCookie}}));
    await app(request(`/api/projects/${project.id}/template-selections`,{method:"PUT",headers:{Cookie:ownerCookie,"Content-Type":"application/json"},body:JSON.stringify({templateIds:["citadel-strike","skyline-sprint"]})}));
    await app(request(`/api/projects/${project.id}/template-selection/close`,{method:"POST",headers:{Cookie:ownerCookie}}));
    await app(request(`/api/projects/${project.id}/template-selection/resolve`,{method:"POST",headers:{Cookie:ownerCookie,"Content-Type":"application/json"},body:JSON.stringify({templateId:"citadel-strike"})}));
    const snapshot=await (await app(request(`/api/projects/${project.id}`,{headers:{Cookie:playerCookie}}))).json();expect(snapshot.project.captain).toEqual(expect.objectContaining({npub:player.npub,roundNumber:1}));expect(snapshot.project.captain.npub).not.toBe(owner.npub);
    const override=await app(request(`/api/projects/${project.id}/rounds/1/brainstorm-more`,{method:"POST",headers:{Cookie:ownerCookie}}));const overrideBody=await override.json();expect(override.status).toBe(409);expect(overrideBody.error).not.toBe("captain_required");
  });

  test("authorizes a configured owner member outside the captain cycle", async () => {
    const ownerNpub="npub-owner";const repository=new SqliteTeamRepository(":memory:",{ownerNpub});const organiser=repository.accountForNostr("1".repeat(64),"npub-organiser");const owner=repository.accountForNostr("2".repeat(64),ownerNpub);const player=repository.accountForNostr("3".repeat(64),"npub-player");const created=repository.createTeam(organiser.id,"Owner override crew");repository.redeemInvite(owner.id,created.invite.secret);repository.redeemInvite(player.id,created.invite.secret);const project=repository.createProject(created.team.id,organiser.id,"Owner override API");repository.startTemplateSelection(project.id,organiser.id);repository.replaceTemplateSelections(project.id,organiser.id,["citadel-strike","skyline-sprint"]);repository.closeTemplateSelection(project.id,organiser.id);repository.resolveTemplateTie(project.id,player.id,"citadel-strike");
    expect(repository.project(project.id,owner.id).captain?.accountId).toBe(player.id);const auth={readSession:()=>({pubkey:owner.pubkey,npub:owner.npub,expiresAt:9_999_999_999})} as unknown as AuthService;const app=createApp({auth,repository,ownerNpub,staticRoot:"/tmp/level-up-test-static"});const response=await app(request(`/api/projects/${project.id}/rounds/1/brainstorm-more`,{method:"POST"}));const body=await response.json();expect(response.status).toBe(409);expect(body.error).not.toBe("captain_required");expect(repository.project(project.id,owner.id).captain?.accountId).toBe(player.id);repository.close();
  });

  test("reserves build cancellation API authority for the configured owner",async()=>{
    const ownerNpub="npub-owner";const repository=new SqliteTeamRepository(":memory:",{ownerNpub});const organiser=repository.accountForNostr("1".repeat(64),"npub-organiser");const owner=repository.accountForNostr("2".repeat(64),ownerNpub);const created=repository.createTeam(organiser.id,"Cancellation crew");repository.redeemInvite(owner.id,created.invite.secret);const project=repository.createProject(created.team.id,organiser.id,"Owner cancellation");repository.startTemplateSelection(project.id,organiser.id);repository.replaceTemplateSelections(project.id,organiser.id,["citadel-strike","skyline-sprint"]);repository.closeTemplateSelection(project.id,organiser.id);repository.resolveTemplateTie(project.id,organiser.id,"citadel-strike");for(let index=0;index<4;index++)repository.submitContribution(project.id,organiser.id,`cancel-idea-${index}`,`Add cancellation fixture ${index}`);repository.closeBrainstorm(project.id,organiser.id);repository.beginProposalVoting(project.id,organiser.id);const proposalIds=repository.round(project.id,organiser.id).proposals.map(item=>item.id);repository.replaceProposalVotes(project.id,organiser.id,proposalIds.slice(0,3));repository.closeProposalVoting(project.id,organiser.id);
    const path=`/api/projects/${project.id}/rounds/1/build/defer`;const appFor=(account:typeof organiser)=>createApp({auth:{readSession:()=>({pubkey:account.pubkey,npub:account.npub,expiresAt:9_999_999_999})} as unknown as AuthService,repository,ownerNpub,staticRoot:"/tmp/level-up-test-static"});
    const denied=await appFor(organiser)(request(path,{method:"POST"}));expect(denied.status).toBe(403);expect(await denied.json()).toEqual(expect.objectContaining({message:"Only the Level Up owner can cancel the current build."}));
    const allowed=await appFor(owner)(request(path,{method:"POST"}));expect(allowed.status).toBe(202);repository.close();
  });

  test("authorizes project room commands through team membership and organiser role", async () => {
    const organiser = signer(); const player = signer(); const outsider = signer();
    const { app } = testApp([organiser.npub, player.npub, outsider.npub]);
    const organiserCookie = await loginCookie(app, organiser); const playerCookie = await loginCookie(app, player); const outsiderCookie = await loginCookie(app, outsider);
    const teamResponse = await app(request("/api/teams", { method: "POST", headers: { Cookie: organiserCookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: "Project Crew" }) }));
    const createdTeam = await teamResponse.json();
    await app(request("/api/team-invites/redeem", { method: "POST", headers: { Cookie: playerCookie, "Content-Type": "application/json" }, body: JSON.stringify({ secret: createdTeam.invite.secret }) }));

    const playerCreate = await app(request(`/api/teams/${createdTeam.team.id}/projects`, { method: "POST", headers: { Cookie: playerCookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: "Nope" }) }));
    expect(playerCreate.status).toBe(403);
    const create = await app(request(`/api/teams/${createdTeam.team.id}/projects`, { method: "POST", headers: { Cookie: organiserCookie, "Content-Type": "application/json", "Idempotency-Key": "api-project-1" }, body: JSON.stringify({ name: "Shared Arcade" }) }));
    expect(create.status).toBe(201);
    const project = (await create.json()).project;
    expect((await app(request(`/api/projects/${project.id}/template-selection/start`, { method: "POST", headers: { Cookie: playerCookie } }))).status).toBe(403);
    expect((await app(request(`/api/projects/${project.id}/template-selection/start`, { method: "POST", headers: { Cookie: organiserCookie } }))).status).toBe(200);
    const replay = await app(request(`/api/teams/${createdTeam.team.id}/projects`, { method: "POST", headers: { Cookie: organiserCookie, "Content-Type": "application/json", "Idempotency-Key": "api-project-1" }, body: JSON.stringify({ name: "Duplicate" }) }));
    expect((await replay.json()).project.id).toBe(project.id);
    expect((await app(request(`/api/projects/${project.id}`, { headers: { Cookie: outsiderCookie } }))).status).toBe(403);
    expect((await app(request(`/api/projects/${project.id}`, { headers: { Cookie: playerCookie } }))).status).toBe(200);

    const invalid = await app(request(`/api/projects/${project.id}/template-selections`, { method: "PUT", headers: { Cookie: playerCookie, "Content-Type": "application/json" }, body: JSON.stringify({ templateIds: ["citadel-strike"] }) }));
    expect(invalid.status).toBe(400);
    const choices = await app(request(`/api/projects/${project.id}/template-selections`, { method: "PUT", headers: { Cookie: playerCookie, "Content-Type": "application/json" }, body: JSON.stringify({ templateIds: ["citadel-strike", "skyline-sprint"] }) }));
    expect(choices.status).toBe(200);
    expect((await choices.json()).project.selections).toEqual(["citadel-strike", "skyline-sprint"]);
    expect((await app(request(`/api/projects/${project.id}/template-selection/close`, { method: "POST", headers: { Cookie: playerCookie } }))).status).toBe(403);
    expect((await app(request(`/api/projects/${project.id}`, { method: "DELETE", headers: { Cookie: outsiderCookie } }))).status).toBe(403);
    expect((await app(request(`/api/projects/${project.id}`, { method: "DELETE", headers: { Cookie: playerCookie } }))).status).toBe(403);
    const deleted = await app(request(`/api/projects/${project.id}`, { method: "DELETE", headers: { Cookie: organiserCookie } }));
    expect(deleted.status).toBe(200);
    expect((await deleted.json()).team.projects).toEqual([]);
    expect((await app(request(`/api/projects/${project.id}`, { headers: { Cookie: organiserCookie } }))).status).toBe(403);
  });

  test("exposes authorized round snapshots, idempotent contributions, catch-up, and organiser closure", async () => {
    const organiser = signer(); const player = signer(); const outsider = signer();
    const { app } = testApp([organiser.npub, player.npub, outsider.npub]);
    const organiserCookie = await loginCookie(app, organiser); const playerCookie = await loginCookie(app, player); const outsiderCookie = await loginCookie(app, outsider);
    const created = await (await app(request("/api/teams", { method: "POST", headers: { Cookie: organiserCookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: "Realtime Crew" }) }))).json();
    await app(request("/api/team-invites/redeem", { method: "POST", headers: { Cookie: playerCookie, "Content-Type": "application/json" }, body: JSON.stringify({ secret: created.invite.secret }) }));
    const project = (await (await app(request(`/api/teams/${created.team.id}/projects`, { method: "POST", headers: { Cookie: organiserCookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: "Round API" }) }))).json()).project;
    await app(request(`/api/projects/${project.id}/template-selection/start`, { method: "POST", headers: { Cookie: organiserCookie } }));
    await app(request(`/api/projects/${project.id}/template-selections`, { method: "PUT", headers: { Cookie: organiserCookie, "Content-Type": "application/json" }, body: JSON.stringify({ templateIds: ["citadel-strike", "skyline-sprint"] }) }));
    await app(request(`/api/projects/${project.id}/template-selections`, { method: "PUT", headers: { Cookie: playerCookie, "Content-Type": "application/json" }, body: JSON.stringify({ templateIds: ["citadel-strike", "village-games"] }) }));
    await app(request(`/api/projects/${project.id}/template-selection/close`, { method: "POST", headers: { Cookie: organiserCookie } }));

    expect((await app(request(`/api/projects/${project.id}/rounds/1`, { headers: { Cookie: outsiderCookie } }))).status).toBe(403);
    const contributionPath = `/api/projects/${project.id}/rounds/1/contributions`;
    const contribution = await app(request(contributionPath, { method: "POST", headers: { Cookie: playerCookie, "Content-Type": "application/json" }, body: JSON.stringify({ clientEventId: "api-client-event-1", body: "Add a secret moon room" }) }));
    expect(contribution.status).toBe(201);
    const replay = await app(request(contributionPath, { method: "POST", headers: { Cookie: playerCookie, "Content-Type": "application/json" }, body: JSON.stringify({ clientEventId: "api-client-event-1", body: "ignored retry" }) }));
    expect(replay.status).toBe(200);
    expect((await replay.json()).duplicate).toBe(true);
    expect((await app(request(contributionPath, { method: "POST", headers: { Cookie: outsiderCookie, "Content-Type": "application/json" }, body: JSON.stringify({ clientEventId: "outsider-event-1", body: "Nope" }) }))).status).toBe(403);

    const catchUp = await (await app(request(`/api/projects/${project.id}/rounds/1/events?after=0`, { headers: { Cookie: organiserCookie } }))).json();
    expect(catchUp.events).toEqual([expect.objectContaining({ sequence: 1, type: "contribution_committed" })]);
    expect((await app(request(`/api/projects/${project.id}/rounds/1/close`, { method: "POST", headers: { Cookie: playerCookie } }))).status).toBe(403);
    const closed = await (await app(request(`/api/projects/${project.id}/rounds/1/close`, { method: "POST", headers: { Cookie: organiserCookie } }))).json();
    expect(closed.round.phase).toBe("proposals");
    const closedAgain = await (await app(request(`/api/projects/${project.id}/rounds/1/close`, { method: "POST", headers: { Cookie: organiserCookie } }))).json();
    expect(closedAgain.duplicate).toBe(true);
    expect(closedAgain.round.lastSequence).toBe(2);
  });

  test("manual brainstorm close surfaces agent setup failure without generated fallback proposals", async () => {
    const organiser = signer(); const player = signer();
    const auth = new AuthService({ allowedNpubs: [organiser.npub, player.npub], accessMode: "restricted", now: () => 1_800_000_000, challengeTtlSeconds: 90, sessionTtlSeconds: 300 });
    const repository = new SqliteTeamRepository(":memory:", { now: () => 1_800_000_000_000, proposalGenerator: { generate: () => { throw new SummaryError("setup_missing_key"); } } });
    const app = createApp({ auth, repository, staticRoot: "/tmp/level-up-test-static", teamCreatorNpub: organiser.npub });
    const organiserCookie = await loginCookie(app, organiser); const playerCookie = await loginCookie(app, player);
    const created = await (await app(request("/api/teams", { method: "POST", headers: { Cookie: organiserCookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: "Agent Config Crew" }) }))).json();
    await app(request("/api/team-invites/redeem", { method: "POST", headers: { Cookie: playerCookie, "Content-Type": "application/json" }, body: JSON.stringify({ secret: created.invite.secret }) }));
    const project = (await (await app(request(`/api/teams/${created.team.id}/projects`, { method: "POST", headers: { Cookie: organiserCookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: "Agent Config Round" }) }))).json()).project;
    await app(request(`/api/projects/${project.id}/template-selection/start`, { method: "POST", headers: { Cookie: organiserCookie } }));
    await app(request(`/api/projects/${project.id}/template-selections`, { method: "PUT", headers: { Cookie: organiserCookie, "Content-Type": "application/json" }, body: JSON.stringify({ templateIds: ["citadel-strike", "skyline-sprint"] }) }));
    await app(request(`/api/projects/${project.id}/template-selections`, { method: "PUT", headers: { Cookie: playerCookie, "Content-Type": "application/json" }, body: JSON.stringify({ templateIds: ["citadel-strike", "village-games"] }) }));
    await app(request(`/api/projects/${project.id}/template-selection/close`, { method: "POST", headers: { Cookie: organiserCookie } }));
    await app(request(`/api/projects/${project.id}/rounds/1/contributions`, { method: "POST", headers: { Cookie: playerCookie, "Content-Type": "application/json" }, body: JSON.stringify({ clientEventId: "missing-key-idea-1", body: "Add a lighthouse" }) }));

    const close = await app(request(`/api/projects/${project.id}/rounds/1/close`, { method: "POST", headers: { Cookie: organiserCookie } }));
    expect(close.status).toBe(409);
    const payload = await close.json();
    expect(payload.message).toContain("OPENROUTER_API_KEY");
    const snapshot = await (await app(request(`/api/projects/${project.id}`, { headers: { Cookie: playerCookie } }))).json();
    expect(snapshot.project.round.phase).toBe("brainstorm");
    expect(snapshot.project.round.proposals).toEqual([]);
    repository.close();
  });
});
