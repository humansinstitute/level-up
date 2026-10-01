import { chromium, type BrowserContext, type Page } from "playwright";
import { finalizeEvent, getPublicKey, nip19, type EventTemplate } from "nostr-tools";
import { constants } from "node:fs";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { AuthService } from "../src/auth";
import { AgentBackedBuildAdapter, GooseBuildRunAgent, GooseGameEditAgent } from "../src/build-agent";
import { createApplication } from "../src/api";
import { agentErrorMessage, SummaryError } from "../src/feedback-summary";
import { LocalPlayableBuildAdapter } from "../src/local-build-adapter";
import { GooseBrainstormSuggestionGenerator, GooseProposalGenerator, proposalAgentConfig } from "../src/proposal-agent";
import { RoundRealtimeHub, type RoundSocketData } from "../src/realtime";
import { SqliteTeamRepository } from "../src/storage";

type NakIdentity = {
  role: "organiser" | "player-one" | "player-two";
  nsec: string;
  secret: Uint8Array;
  pubkey: string;
  npub: string;
};

type BrowserActor = { identity: NakIdentity; context: BrowserContext; page: Page };

declare global {
  interface Window {
    nostr?: {
      getPublicKey(): Promise<string>;
      signEvent(event: EventTemplate & { pubkey?: string }): Promise<unknown>;
    };
    __levelupSignEvent?: (event: EventTemplate) => Promise<unknown>;
  }
}

const handoffDir = "tmp/docs/handoffs/levelup-v2-acceptance";
const validationRoot = new URL("../.validation-dist", import.meta.url).pathname;
const completedSteps: string[] = [];

class AcceptanceBlocked extends Error {
  constructor(message: string, readonly missingVariables: string[], readonly invalidVariables: string[] = []) {
    super(message);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function commandOutput(command: string[], input?: string): string {
  const result = Bun.spawnSync(command, input ? { stdin: new TextEncoder().encode(input) } : undefined);
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed`);
  }
  return new TextDecoder().decode(result.stdout).trim();
}

function bytesFromHex(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error("Expected a 32-byte hex secret from nak.");
  return Uint8Array.from(value.match(/../g)!.map((byte) => Number.parseInt(byte, 16)));
}

async function ensureIgnoredPath(): Promise<void> {
  await mkdir(handoffDir, { recursive: true });
  const probe = join(handoffDir, ".ignore-probe");
  const result = Bun.spawnSync(["git", "check-ignore", "-q", probe]);
  if (result.exitCode !== 0) {
    throw new Error(`${handoffDir}/ must be ignored before acceptance secrets can be generated.`);
  }
}

async function generateIdentity(role: NakIdentity["role"]): Promise<NakIdentity> {
  const generated = commandOutput(["nak", "key", "generate"]).toLowerCase();
  const secret = generated.startsWith("nsec") ? nip19.decode(generated).data : bytesFromHex(generated);
  if (!(secret instanceof Uint8Array)) throw new Error("nak did not return a usable secret key.");
  const nsec = generated.startsWith("nsec") ? generated : commandOutput(["nak", "encode", "nsec", generated]);
  const pubkey = commandOutput(["nak", "key", "public", nsec]).toLowerCase();
  assert(/^[0-9a-f]{64}$/.test(pubkey), "nak returned an invalid public key.");
  assert(getPublicKey(secret) === pubkey, "nak public key does not match the generated secret.");
  const npub = nip19.npubEncode(pubkey);
  await writeFile(join(handoffDir, `${role}.nsec`), `${nsec}\n`, { mode: 0o600 });
  return { role, nsec, secret, pubkey, npub };
}

async function generateIdentities(): Promise<NakIdentity[]> {
  await ensureIgnoredPath();
  const identities = [
    await generateIdentity("organiser"),
    await generateIdentity("player-one"),
    await generateIdentity("player-two"),
  ];
  await writeFile(
    join(handoffDir, "identities.public.json"),
    `${JSON.stringify(identities.map(({ role, pubkey, npub }) => ({ role, pubkey, npub })), null, 2)}\n`,
    { mode: 0o644 },
  );
  completedSteps.push("generated three throwaway nak nsec identities in an ignored handoff path");
  return identities;
}

async function gooseSetupIssue(env: Record<string, string | undefined> = process.env): Promise<{ missing: string[]; invalid: string[] }> {
  const missing = ["OPENROUTER_API_KEY", "LEVELUP_AGENT_MODEL", "LEVELUP_GOOSE_BIN"].filter((key) => !env[key]?.trim());
  const invalid: string[] = [];
  const binary = env.LEVELUP_GOOSE_BIN?.trim();
  if (binary) {
    if (!isAbsolute(binary)) invalid.push("LEVELUP_GOOSE_BIN");
    else {
      try {
        await access(binary, constants.X_OK);
      } catch {
        invalid.push("LEVELUP_GOOSE_BIN");
      }
    }
  }
  return { missing, invalid };
}

async function blockIfGooseUnavailable(stage: string): Promise<void> {
  const { missing, invalid } = await gooseSetupIssue();
  if (!missing.length && !invalid.length) return;
  const details = [
    missing.length ? `missing ${missing.join(", ")}` : "",
    invalid.length ? `invalid ${invalid.join(", ")}` : "",
  ].filter(Boolean).join("; ");
  throw new AcceptanceBlocked(`V2 acceptance blocked before ${stage}: Goose runtime setup is incomplete (${details}).`, missing, invalid);
}

async function signedActor(browser: Awaited<ReturnType<typeof chromium.launch>>, origin: string, identity: NakIdentity, width: number): Promise<BrowserActor> {
  const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  await context.exposeBinding("__levelupSignEvent", async (_source, event: EventTemplate) => finalizeEvent(event, identity.secret));
  await context.addInitScript((pubkey) => {
    window.nostr = {
      getPublicKey: async () => pubkey,
      signEvent: async (event) => window.__levelupSignEvent?.(event),
    };
  }, identity.pubkey);
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(origin) || url.startsWith("data:") || url.startsWith("blob:")) void route.continue();
    else void route.abort();
  });
  const page = await context.newPage();
  await page.goto(origin);
  await page.getByRole("button", { name: "Sign in with Nostr" }).click();
  await page.getByText("Find your", { exact: false }).waitFor({ state: "visible", timeout: 15_000 });
  return { identity, context, page };
}

async function visible(page: Page, text: string | RegExp, timeout = 20_000): Promise<void> {
  await page.getByText(text, { exact: false }).first().waitFor({ state: "visible", timeout });
}

async function waitForCount(locator: ReturnType<Page["locator"]>, min: number, label: string, timeout = 20_000): Promise<number> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const count = await locator.count();
    if (count >= min) return count;
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function statusText(page: Page): Promise<string> {
  return (await page.locator('[role="status"]').last().innerText().catch(() => "")).trim();
}

async function waitForLvlUpSuggestion(page: Page, timeout = 180_000): Promise<void> {
  await page.locator(".conversation-bubble-idea:has(.bot-avatar)").filter({ hasText: "lvl_up" }).first().waitFor({ state: "visible", timeout });
}

async function waitForRequirementCards(page: Page, repository: SqliteTeamRepository, projectId: string, accountId: string, timeout = 180_000): Promise<number> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await page.getByText("Review requirement cards", { exact: false }).first().isVisible().catch(() => false)) {
      const count = await waitForCount(page.locator(".proposal-card"), 3, "3-5 requirement cards");
      if (count <= 5) return count;
      throw new Error(`Expected 3-5 requirement cards, saw ${count}.`);
    }
    await Bun.sleep(250);
  }
  const round = repository.round(projectId, accountId);
  throw new Error(`Proposal generation did not reach requirement cards. Current phase: ${round.phase}; proposals: ${round.proposals.length}; UI status: ${await statusText(page) || "empty"}.`);
}

async function chooseTemplates(page: Page, titles: string[]): Promise<void> {
  for (const title of titles) {
    const card = page.locator(".template-card").filter({ has: page.getByRole("heading", { name: title }) });
    await card.getByRole("button", { name: "Choose" }).click();
  }
  await visible(page, "Your two favourites are saved");
}

async function sendIdea(page: Page, idea: string): Promise<void> {
  await page.getByLabel("Add an idea").fill(idea);
  await page.getByRole("button", { name: "Send idea" }).click();
  await visible(page, idea);
}

async function placeVotes(page: Page, order: number[]): Promise<void> {
  for (const index of order) {
    await page.locator(".proposal-card").nth(index).getByRole("button", { name: /Add vote/ }).click();
  }
  await visible(page, "3/3 vote tokens");
}

async function waitForRoundPhase(repository: SqliteTeamRepository, projectId: string, accountId: string, phase: string, timeout = 180_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (repository.round(projectId, accountId).phase === phase) return;
    await Bun.sleep(250);
  }
  throw new Error(`Timed out waiting for round phase ${phase}.`);
}

async function run(): Promise<void> {
  assert(await Bun.file(join(validationRoot, "index.html")).exists(), "Run bun run build:verify before the V2 Playwright acceptance script.");
  const identities = await generateIdentities();
  process.env.LEVELUP_RELEASES_PATH = join(handoffDir, "releases");
  await rm(join(handoffDir, "acceptance.sqlite"), { force: true });
  await rm(join(handoffDir, "acceptance.sqlite-wal"), { force: true });
  await rm(join(handoffDir, "acceptance.sqlite-shm"), { force: true });
  await rm(process.env.LEVELUP_RELEASES_PATH, { recursive: true, force: true });

  const config = proposalAgentConfig();
  const repository = new SqliteTeamRepository(join(handoffDir, "acceptance.sqlite"), {
    selectionDurationSeconds: 176,
    brainstormDurationSeconds: 300,
    votingDurationSeconds: 180,
    proposalGenerator: new GooseProposalGenerator(config),
    brainstormSuggestionGenerator: new GooseBrainstormSuggestionGenerator(config),
    buildAdapter: new AgentBackedBuildAdapter(new GooseBuildRunAgent(config), new LocalPlayableBuildAdapter({ releaseRoot: process.env.LEVELUP_RELEASES_PATH, gameEditAgent: new GooseGameEditAgent(config) })),
  });
  const auth = new AuthService({ accessMode: "open", sessionStore: repository });
  const hub = new RoundRealtimeHub(auth, repository);
  const app = createApplication({ repository, auth, staticRoot: validationRoot, onRoundEvent: (id, event, round) => hub.publish(id, event, round) });
  const server = Bun.serve<RoundSocketData>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, bunServer) {
      const upgraded = hub.upgrade(request, bunServer);
      return upgraded === null ? app.fetch(request) : upgraded;
    },
    websocket: {
      open: (socket) => hub.open(socket),
      message: (socket, message) => hub.message(socket, message),
      close: (socket) => hub.close(socket),
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const pageErrors: string[] = [];
  const actors: BrowserActor[] = [];

  try {
    for (const [index, identity] of identities.entries()) {
      const actor = await signedActor(browser, origin, identity, [390, 430, 470][index] ?? 390);
      actor.page.on("pageerror", (error) => pageErrors.push(`${identity.role}: ${error.message}`));
      actors.push(actor);
    }
    const [organiser, playerOne, playerTwo] = actors as [BrowserActor, BrowserActor, BrowserActor];
    completedSteps.push("three browser contexts signed in through the NIP-07 UI path");

    await organiser.page.getByLabel("Team name").fill("V2 Acceptance Crew");
    await organiser.page.getByRole("button", { name: "Create team" }).click();
    await visible(organiser.page, "V2 Acceptance Crew");
    const inviteLink = await organiser.page.getByLabel("Team invite link").inputValue();

    for (const player of [playerOne, playerTwo]) {
      await player.page.getByLabel("Invite").fill(inviteLink);
      await player.page.getByRole("button", { name: "Join team" }).click();
      await visible(player.page, "V2 Acceptance Crew");
    }
    completedSteps.push("organiser created a team and two other accounts joined by invite");

    await organiser.page.getByLabel("Project name").fill("V2 Agent Loop Acceptance");
    await organiser.page.getByRole("button", { name: "Create project" }).click();
    await visible(organiser.page, "Pick your two");
    const projectUrl = organiser.page.url();
    const projectId = decodeURIComponent(new URL(projectUrl).pathname.split("/").pop() ?? "");
    assert(projectId.length > 0, "Could not read project id from project URL.");

    for (const player of [playerOne, playerTwo]) {
      await player.page.goto(projectUrl);
      await visible(player.page, "Pick your two");
    }
    completedSteps.push("organiser created a project and all accounts opened it");

    await chooseTemplates(organiser.page, ["Minotaur Maze", "Neon Trail"]);
    await chooseTemplates(playerOne.page, ["Minotaur Maze", "Pocket Pong"]);
    await chooseTemplates(playerTwo.page, ["Minotaur Maze", "River Hop"]);
    await organiser.page.getByRole("button", { name: "Close voting early" }).click();
    await visible(organiser.page, "ROUND 1");
    await Promise.all([visible(playerOne.page, "Add an idea"), visible(playerTwo.page, "Add an idea")]);
    completedSteps.push("team chose a base game through template voting and all open browsers advanced without reload");

    await sendIdea(organiser.page, "Make the minotaur leave warning footprints before it charges.");
    await sendIdea(playerOne.page, "Add keys that change the maze walls for a few seconds.");
    await sendIdea(playerTwo.page, "Give the player a torch meter so routes feel tense.");
    completedSteps.push("players brainstormed through the authenticated browser room");

    await blockIfGooseUnavailable("the first Goose-backed lvl_up brainstorm response");

    await waitForLvlUpSuggestion(organiser.page);
    completedSteps.push("observed a real Goose-backed lvl_up brainstorm response in the browser");

    await organiser.page.getByRole("button", { name: "Close brainstorm and generate proposals" }).click();
    const proposalCount = await waitForRequirementCards(organiser.page, repository, projectId, repository.accountForNostr(organiser.identity.pubkey, organiser.identity.npub).id);
    completedSteps.push(`real Goose proposal generation yielded ${proposalCount} requirement cards`);

    await organiser.page.getByRole("button", { name: "Open voting" }).click();
    await visible(organiser.page, "Spend your three votes");
    for (const player of [playerOne, playerTwo]) {
      await visible(player.page, "Spend your three votes");
    }
    await placeVotes(organiser.page, [0, 0, 0]);
    await organiser.page.locator(".proposal-card").nth(0).getByRole("button", { name: /Remove vote/ }).click();
    await organiser.page.locator(".proposal-card").nth(1).getByRole("button", { name: /Add vote/ }).click();
    await visible(organiser.page, "3/3 vote tokens");
    await placeVotes(playerOne.page, [1, 1, 0]);
    await placeVotes(playerTwo.page, [2, 0, 1]);
    completedSteps.push("three users allocated, stacked, removed, and reallocated three vote tokens");

    await organiser.page.getByRole("button", { name: "Close voting and freeze brief" }).click();
    await visible(organiser.page, "Run build agent");
    await organiser.page.getByRole("button", { name: "Run build agent" }).click();
    await visible(organiser.page, "Building the round");
    await waitForRoundPhase(repository, projectId, repository.accountForNostr(organiser.identity.pubkey, organiser.identity.npub).id, "playtest", 240_000);
    await visible(organiser.page, "Play it, then report back");
    completedSteps.push("real agent-backed build acknowledgement completed and playtest opened without reload");

    const buildReleaseUrl = repository.round(projectId, repository.accountForNostr(organiser.identity.pubkey, organiser.identity.npub).id)?.build?.releaseUrl;
    assert(buildReleaseUrl?.startsWith(`/projects/${projectId}/versions/v`), `Build did not publish an immutable release URL: ${buildReleaseUrl ?? "<missing>"}`);
    const releaseVersion = Number(buildReleaseUrl.match(/\/versions\/v(\d+)\//)?.[1] ?? 0);
    assert(releaseVersion >= 2, `Build published the old template-wrapper version instead of an agent-edited release: ${buildReleaseUrl}`);
    const expectedReleasePath = buildReleaseUrl;
    const playLink = organiser.page.getByRole("link", { name: "Open playable game" });
    const playLinkTarget = await playLink.getAttribute("href");
    const [gamePage] = await Promise.all([
      organiser.page.waitForEvent("popup"),
      playLink.click(),
    ]);
    try {
      await gamePage.waitForURL((url) => url.href.includes(expectedReleasePath), { waitUntil: "domcontentloaded", timeout: 30_000 });
    } catch (error) {
      throw new Error(
        `Playable game did not open the immutable release. Expected URL containing ${expectedReleasePath}; link target was ${
          playLinkTarget ?? "<missing href>"
        }; last popup URL was ${gamePage.url()}; wait error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    assert(gamePage.url().includes(expectedReleasePath), `Playable game opened unexpected URL ${gamePage.url()}`);
    await gamePage.close();
    completedSteps.push(`play page opened on the immutable agent-edited release URL ${expectedReleasePath}`);

    await visible(playerOne.page, "Play it, then report back");
    await playerOne.page.getByLabel("What worked?").fill("The warning footprints made the chase readable.");
    await playerOne.page.getByLabel("What should improve?").fill("The key timing could be clearer.");
    await playerOne.page.getByLabel("Idea for next round").fill("Add a torch pickup that reveals safe shortcuts.");
    await playerOne.page.getByRole("button", { name: "Submit feedback" }).click();
    await visible(organiser.page, "1 submitted notes");
    await organiser.page.getByRole("button", { name: "Start next brainstorm" }).click();
    await visible(organiser.page, "ROUND 2");
    await visible(organiser.page, "Play notes for this brainstorm");
    completedSteps.push("feedback close returned directly to the next brainstorm");

    assert(pageErrors.length === 0, `Browser page errors: ${pageErrors.join("; ")}`);
    console.log(JSON.stringify({ ok: true, status: "passed", completedSteps, identities: identities.map(({ role, npub }) => ({ role, npub })), projectId }, null, 2));
  } catch (error) {
    if (error instanceof SummaryError) {
      throw new AcceptanceBlocked(`V2 acceptance blocked by Goose at runtime: ${agentErrorMessage(error.code)}`, [], []);
    }
    throw error;
  } finally {
    for (const actor of actors) await actor.context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    server.stop(true);
    repository.close();
  }
}

try {
  await run();
} catch (error) {
  if (error instanceof AcceptanceBlocked) {
    console.error(JSON.stringify({ ok: false, status: "blocked", message: error.message, missingVariables: error.missingVariables, invalidVariables: error.invalidVariables, completedSteps }, null, 2));
    process.exit(2);
  }
  console.error(JSON.stringify({ ok: false, status: "failed", message: error instanceof Error ? error.message : "Unknown V2 Playwright acceptance failure.", completedSteps }, null, 2));
  process.exit(1);
}
