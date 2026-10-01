import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createApplication } from "./api";
import { AuthService, SESSION_COOKIE } from "./auth";
import { SqliteTeamRepository } from "./storage";
import { playtestFixture } from "../test-support/summary-fixtures";

function request(path: string, cookie = "organiser", init: RequestInit = {}) {
  return new Request(`http://level.test${path}`, { ...init, headers: { Cookie: cookie, ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers } });
}

test("HTTP Brainstorm starts the next round and structured feedback commands are gone", async () => {
  const repo = new SqliteTeamRepository(":memory:");
  const f = playtestFixture(repo);
  const auth = new AuthService({ sessionStore: repo });
  const sessionId = "organiser-session";
  repo.saveAuthSession(createHash("sha256").update(sessionId).digest("hex"), { pubkey: f.organiser.pubkey, npub: f.organiser.npub, expiresAt: Math.floor(Date.now() / 1000) + 60 });
  const app = createApplication({ repository: repo, auth }).fetch;

  const first = await app(request(`/api/projects/${f.project.id}/rounds/1/brainstorm-more`, `${SESSION_COOKIE}=${sessionId}`, { method: "POST" }));
  expect(first.status).toBe(202);
  const payload = await first.json() as any;
  expect(payload.round).toMatchObject({ number: 2, phase: "brainstorm", summaryRun: null, summaryMessages: [] });

  const feedback = await app(request(`/api/projects/${f.project.id}/rounds/1/feedback`, `${SESSION_COOKIE}=${sessionId}`, { method: "POST", body: JSON.stringify({clientEventId:"removed-feedback",worked:"x",improve:"",nextIdea:""}) }));
  expect(feedback.status).toBe(404);

  const removed = await app(request(`/api/projects/${f.project.id}/rounds/1/feedback/summary/skip`, `${SESSION_COOKIE}=${sessionId}`, { method: "POST" }));
  expect(removed.status).toBe(404);
  repo.close();
});
