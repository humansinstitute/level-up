import { createHash, randomInt, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import type { Event } from "nostr-tools";
import { INVITE_CODE_ALPHABET, INVITE_CODE_LENGTH, INVITE_SECRET_PATTERN } from "./invites";
import { releaseAgentTraceStore, sanitizeAgentTraceValue, type AgentRunTrace, type AgentTraceStore } from "./agent-trace";
import { DeterministicProposalGenerator, DeterministicSimulatedBuildAdapter, SqliteLoopStore, type BrainstormSuggestionGenerator, type BuildAdapter, type BuildRun, type ProposalGenerator, type RoundEvent, type RoundMutation, type RoundSnapshot } from "./loop";
import { MAX_PROFILE_BATCH, profileFromEvent, selectLatestProfile, type PublicProfile } from "./profile-data";

export type { BuildRun, BuildStage, FeedbackContext, FrozenBrief, MemberFeedback, Proposal, RankedProposal, RoundContribution, RoundContributionAttachment, RoundEvent, RoundFeedbackHistory, RoundMutation, RoundPhase, RoundSnapshot } from "./loop";

export interface Account {
  id: string;
  pubkey: string;
  npub: string;
}

export interface TeamMember {
  accountId: string;
  npub: string;
  role: "organiser" | "player";
  joinedAt: number;
}

export interface TeamLobby {
  id: string;
  sessionId: string;
  name: string;
  phase: "lobby";
  isOrganiser: boolean;
  members: TeamMember[];
  projects: ProjectSummary[];
  profiles: PublicProfile[];
}

export const DEFAULT_TEMPLATE_SELECTION_SECONDS = 176;
export const DEFAULT_BRAINSTORM_SECONDS = 300;
type SuggestionIntervalMs = number | (() => number);

export interface GameTemplate {
  id: string;
  title: string;
  description: string;
  themePrompts: string[];
  previewUrl: string;
  visual: string;
}

export type ProjectPhase = "selecting_template" | "resolving_template_tie" | "round_1_brainstorm";

export interface ProjectSummary {
  id: string;
  teamId: string;
  name: string;
  phase: ProjectPhase;
  selectedTemplateId: string | null;
  stablePlayUrl: string | null;
  createdAt: number;
}

export interface AdminProjectSummary extends ProjectSummary {
  teamName: string;
  joinedCount: number;
  connectedCount: number | null;
  activeInvite: boolean;
  selectionStartedAt: number;
  selectionClosedAt: number | null;
  captain: { accountId: string; npub: string; roundNumber: number } | null;
  failure: { code: string; section: string } | null;
  round: {
    id: string;
    number: number;
    phase: RoundSnapshot["phase"];
    lastSequence: number;
    buildStatus: BuildRun["status"] | null;
    buildStage: BuildRun["currentStage"] | null;
  } | null;
}

export interface AdminTeamSummary {
  id: string;
  name: string;
  memberCount: number;
  projectCount: number;
  createdAt: number;
}

export type GroupRunStatus = "draft" | "running" | "paused" | "completed";
export type GroupCommand = "open_play" | "start_voting" | "extend_voting" | "close_voting" | "start_first_brainstorm" | "pause" | "resume";
export interface GroupProjectResult { projectId: string; command: GroupCommand; status: "succeeded" | "failed" | "skipped"; code: string | null; message: string; at: number }
export interface GroupRun { id: string; name: string; status: GroupRunStatus; initialStage: string; selectedProjectIds: string[]; results: GroupProjectResult[]; createdAt: number; updatedAt: number }

export interface TemplateRanking extends GameTemplate {
  votes: number;
}

export interface ProjectRoom extends ProjectSummary {
  teamName: string;
  isOrganiser: boolean;
  selectionStartedAt: number;
  selectionDeadlineAt: number;
  selectionClosedAt: number | null;
  serverTime: number;
  templates: GameTemplate[];
  selections: string[];
  rankings: TemplateRanking[];
  topThree: TemplateRanking[];
  tiedLeaderIds: string[];
  selectedTemplate: GameTemplate | null;
  round: RoundSnapshot | null;
  captain: { accountId: string; npub: string; roundNumber: number } | null;
  profiles: PublicProfile[];
}

export interface CreatedInvite {
  secret: string;
  expiresAt: number | null;
}

export interface TeamRepository extends AgentTraceStore {
  accountForNostr(pubkey: string, npub: string): Account;
  currentTeam(accountId: string): TeamLobby | null;
  teamsForAccount(accountId: string): TeamLobby[];
  lobby(teamId: string, accountId: string): TeamLobby | null;
  activeInvite(teamId: string, accountId: string): CreatedInvite;
  createTeam(accountId: string, name: string): { team: TeamLobby; invite: CreatedInvite };
  redeemInvite(accountId: string, secret: string): { team: TeamLobby; alreadyMember: boolean };
  rotateInvite(teamId: string, accountId: string): CreatedInvite;
  createProject(teamId: string, accountId: string, name: string, idempotencyKey?: string): ProjectRoom;
  deleteProject(projectId: string, accountId: string): { team: TeamLobby; deletedProjectId: string };
  adminDeleteProject(projectId: string, accountId: string): { deletedProjectId: string; deletedTeamId: string };
  adminDeleteTeam(teamId: string, accountId: string): { deletedTeamId: string; deletedProjectIds: string[] };
  cancelProjectWork(projectId: string): Promise<void>;
  project(projectId: string, accountId: string): ProjectRoom;
  startTemplateSelection(projectId: string, accountId: string): ProjectRoom;
  replaceTemplateSelections(projectId: string, accountId: string, templateIds: string[]): ProjectRoom;
  closeTemplateSelection(projectId: string, accountId: string): ProjectRoom;
  resolveTemplateTie(projectId: string, accountId: string, templateId: string): ProjectRoom;
  round(projectId: string, accountId: string, roundNumber?: number): RoundSnapshot;
  roundEvents(projectId: string, accountId: string, afterSequence: number, roundNumber?: number): { round: RoundSnapshot; events: RoundEvent[] };
  submitContribution(projectId: string, accountId: string, clientEventId: string, body: string, roundNumber?: number, attachments?: unknown[]): RoundMutation;
  suggestBrainstorm(projectId: string): RoundMutation | Promise<RoundMutation | null> | null;
  closeBrainstorm(projectId: string, accountId: string, roundNumber?: number): RoundMutation | Promise<RoundMutation>;
  closeExpiredBrainstorm(projectId: string): RoundMutation | Promise<RoundMutation | null> | null;
  deadlineProjectIds(now?: number): string[];
  builderProjectIds(): string[];
  replaceProposalVotes(projectId: string, accountId: string, proposalIds: string[], roundNumber?: number): RoundMutation;
  closeProposalVoting(projectId: string, accountId: string, roundNumber?: number): RoundMutation;
  beginProposalVoting(projectId: string, accountId: string, roundNumber?: number): RoundMutation;
  startBuild(projectId: string, accountId: string, roundNumber?: number): RoundMutation;
  advanceBuild(projectId: string): RoundMutation | Promise<RoundMutation | null> | null;
  reportBuildProblem(projectId: string, accountId: string, note: string, roundNumber?: number): RoundMutation;
  deferInterruptedFeature(projectId: string, accountId: string, roundNumber?: number): RoundMutation;
  /** Legacy compatibility helper; there is no structured-feedback product API. */
  submitFeedback(projectId: string, accountId: string, clientEventId: string, feedback: { worked: string; improve: string; nextIdea: string }, roundNumber?: number): RoundMutation;
  /** Legacy compatibility helper; current clients use startSuccessorBrainstorm. */
  closeFeedback(projectId: string, accountId: string, roundNumber?: number): RoundMutation;
  startSuccessorBrainstorm(projectId: string, accountId: string, roundNumber?: number): RoundMutation;
  stablePlayUrl(projectId: string): string | null;
  adminProjects(): AdminProjectSummary[];
  adminTeams(): AdminTeamSummary[];
  adminTeamProjectIds(teamId: string, accountId: string): string[];
  groupRun(): GroupRun | null;
  saveGroupRun(accountId: string, input: { name: string; projectIds: string[] }): GroupRun;
  runGroupCommand(accountId: string, command: GroupCommand, requestId: string): { run: GroupRun; results: GroupProjectResult[]; duplicate: boolean };
  profilesForAccount(accountId: string, pubkeys: string[]): PublicProfile[];
  cacheProfiles(accountId: string, events: unknown[]): PublicProfile[];
  saveAuthSession(tokenHash: string, session: { pubkey: string; npub: string; expiresAt: number }): void;
  readAuthSession(tokenHash: string, nowSeconds: number): { pubkey: string; npub: string; expiresAt: number } | null;
  deleteAuthSession(tokenHash: string): void;
  close(): void;
}

export class RepositoryError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
  }
}

type TeamRow = { id: string; session_id: string; name: string; creator_account_id: string };
type MemberRow = { account_id: string; nostr_npub: string; role: "organiser" | "player"; joined_at: number };
type InviteRow = { team_id: string; session_id: string; status: string; expires_at: number | null };
const INVITE_CODE_ATTEMPTS = 8;
type ProjectRow = { id: string; team_id: string; name: string; phase: ProjectPhase; selected_template_id: string | null; stable_play_url: string | null; selection_started_at: number; selection_deadline_at: number; selection_closed_at: number | null; created_at: number; team_name: string; creator_account_id: string };
const CURATED_TEMPLATES: GameTemplate[] = [
  { id: "citadel-strike", title: "First-Person Shooter — Citadel Strike", description: "Push through a neon fortress and clear every drone before your armour fails.", themePrompts: ["Enemy faction", "Weapon effect", "Fortress world"], previewUrl: "/templates/citadel-strike/index.html", visual: "fps" },
  { id: "skyline-sprint", title: "Platformer — Skyline Sprinter", description: "Leap across a sunset skyline, collect power cells, and reach the launch beacon.", themePrompts: ["Runner hero", "City hazards", "Beacon reward"], previewUrl: "/templates/skyline-sprint/index.html", visual: "platformer" },
  { id: "village-games", title: "World Builder — Village Games", description: "Explore a living village, gather supplies, help neighbours, and grow the town.", themePrompts: ["Village residents", "New buildings", "Seasonal quests"], previewUrl: "/templates/village-games/index.html", visual: "world" },
  { id: "arcade-cabinet", title: "Arcade Cabinet — Snake, Minotaur Maze & Tennis", description: "One cabinet with three complete arcade games and a shared shell to remix.", themePrompts: ["Cabinet style", "Game variants", "Shared rewards"], previewUrl: "/templates/arcade-cabinet/index.html", visual: "arcade" },
];
const LEGACY_TEMPLATES: GameTemplate[] = [
  { id:"maze-minotaur",title:"Minotaur Maze",description:"Escape a shifting maze before the minotaur catches you.",themePrompts:["Hero and monster","Maze materials","Treasure goal"],previewUrl:"/templates/maze-minotaur/index.html",visual:"maze" },
  { id:"river-frogger",title:"River Hop",description:"Time quick hops across traffic and a rushing river.",themePrompts:["Crossing world","Player creature","Moving hazards"],previewUrl:"/templates/river-frogger/index.html",visual:"frog" },
  { id:"neon-snake",title:"Neon Trail",description:"Grow a glowing trail without crashing into yourself.",themePrompts:["Trail style","Collectable","Arena mood"],previewUrl:"/templates/neon-snake/index.html",visual:"snake" },
  { id:"pocket-pong",title:"Pocket Pong",description:"Defend your edge in a fast touch-friendly paddle duel.",themePrompts:["Paddle heroes","Ball power-up","Court theme"],previewUrl:"/templates/pocket-pong/index.html",visual:"pong" },
];
const LEGACY_TEMPLATE_IDS = LEGACY_TEMPLATES.map(template => template.id);

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function opaqueInviteError(): RepositoryError {
  return new RepositoryError("invite_invalid", "That invite is not valid. Ask the organiser for a fresh link.", 400);
}

export class SqliteTeamRepository implements TeamRepository {
  private readonly db: Database;
  private readonly now: () => number;

  private readonly selectionDurationMs: number;
  private readonly brainstormDurationMs: number;
  private readonly ownerNpub: string;
  private readonly inviteCodeGenerator: () => string;
  readonly loop: SqliteLoopStore;

  constructor(path: string, options: { now?: () => number; ownerNpub?: string; inviteCodeGenerator?: () => string; selectionDurationSeconds?: number; brainstormDurationSeconds?: number; votingDurationSeconds?: number; proposalGenerator?: ProposalGenerator; brainstormSuggestionGenerator?: BrainstormSuggestionGenerator; brainstormSuggestionIntervalMs?: SuggestionIntervalMs; buildAdapter?: BuildAdapter } = {}) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.now = options.now ?? (() => Date.now());
    this.ownerNpub = options.ownerNpub?.trim() ?? "";
    this.inviteCodeGenerator = options.inviteCodeGenerator ?? (() => Array.from({ length: INVITE_CODE_LENGTH }, () => INVITE_CODE_ALPHABET[randomInt(INVITE_CODE_ALPHABET.length)]!).join(""));
    const configuredDuration = options.selectionDurationSeconds ?? DEFAULT_TEMPLATE_SELECTION_SECONDS;
    this.selectionDurationMs = (Number.isFinite(configuredDuration) && configuredDuration > 0 ? Math.floor(configuredDuration) : DEFAULT_TEMPLATE_SELECTION_SECONDS) * 1000;
    const configuredBrainstorm = options.brainstormDurationSeconds ?? DEFAULT_BRAINSTORM_SECONDS;
    this.brainstormDurationMs = (Number.isFinite(configuredBrainstorm) && configuredBrainstorm > 0 ? Math.floor(configuredBrainstorm) : DEFAULT_BRAINSTORM_SECONDS) * 1000;
    this.db.exec("PRAGMA foreign_keys = ON");
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL");
    this.migrate();
    this.removeOwnerFromCaptainState();
    const votingSeconds = options.votingDurationSeconds ?? 180;
    this.loop = new SqliteLoopStore(this.db, this.now, this.brainstormDurationMs, Math.max(1, votingSeconds) * 1000, options.proposalGenerator ?? new DeterministicProposalGenerator(), options.brainstormSuggestionGenerator, options.brainstormSuggestionIntervalMs, options.buildAdapter ?? new DeterministicSimulatedBuildAdapter());
  }

  accountForNostr(pubkey: string, npub: string): Account {
    const normalized = pubkey.toLowerCase();
    const existing = this.db.query("SELECT id, nostr_pubkey, nostr_npub FROM accounts WHERE nostr_pubkey = ?").get(normalized) as { id: string; nostr_pubkey: string; nostr_npub: string } | null;
    if (existing) { if(existing.nostr_npub===this.ownerNpub)this.removeOwnerFromCaptainState(); return { id: existing.id, pubkey: existing.nostr_pubkey, npub: existing.nostr_npub }; }
    const account = { id: randomUUID(), pubkey: normalized, npub };
    this.db.query("INSERT INTO accounts (id, nostr_pubkey, nostr_npub, created_at) VALUES (?, ?, ?, ?)").run(account.id, account.pubkey, account.npub, this.now());
    if(account.npub===this.ownerNpub)this.removeOwnerFromCaptainState();
    return account;
  }

  profilesForAccount(accountId: string, pubkeys: string[]): PublicProfile[] {
    const normalized = [...new Set(pubkeys.map((value) => value.toLowerCase()).filter((value) => /^[0-9a-f]{64}$/.test(value)))];
    if (normalized.length > MAX_PROFILE_BATCH) throw new RepositoryError("profile_batch_too_large", `Request at most ${MAX_PROFILE_BATCH} player profiles.`, 400);
    if (!normalized.length) return [];
    const placeholders = normalized.map(() => "?").join(",");
    const allowed = new Set((this.db.query(`SELECT DISTINCT a.nostr_pubkey FROM team_members mine JOIN team_members peer ON peer.team_id=mine.team_id JOIN accounts a ON a.id=peer.account_id WHERE mine.account_id=? AND a.nostr_pubkey IN (${placeholders})`).all(accountId, ...normalized) as Array<{nostr_pubkey:string}>).map((row) => row.nostr_pubkey));
    const own=this.db.query("SELECT nostr_pubkey FROM accounts WHERE id=?").get(accountId) as {nostr_pubkey:string}|null;if(own&&normalized.includes(own.nostr_pubkey))allowed.add(own.nostr_pubkey);
    return this.readProfiles(normalized.filter((pubkey) => allowed.has(pubkey)));
  }

  cacheProfiles(accountId: string, values: unknown[]): PublicProfile[] {
    if (values.length > MAX_PROFILE_BATCH) throw new RepositoryError("profile_batch_too_large", `Submit at most ${MAX_PROFILE_BATCH} player profiles.`, 400);
    const events = values.filter((value): value is Event => Boolean(value && typeof value === "object" && !Array.isArray(value)));
    const pubkeys = [...new Set(events.map((event) => typeof event.pubkey === "string" ? event.pubkey.toLowerCase() : "").filter(Boolean))];
    const allowed = new Set(this.profilesForAccount(accountId, pubkeys).map((profile) => profile.pubkey));
    // A missing cache row is still an allowed teammate; check membership independently.
    if (pubkeys.length) {
      const placeholders = pubkeys.map(() => "?").join(",");
      for (const row of this.db.query(`SELECT DISTINCT a.nostr_pubkey FROM team_members mine JOIN team_members peer ON peer.team_id=mine.team_id JOIN accounts a ON a.id=peer.account_id WHERE mine.account_id=? AND a.nostr_pubkey IN (${placeholders})`).all(accountId, ...pubkeys) as Array<{nostr_pubkey:string}>) allowed.add(row.nostr_pubkey);
    }
    const own=this.db.query("SELECT nostr_pubkey FROM accounts WHERE id=?").get(accountId) as {nostr_pubkey:string}|null;if(own&&pubkeys.includes(own.nostr_pubkey))allowed.add(own.nostr_pubkey);
    const accepted: PublicProfile[] = [];
    for (const pubkey of pubkeys) {
      if (!allowed.has(pubkey)) continue;
      const event = selectLatestProfile(events, pubkey);
      if (!event) continue;
      const existing = this.db.query("SELECT created_at,event_id FROM nostr_profile_cache WHERE pubkey=?").get(pubkey) as {created_at:number;event_id:string}|null;
      const fetchedAt = this.now();
      if (existing && (existing.created_at > event.created_at || (existing.created_at === event.created_at && existing.event_id > event.id))) continue;
      if(existing?.event_id===event.id){this.db.query("UPDATE nostr_profile_cache SET fetched_at=? WHERE pubkey=?").run(fetchedAt,pubkey);accepted.push(profileFromEvent(pubkey,event,fetchedAt));continue;}
      this.db.query("INSERT INTO nostr_profile_cache(pubkey,event_id,created_at,event_json,fetched_at) VALUES(?,?,?,?,?) ON CONFLICT(pubkey) DO UPDATE SET event_id=excluded.event_id,created_at=excluded.created_at,event_json=excluded.event_json,fetched_at=excluded.fetched_at").run(pubkey,event.id,event.created_at,JSON.stringify(event),fetchedAt);
      accepted.push(profileFromEvent(pubkey,event,fetchedAt));
    }
    return accepted;
  }

  currentTeam(accountId: string): TeamLobby | null {
    const row = this.db.query(`
      SELECT t.id, t.session_id, t.name, t.creator_account_id
      FROM team_members tm JOIN teams t ON t.id = tm.team_id
      WHERE tm.account_id = ? ORDER BY tm.joined_at DESC, tm.rowid DESC LIMIT 1
    `).get(accountId) as TeamRow | null;
    return row ? this.hydrateLobby(row, accountId) : null;
  }

  teamsForAccount(accountId: string): TeamLobby[] {
    const rows = this.db.query(`
      SELECT t.id, t.session_id, t.name, t.creator_account_id
      FROM team_members tm JOIN teams t ON t.id = tm.team_id
      WHERE tm.account_id = ? ORDER BY tm.joined_at DESC, tm.rowid DESC
    `).all(accountId) as TeamRow[];
    return rows.map((row) => this.hydrateLobby(row, accountId));
  }

  lobby(teamId: string, accountId: string): TeamLobby | null {
    const row = this.db.query(`
      SELECT t.id, t.session_id, t.name, t.creator_account_id
      FROM teams t JOIN team_members tm ON tm.team_id = t.id
      WHERE t.id = ? AND tm.account_id = ?
    `).get(teamId, accountId) as TeamRow | null;
    return row ? this.hydrateLobby(row, accountId) : null;
  }

  activeInvite(teamId: string, accountId: string): CreatedInvite {
    const team = this.db.query(`SELECT t.creator_account_id FROM teams t JOIN team_members tm ON tm.team_id=t.id WHERE t.id=? AND tm.account_id=?`).get(teamId, accountId) as { creator_account_id: string } | null;
    if (!team) throw new RepositoryError("forbidden", "You are not a member of that team.", 403);
    const existing = this.db.query("SELECT short_code,expires_at FROM team_invites WHERE team_id=? AND status='active' AND short_code IS NOT NULL AND (expires_at IS NULL OR expires_at>?) ORDER BY created_at DESC,rowid DESC LIMIT 1").get(teamId, this.now()) as { short_code: string; expires_at: number | null } | null;
    if (existing) return { secret: existing.short_code, expiresAt: existing.expires_at };
    return this.insertShortInvite(teamId, team.creator_account_id, this.now());
  }

  createTeam(accountId: string, rawName: string): { team: TeamLobby; invite: CreatedInvite } {
    const name = rawName.trim().replace(/\s+/g, " ");
    if (name.length < 2 || name.length > 60) {
      throw new RepositoryError("invalid_team_name", "Use a team name between 2 and 60 characters.", 400);
    }
    const createdAt = this.now();
    const sessionId = randomUUID();
    const teamId = randomUUID();
    let invite: CreatedInvite | null = null;
    this.db.transaction(() => {
      this.db.query("INSERT INTO game_sessions (id, creator_account_id, status, created_at) VALUES (?, ?, 'lobby', ?)").run(sessionId, accountId, createdAt);
      this.db.query("INSERT INTO session_members (session_id, account_id, role, joined_at) VALUES (?, ?, 'organiser', ?)").run(sessionId, accountId, createdAt);
      this.db.query("INSERT INTO teams (id, session_id, name, creator_account_id, phase, created_at, updated_at) VALUES (?, ?, ?, ?, 'lobby', ?, ?)").run(teamId, sessionId, name, accountId, createdAt, createdAt);
      this.db.query("INSERT INTO team_members (team_id, account_id, role, joined_at) VALUES (?, ?, 'organiser', ?)").run(teamId, accountId, createdAt);
      invite = this.insertShortInvite(teamId, accountId, createdAt);
    })();
    return { team: this.lobby(teamId, accountId)!, invite: invite! };
  }

  redeemInvite(accountId: string, secret: string): { team: TeamLobby; alreadyMember: boolean } {
    if (!INVITE_SECRET_PATTERN.test(secret)) throw opaqueInviteError();
    const now = this.now();
    const result = this.db.transaction(() => {
      const invite = this.db.query(`
        SELECT ti.team_id, t.session_id, ti.status, ti.expires_at
        FROM team_invites ti JOIN teams t ON t.id = ti.team_id
        WHERE ti.secret_hash = ?
      `).get(hashSecret(secret)) as InviteRow | null;
      if (!invite || invite.status !== "active" || (invite.expires_at !== null && invite.expires_at <= now)) {
        throw opaqueInviteError();
      }
      const existing = this.db.query("SELECT 1 AS found FROM team_members WHERE team_id = ? AND account_id = ?").get(invite.team_id, accountId);
      this.db.query("INSERT OR IGNORE INTO session_members (session_id, account_id, role, joined_at) VALUES (?, ?, 'player', ?)").run(invite.session_id, accountId, now);
      this.db.query("INSERT OR IGNORE INTO team_members (team_id, account_id, role, joined_at) VALUES (?, ?, 'player', ?)").run(invite.team_id, accountId, now);
      return { teamId: invite.team_id, alreadyMember: Boolean(existing) };
    })();
    return { team: this.lobby(result.teamId, accountId)!, alreadyMember: result.alreadyMember };
  }

  rotateInvite(teamId: string, accountId: string): CreatedInvite {
    const now = this.now();
    let invite: CreatedInvite | null = null;
    this.db.transaction(() => {
      const team = this.db.query("SELECT creator_account_id FROM teams WHERE id = ?").get(teamId) as { creator_account_id: string } | null;
      if (!team) throw new RepositoryError("team_not_found", "That team could not be found.", 404);
      if (team.creator_account_id !== accountId) throw new RepositoryError("forbidden", "Only the team organiser can create an invite.", 403);
      this.db.query("UPDATE team_invites SET status = 'revoked', updated_at = ? WHERE team_id = ? AND status = 'active'").run(now, teamId);
      invite = this.insertShortInvite(teamId, accountId, now);
    })();
    return invite!;
  }

  private insertShortInvite(teamId: string, accountId: string, now: number): CreatedInvite {
    for (let attempt = 0; attempt < INVITE_CODE_ATTEMPTS; attempt += 1) {
      const code = this.inviteCodeGenerator();
      if (code.length !== INVITE_CODE_LENGTH || [...code].some(character => !INVITE_CODE_ALPHABET.includes(character))) throw new Error("Invite code generator returned an invalid code.");
      try {
        this.db.query("INSERT INTO team_invites (id, team_id, secret_hash, short_code, status, creator_account_id, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, NULL, ?, ?)").run(randomUUID(), teamId, hashSecret(code), code, accountId, now, now);
        return { secret: code, expiresAt: null };
      } catch (error) {
        const collision = this.db.query("SELECT 1 AS found FROM team_invites WHERE short_code=? OR secret_hash=?").get(code, hashSecret(code));
        if (!collision) throw error;
      }
    }
    throw new RepositoryError("invite_namespace_exhausted", "Could not create a unique invite code. Please try again.", 503);
  }

  createProject(teamId: string, accountId: string, rawName: string, idempotencyKey = ""): ProjectRoom {
    const name = rawName.trim().replace(/\s+/g, " ");
    if (name.length < 2 || name.length > 80) throw new RepositoryError("invalid_project_name", "Use a project name between 2 and 80 characters.", 400);
    const membership = this.db.query(`
      SELECT t.creator_account_id
      FROM team_members tm JOIN teams t ON t.id = tm.team_id
      WHERE tm.team_id = ? AND tm.account_id = ?
    `).get(teamId, accountId) as { creator_account_id: string } | null;
    if (!membership) throw new RepositoryError("forbidden", "You are not a member of that team.", 403);
    if (membership.creator_account_id !== accountId) throw new RepositoryError("forbidden", "Only the account that created this team can create a project.", 403);
    const key = idempotencyKey.trim();
    if (key.length > 128) throw new RepositoryError("invalid_idempotency_key", "The idempotency key is too long.", 400);
    if (key) {
      const existing = this.db.query("SELECT project_id FROM project_creation_requests WHERE team_id = ? AND idempotency_key = ?").get(teamId, key) as { project_id: string } | null;
      if (existing) return this.project(existing.project_id, accountId);
    }
    const now = this.now();
    const projectId = randomUUID();
    this.db.transaction(() => {
      this.db.query("INSERT INTO projects (id, team_id, name, phase, selection_started_at, selection_deadline_at, created_at, updated_at) VALUES (?, ?, ?, 'selecting_template', 0, 0, ?, ?)").run(projectId, teamId, name, now, now);
      if (key) this.db.query("INSERT INTO project_creation_requests (team_id, idempotency_key, project_id, created_at) VALUES (?, ?, ?, ?)").run(teamId, key, projectId, now);
      this.ensureRoundCaptain(projectId, 1);
    })();
    return this.project(projectId, accountId);
  }

  project(projectId: string, accountId: string): ProjectRoom {
    this.closeExpiredProject(projectId);
    const row = this.projectRow(projectId, accountId);
    if (!row) throw new RepositoryError("forbidden", "You are not a member of this project's team.", 403);
    if (row.selected_template_id) this.ensureRoundOne(projectId);
    return this.hydrateProject(row, accountId);
  }

  deleteProject(projectId: string, accountId: string): { team: TeamLobby; deletedProjectId: string } {
    const row = this.projectRow(projectId, accountId);
    if (!row) throw new RepositoryError("forbidden", "You are not a member of this project's team.", 403);
    if (row.creator_account_id !== accountId) throw new RepositoryError("forbidden", "Only the team organiser can delete projects.", 403);
    this.db.transaction(() => this.deleteProjectRecords(projectId))();
    const team = this.lobby(row.team_id, accountId);
    if (!team) throw new RepositoryError("forbidden", "You are not a member of that team.", 403);
    return { team, deletedProjectId: projectId };
  }

  adminDeleteProject(projectId: string, accountId: string): { deletedProjectId: string; deletedTeamId: string } {
    this.requireOwnerAccount(accountId);
    const row = this.db.query("SELECT team_id FROM projects WHERE id=?").get(projectId) as { team_id: string } | null;
    if (!row) throw new RepositoryError("project_not_found", "That project no longer exists.", 404);
    this.db.transaction(() => this.deleteProjectRecords(projectId))();
    return { deletedProjectId: projectId, deletedTeamId: row.team_id };
  }

  adminDeleteTeam(teamId: string, accountId: string): { deletedTeamId: string; deletedProjectIds: string[] } {
    this.requireOwnerAccount(accountId);
    const team = this.db.query("SELECT session_id FROM teams WHERE id=?").get(teamId) as { session_id: string } | null;
    if (!team) throw new RepositoryError("team_not_found", "That team no longer exists.", 404);
    const projectIds = (this.db.query("SELECT id FROM projects WHERE team_id=? ORDER BY id").all(teamId) as Array<{ id: string }>).map((row) => row.id);
    this.db.transaction(() => {
      for (const projectId of projectIds) this.deleteProjectRecords(projectId);
      this.db.query("DELETE FROM teams WHERE id=?").run(teamId);
      this.db.query("DELETE FROM game_sessions WHERE id=? AND NOT EXISTS(SELECT 1 FROM teams WHERE session_id=?)").run(team.session_id, team.session_id);
    })();
    return { deletedTeamId: teamId, deletedProjectIds: projectIds };
  }

  cancelProjectWork(projectId: string): Promise<void> { return this.loop.cancelProjectWork(projectId); }

  startTemplateSelection(projectId: string, accountId: string): ProjectRoom {
    this.db.transaction(() => {
      const row = this.projectRow(projectId, accountId);
      if (!row) throw new RepositoryError("forbidden", "You are not a member of this project's team.", 403);
      if (row.creator_account_id !== accountId) throw new RepositoryError("forbidden", "Only the team organiser can start template voting.", 403);
      if (row.phase !== "selecting_template") throw new RepositoryError("selection_closed", "Template voting has closed.", 409);
      if (row.selection_started_at > 0) return;
      const now = Math.max(1, this.now());
      this.db.query("UPDATE projects SET selection_started_at=?,selection_deadline_at=?,updated_at=? WHERE id=? AND phase='selecting_template' AND selection_started_at=0").run(now, now + this.selectionDurationMs, now, projectId);
    })();
    return this.project(projectId, accountId);
  }

  replaceTemplateSelections(projectId: string, accountId: string, templateIds: string[]): ProjectRoom {
    const unique = [...new Set(templateIds)];
    if (templateIds.length !== 2 || unique.length !== 2) throw new RepositoryError("invalid_template_selections", "Choose exactly two different templates.", 400);
    const availableIds = new Set(this.templates().map((template) => template.id));
    if (unique.some((id) => !availableIds.has(id))) throw new RepositoryError("invalid_template", "Choose templates from the available gallery.", 400);
    this.db.transaction(() => {
      this.closeExpiredProject(projectId);
      const row = this.projectRow(projectId, accountId);
      if (!row) throw new RepositoryError("forbidden", "You are not a member of this project's team.", 403);
      if (row.phase !== "selecting_template") throw new RepositoryError("selection_closed", "Template voting has closed.", 409);
      if (row.selection_started_at <= 0) throw new RepositoryError("selection_not_started", "Try the games first. The organiser has not started voting yet.", 409);
      const now = this.now();
      this.db.query("DELETE FROM project_template_selections WHERE project_id = ? AND account_id = ?").run(projectId, accountId);
      const insert = this.db.query("INSERT INTO project_template_selections (project_id, account_id, template_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
      for (const templateId of unique) insert.run(projectId, accountId, templateId, now, now);
    })();
    return this.project(projectId, accountId);
  }

  closeTemplateSelection(projectId: string, accountId: string): ProjectRoom {
    this.db.transaction(() => {
      this.closeExpiredProject(projectId);
      const row = this.projectRow(projectId, accountId);
      if (!row) throw new RepositoryError("forbidden", "You are not a member of this project's team.", 403);
      if (row.creator_account_id !== accountId) throw new RepositoryError("forbidden", "Only the team organiser can close voting.", 403);
      if (row.selection_started_at <= 0) throw new RepositoryError("selection_not_started", "Start template voting before closing it.", 409);
      if (row.phase === "selecting_template") this.finalizeSelection(projectId, this.now());
    })();
    return this.project(projectId, accountId);
  }

  resolveTemplateTie(projectId: string, accountId: string, templateId: string): ProjectRoom {
    this.db.transaction(() => {
      const row = this.projectRow(projectId, accountId);
      if (!row) throw new RepositoryError("forbidden", "You are not a member of this project's team.", 403);
      const captain = this.ensureRoundCaptain(projectId, 1);
      if (accountId !== captain?.accountId && !this.isOwnerAccount(accountId)) throw new RepositoryError("captain_required", captain ? "Only the Round Captain can resolve this tie." : "No player is available as Round Captain. Wait for the owner to resolve this tie.", 403);
      if (row.phase === "round_1_brainstorm") {
        if (row.selected_template_id === templateId) return;
        throw new RepositoryError("template_final", "The selected template is final.", 409);
      }
      if (row.phase !== "resolving_template_tie") throw new RepositoryError("tie_not_ready", "There is no first-place tie to resolve.", 409);
      const leaders = this.tiedLeaderIds(projectId);
      if (!leaders.includes(templateId)) throw new RepositoryError("invalid_tie_choice", "Choose only from the tied leaders.", 400);
      const now = this.now();
      this.db.query("UPDATE projects SET selected_template_id = ?, phase = 'round_1_brainstorm', updated_at = ? WHERE id = ?").run(templateId, now, projectId);
      this.ensureRoundOne(projectId, now);
    })();
    return this.project(projectId, accountId);
  }

  round(projectId: string, accountId: string, roundNumber?: number): RoundSnapshot {
    this.requireProjectMember(projectId, accountId);
    this.ensureRoundOne(projectId);
    return roundNumber ? this.loop.round(projectId, roundNumber, accountId) : this.loop.currentRound(projectId, accountId);
  }

  roundEvents(projectId: string, accountId: string, afterSequence: number, roundNumber?: number): { round: RoundSnapshot; events: RoundEvent[] } {
    const round = this.round(projectId, accountId, roundNumber);
    return this.loop.events(projectId, round.number, accountId, Number.isSafeInteger(afterSequence) ? afterSequence : 0);
  }

  submitContribution(projectId: string, accountId: string, clientEventId: string, body: string, roundNumber?: number, attachments: unknown[] = []): RoundMutation {
    const round = this.round(projectId, accountId, roundNumber);
    return this.loop.submitContribution(projectId, round.number, accountId, clientEventId, body, attachments);
  }

  suggestBrainstorm(projectId: string): RoundMutation | Promise<RoundMutation | null> | null {
    return this.loop.suggestBrainstorm(projectId);
  }

  closeBrainstorm(projectId: string, accountId: string, roundNumber?: number): RoundMutation {
    const round = this.round(projectId, accountId, roundNumber);
    return this.loop.closeBrainstorm(projectId, round.number, accountId) as RoundMutation;
  }

  closeExpiredBrainstorm(projectId: string): RoundMutation | Promise<RoundMutation | null> | null {
    return this.loop.closeExpired(projectId);
  }
  deadlineProjectIds(now=this.now()):string[]{return (this.db.query("SELECT DISTINCT project_id FROM collaboration_rounds WHERE (phase='brainstorm' AND proposal_generation_status='idle' AND deadline_at<=?) OR (phase='voting' AND voting_deadline_at<=?) ORDER BY project_id").all(now,now) as Array<{project_id:string}>).map(x=>x.project_id);}
  builderProjectIds():string[]{return (this.db.query("SELECT DISTINCT project_id FROM project_feature_queue WHERE status IN ('active','waiting') ORDER BY project_id").all() as Array<{project_id:string}>).map(x=>x.project_id);}

  replaceProposalVotes(projectId: string, accountId: string, proposalIds: string[], roundNumber?: number): RoundMutation {
    const round = this.round(projectId, accountId, roundNumber); return this.loop.replaceVotes(projectId, round.number, accountId, proposalIds);
  }
  closeProposalVoting(projectId: string, accountId: string, roundNumber?: number): RoundMutation {
    const round = this.round(projectId, accountId, roundNumber); return this.loop.closeVoting(projectId, round.number, accountId);
  }
  beginProposalVoting(projectId: string, accountId: string, roundNumber?: number): RoundMutation {
    const round=this.round(projectId,accountId,roundNumber);
    const captain=this.ensureRoundCaptain(projectId,round.number);
    if(accountId!==captain?.accountId&&!this.isOwnerAccount(accountId))throw new RepositoryError("captain_required",captain?"Only this round's captain can open proposal voting.":"No player is available as Round Captain. Wait for the owner to open proposal voting.",403);
    return this.loop.beginVoting(projectId,round.number,accountId);
  }
  startBuild(projectId: string, accountId: string, roundNumber?: number): RoundMutation {
    const round = this.round(projectId, accountId, roundNumber); const result=this.loop.startBuild(projectId, round.number, accountId); return {...result,round:this.loop.currentRound(projectId,accountId)};
  }
  advanceBuild(projectId: string): RoundMutation | Promise<RoundMutation | null> | null { return this.loop.advanceBuild(projectId); }
  reportBuildProblem(projectId: string, accountId: string, note: string, roundNumber?: number): RoundMutation {
    const round = this.round(projectId, accountId, roundNumber); const result=this.loop.reportBuildProblem(projectId, round.number, accountId, note); return {...result,round:this.loop.currentRound(projectId,accountId)};
  }
  deferInterruptedFeature(projectId: string, accountId: string, roundNumber?: number): RoundMutation {
    const round = this.round(projectId, accountId, roundNumber); this.requireOwner(accountId); const result=this.loop.deferInterruptedFeature(projectId, round.number, accountId); return {...result,round:this.loop.currentRound(projectId,accountId)};
  }
  submitFeedback(projectId: string, accountId: string, clientEventId: string, feedback: { worked: string; improve: string; nextIdea: string }, roundNumber?: number): RoundMutation {
    const round = this.round(projectId, accountId, roundNumber); return this.loop.submitLegacyFeedback(projectId, round.number, accountId, clientEventId, feedback);
  }
  closeFeedback(projectId: string, accountId: string, roundNumber?: number): RoundMutation {
    const round = this.round(projectId, accountId, roundNumber); return this.loop.closeLegacyFeedback(projectId, round.number, accountId);
  }
  startSuccessorBrainstorm(projectId:string,accountId:string,roundNumber?:number):RoundMutation {
    const round=this.round(projectId,accountId,roundNumber);
    const captain=this.ensureRoundCaptain(projectId,round.number+1);
    const organiser=this.db.query("SELECT t.creator_account_id FROM projects p JOIN teams t ON t.id=p.team_id WHERE p.id=?").get(projectId) as {creator_account_id:string}|null;
    const actor=this.db.query("SELECT nostr_npub FROM accounts WHERE id=?").get(accountId) as {nostr_npub:string}|null;
    const isOwner=Boolean(this.ownerNpub&&actor?.nostr_npub===this.ownerNpub);
    if(accountId!==captain?.accountId&&accountId!==organiser?.creator_account_id&&!isOwner)throw new RepositoryError("captain_required",captain?`Wait for this round's captain to start the next brainstorm.`:"No player is available as Round Captain. Wait for the owner to start the next brainstorm.",403);
    const result=this.loop.startSuccessorBrainstorm(projectId,round.number,accountId);
    this.ensureRoundCaptain(projectId,result.round.number);
    return result;
  }
  stablePlayUrl(projectId: string): string | null {
    return (this.db.query("SELECT stable_play_url FROM projects WHERE id = ?").get(projectId) as {stable_play_url:string|null} | null)?.stable_play_url ?? null;
  }

  private requireOwner(accountId:string):void {
    const actor=this.db.query("SELECT nostr_npub FROM accounts WHERE id=?").get(accountId) as {nostr_npub:string}|null;
    if(!this.ownerNpub||actor?.nostr_npub!==this.ownerNpub)throw new RepositoryError("forbidden","Only the Level Up owner can cancel the current build.",403);
  }

  private isOwnerAccount(accountId:string):boolean {
    const actor=this.db.query("SELECT nostr_npub FROM accounts WHERE id=?").get(accountId) as {nostr_npub:string}|null;
    return Boolean(this.ownerNpub&&actor?.nostr_npub===this.ownerNpub);
  }

  adminProjects(): AdminProjectSummary[] {
    const rows = this.db.query(`
      SELECT p.id, p.team_id, p.name, p.phase, p.selected_template_id, p.stable_play_url, p.created_at, p.selection_started_at, p.selection_closed_at, t.name AS team_name, t.creator_account_id,
        (SELECT COUNT(*) FROM team_members tm WHERE tm.team_id=p.team_id) AS joined_count,
        EXISTS(SELECT 1 FROM team_invites ti WHERE ti.team_id=p.team_id AND ti.status='active' AND (ti.expires_at IS NULL OR ti.expires_at>?)) AS active_invite
      FROM projects p JOIN teams t ON t.id = p.team_id
      ORDER BY p.created_at DESC, p.rowid DESC
      LIMIT 100
    `).all(this.now()) as Array<{ id: string; team_id: string; name: string; phase: ProjectPhase; selected_template_id: string | null; stable_play_url: string | null; created_at: number; selection_started_at:number; selection_closed_at:number|null; team_name: string; creator_account_id: string; joined_count:number; active_invite:number }>;
    return rows.map((row) => {
      let round: AdminProjectSummary["round"] = null;
      if (row.selected_template_id) {
        try {
          this.ensureRoundOne(row.id);
          const current = this.loop.currentRound(row.id, row.creator_account_id);
          round = { id: current.id, number: current.number, phase: current.phase, lastSequence: current.lastSequence, buildStatus: current.build?.status ?? null, buildStage: current.build?.currentStage ?? null };
        } catch {
          round = null;
        }
      }
      const captainRow=this.db.query("SELECT rc.account_id,a.nostr_npub,rc.round_number FROM round_captains rc JOIN accounts a ON a.id=rc.account_id WHERE rc.project_id=? AND (?='' OR a.nostr_npub<>?) ORDER BY rc.round_number DESC LIMIT 1").get(row.id,this.ownerNpub,this.ownerNpub) as {account_id:string;nostr_npub:string;round_number:number}|null;
      const failure=round?.buildStatus==="failed"||round?.buildStatus==="interrupted"?{code:round.buildStatus,section:"active-build"}:null;
      return { id: row.id, teamId: row.team_id, teamName: row.team_name, name: row.name, phase: row.phase, selectedTemplateId: row.selected_template_id, stablePlayUrl: row.stable_play_url, createdAt: row.created_at, selectionStartedAt:row.selection_started_at,selectionClosedAt:row.selection_closed_at,joinedCount:row.joined_count,connectedCount:null,activeInvite:Boolean(row.active_invite),captain:captainRow?{accountId:captainRow.account_id,npub:captainRow.nostr_npub,roundNumber:captainRow.round_number}:null,failure,round };
    });
  }

  adminTeams(): AdminTeamSummary[] {
    return (this.db.query(`SELECT t.id,t.name,t.created_at,
      (SELECT COUNT(*) FROM team_members tm WHERE tm.team_id=t.id) member_count,
      (SELECT COUNT(*) FROM projects p WHERE p.team_id=t.id) project_count
      FROM teams t ORDER BY t.created_at DESC,t.rowid DESC`).all() as Array<{id:string;name:string;created_at:number;member_count:number;project_count:number}>).map((row) => ({
        id: row.id, name: row.name, createdAt: row.created_at, memberCount: row.member_count, projectCount: row.project_count,
      }));
  }

  adminTeamProjectIds(teamId: string, accountId: string): string[] {
    this.requireOwnerAccount(accountId);
    if (!this.db.query("SELECT 1 FROM teams WHERE id=?").get(teamId)) throw new RepositoryError("team_not_found", "That team no longer exists.", 404);
    return (this.db.query("SELECT id FROM projects WHERE team_id=? ORDER BY id").all(teamId) as Array<{id:string}>).map((row)=>row.id);
  }

  groupRun(): GroupRun | null {
    const row=this.db.query("SELECT * FROM group_runs ORDER BY created_at DESC LIMIT 1").get() as {id:string;name:string;status:GroupRunStatus;initial_stage:string;created_at:number;updated_at:number}|null;
    if(!row)return null;
    const ids=(this.db.query("SELECT project_id FROM group_run_projects WHERE group_run_id=? ORDER BY position").all(row.id) as Array<{project_id:string}>).map(x=>x.project_id);
    const results=(this.db.query("SELECT project_id,command,status,code,message,created_at FROM group_command_results WHERE group_run_id=? ORDER BY created_at,id").all(row.id) as Array<{project_id:string;command:GroupCommand;status:GroupProjectResult["status"];code:string|null;message:string;created_at:number}>).map(x=>({projectId:x.project_id,command:x.command,status:x.status,code:x.code,message:x.message,at:x.created_at}));
    return{id:row.id,name:row.name,status:row.status,initialStage:row.initial_stage,selectedProjectIds:ids,results,createdAt:row.created_at,updatedAt:row.updated_at};
  }

  saveGroupRun(accountId:string,input:{name:string;projectIds:string[]}):GroupRun {
    const name=input.name.trim().replace(/\s+/g," ");if(name.length<2||name.length>80)throw new RepositoryError("invalid_group_name","Use a workshop name between 2 and 80 characters.",400);
    const ids=[...new Set(input.projectIds)].slice(0,20);if(!ids.length)throw new RepositoryError("projects_required","Select at least one project.",400);
    const placeholders=ids.map(()=>"?").join(",");const owned=this.db.query(`SELECT p.id FROM projects p JOIN teams t ON t.id=p.team_id WHERE p.id IN (${placeholders}) AND t.creator_account_id=?`).all(...ids,accountId) as Array<{id:string}>;
    if(owned.length!==ids.length)throw new RepositoryError("forbidden","Group Mode can include only projects owned by the facilitator.",403);
    const now=this.now(),existing=this.groupRun(),id=existing?.id??randomUUID();this.db.transaction(()=>{this.db.query("INSERT INTO group_runs(id,name,status,initial_stage,created_by_account_id,created_at,updated_at) VALUES(?,?,'draft','open_play',?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at").run(id,name,accountId,now,now);this.db.query("DELETE FROM group_run_projects WHERE group_run_id=?").run(id);ids.forEach((projectId,index)=>this.db.query("INSERT INTO group_run_projects(group_run_id,project_id,position) VALUES(?,?,?)").run(id,projectId,index));})();return this.groupRun()!;
  }

  runGroupCommand(accountId:string,command:GroupCommand,requestId:string):{run:GroupRun;results:GroupProjectResult[];duplicate:boolean}{
    const run=this.groupRun();if(!run)throw new RepositoryError("group_run_missing","Create a Group Mode workshop first.",409);if(!/^[a-zA-Z0-9_-]{8,128}$/.test(requestId))throw new RepositoryError("invalid_request_id","Use a valid command request ID.",400);
    const prior=this.db.query("SELECT 1 FROM group_action_audit WHERE group_run_id=? AND request_id=?").get(run.id,requestId);if(prior){const rows=this.db.query("SELECT project_id,command,status,code,message,created_at FROM group_command_results WHERE group_run_id=? AND request_id=? ORDER BY rowid").all(run.id,requestId) as Array<{project_id:string;command:GroupCommand;status:GroupProjectResult["status"];code:string|null;message:string;created_at:number}>;return{run,results:rows.map(x=>({projectId:x.project_id,command:x.command,status:x.status,code:x.code,message:x.message,at:x.created_at})),duplicate:true};}
    const at=this.now();const results:GroupProjectResult[]=[];
    if(command==="pause"||command==="resume"){this.db.query("UPDATE group_runs SET status=?,updated_at=? WHERE id=?").run(command==="pause"?"paused":"running",at,run.id);}
    else for(const projectId of run.selectedProjectIds){let result:GroupProjectResult;try{const room=this.project(projectId,accountId);const invalid=command==="start_voting"?room.selectionStartedAt>0:command==="extend_voting"||command==="close_voting"?!(room.phase==="selecting_template"&&room.selectionStartedAt>0&&room.selectionClosedAt===null):command==="start_first_brainstorm"?!room.selectedTemplateId:false;if(invalid){result={projectId,command,status:"skipped",code:"state_not_eligible",message:`Skipped because ${room.name} is not in a state where ${command.replaceAll("_"," ")} is valid.`,at};}else if(command==="open_play")result={projectId,command,status:"succeeded",code:null,message:"Play time is open.",at};else if(command==="start_voting"){this.startTemplateSelection(projectId,accountId);result={projectId,command,status:"succeeded",code:null,message:"Template voting started.",at};}else if(command==="extend_voting"){this.db.query("UPDATE projects SET selection_deadline_at=selection_deadline_at+60000,updated_at=? WHERE id=?").run(at,projectId);result={projectId,command,status:"succeeded",code:null,message:"Voting extended by one minute.",at};}else if(command==="close_voting"){this.closeTemplateSelection(projectId,accountId);result={projectId,command,status:"succeeded",code:null,message:"Voting closed.",at};}else result={projectId,command,status:"succeeded",code:null,message:"First brainstorm is ready.",at};}catch(error){result={projectId,command,status:"failed",code:error instanceof RepositoryError?error.code:"command_failed",message:error instanceof Error?error.message:"Command failed.",at};}results.push(result);}
    this.db.transaction(()=>{this.db.query("INSERT INTO group_action_audit(id,group_run_id,actor_account_id,request_id,command,created_at) VALUES(?,?,?,?,?,?)").run(randomUUID(),run.id,accountId,requestId,command,at);for(const result of results)this.db.query("INSERT INTO group_command_results(id,group_run_id,project_id,request_id,command,status,code,message,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(randomUUID(),run.id,result.projectId,requestId,command,result.status,result.code,result.message,at);this.db.query("UPDATE group_runs SET status=?,initial_stage=?,updated_at=? WHERE id=?").run(command==="pause"?"paused":command==="resume"?"running":"running",command,at,run.id);})();return{run:this.groupRun()!,results,duplicate:false};
  }

  private ensureRoundCaptain(projectId:string,roundNumber:number):{accountId:string;npub:string}|null{
    return this.db.transaction(()=>{
      if(this.ownerNpub)this.db.query("DELETE FROM round_captains WHERE project_id=? AND account_id IN (SELECT id FROM accounts WHERE nostr_npub=?)").run(projectId,this.ownerNpub);
      const candidates=this.db.query("SELECT tm.account_id,a.nostr_npub,tm.role FROM projects p JOIN team_members tm ON tm.team_id=p.team_id JOIN accounts a ON a.id=tm.account_id WHERE p.id=? AND (?='' OR a.nostr_npub<>?) ORDER BY CASE tm.role WHEN 'player' THEN 0 ELSE 1 END,tm.joined_at,tm.account_id").all(projectId,this.ownerNpub,this.ownerNpub) as Array<{account_id:string;nostr_npub:string;role:string}>;
      const eligible=candidates.some(x=>x.role==="player")?candidates.filter(x=>x.role==="player"):candidates;
      const byId=new Map(eligible.map(x=>[x.account_id,x]));
      if(!eligible.length){this.db.query("DELETE FROM round_captains WHERE project_id=? AND round_number=?").run(projectId,roundNumber);this.db.query("DELETE FROM round_captain_cycles WHERE project_id=?").run(projectId);return null;}
      const existing=this.db.query("SELECT rc.account_id,a.nostr_npub FROM round_captains rc JOIN accounts a ON a.id=rc.account_id JOIN projects p ON p.id=rc.project_id JOIN team_members tm ON tm.team_id=p.team_id AND tm.account_id=rc.account_id WHERE rc.project_id=? AND rc.round_number=? AND (?='' OR a.nostr_npub<>?)").get(projectId,roundNumber,this.ownerNpub,this.ownerNpub) as {account_id:string;nostr_npub:string}|null;
      let cycle=this.db.query("SELECT cycle_number,order_json,next_index FROM round_captain_cycles WHERE project_id=?").get(projectId) as {cycle_number:number;order_json:string;next_index:number}|null;let order:string[]=[],next=0,cycleNumber=1;
      if(cycle){try{const parsed=JSON.parse(cycle.order_json);if(Array.isArray(parsed)&&parsed.every(x=>typeof x==="string")){order=parsed;next=cycle.next_index;cycleNumber=cycle.cycle_number;}}catch{order=[];}}
      if(cycle){const consumed=order.slice(0,next).filter(id=>byId.has(id));const remaining=order.slice(next).filter(id=>byId.has(id));order=[...consumed,...remaining];next=consumed.length;}
      if(!cycle){const historical=(this.db.query("SELECT account_id FROM round_captains WHERE project_id=? ORDER BY round_number").all(projectId) as Array<{account_id:string}>).map(x=>x.account_id);const used:string[]=[];for(let index=historical.length-1;index>=0;index--){const id=historical[index]!;if(!byId.has(id)||used.includes(id))break;used.unshift(id);}const remaining=this.shuffledCaptainIds(projectId,cycleNumber,eligible.map(x=>x.account_id).filter(id=>!used.includes(id)));order=[...used,...remaining];next=used.length;}
      if(existing){this.db.query("INSERT INTO round_captain_cycles(project_id,cycle_number,order_json,next_index,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET cycle_number=excluded.cycle_number,order_json=excluded.order_json,next_index=excluded.next_index,updated_at=excluded.updated_at").run(projectId,cycleNumber,JSON.stringify(order),next,this.now());return{accountId:existing.account_id,npub:existing.nostr_npub};}
      while(next<order.length&&!byId.has(order[next]!))next++;
      if(next>=order.length){cycleNumber+=cycle?1:0;order=this.shuffledCaptainIds(projectId,cycleNumber,eligible.map(x=>x.account_id));next=0;}
      const chosen=byId.get(order[next]!)!;next++;
      this.db.query("INSERT INTO round_captain_cycles(project_id,cycle_number,order_json,next_index,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET cycle_number=excluded.cycle_number,order_json=excluded.order_json,next_index=excluded.next_index,updated_at=excluded.updated_at").run(projectId,cycleNumber,JSON.stringify(order),next,this.now());this.db.query("INSERT INTO round_captains(project_id,round_number,account_id,assigned_at) VALUES(?,?,?,?) ON CONFLICT(project_id,round_number) DO UPDATE SET account_id=excluded.account_id,assigned_at=excluded.assigned_at").run(projectId,roundNumber,chosen.account_id,this.now());return{accountId:chosen.account_id,npub:chosen.nostr_npub};})();
  }

  private requireOwnerAccount(accountId: string): void {
    const account = this.db.query("SELECT nostr_npub FROM accounts WHERE id=?").get(accountId) as { nostr_npub: string } | null;
    if (!account || !this.ownerNpub || account.nostr_npub !== this.ownerNpub) {
      throw new RepositoryError("forbidden", "Only the configured Level Up owner can use admin deletion.", 403);
    }
  }

  private deleteProjectRecords(projectId: string): void {
    const runIds = (this.db.query("SELECT id FROM ai_runs WHERE project_id=?").all(projectId) as Array<{ id: string }>).map((row) => row.id);
    for (const runId of runIds) {
      this.db.query("DELETE FROM bot_messages WHERE run_id=?").run(runId);
      this.db.query("DELETE FROM ai_run_attempts WHERE run_id=?").run(runId);
    }
    this.db.query("DELETE FROM ai_runs WHERE project_id=?").run(projectId);
    const traces = this.db.query("SELECT id,fields_json FROM agent_run_traces").all() as Array<{id:string;fields_json:string}>;
    for (const trace of traces) {
      try {
        const fields: unknown = JSON.parse(trace.fields_json);
        if (fields && typeof fields === "object" && !Array.isArray(fields) && (fields as Record<string, unknown>).projectId === projectId) {
          this.db.query("DELETE FROM agent_run_traces WHERE id=?").run(trace.id);
        }
      } catch { /* Invalid legacy trace metadata is unrelated and remains inspectable. */ }
    }
    this.db.query("DELETE FROM projects WHERE id=?").run(projectId);
  }

  private removeOwnerFromCaptainState():void{
    if(!this.ownerNpub)return;
    this.db.transaction(()=>{
      const ownerIds=new Set((this.db.query("SELECT id FROM accounts WHERE nostr_npub=?").all(this.ownerNpub) as Array<{id:string}>).map(row=>row.id));
      if(!ownerIds.size)return;
      this.db.query("DELETE FROM round_captains WHERE account_id IN (SELECT id FROM accounts WHERE nostr_npub=?)").run(this.ownerNpub);
      const cycles=this.db.query("SELECT project_id,order_json,next_index FROM round_captain_cycles").all() as Array<{project_id:string;order_json:string;next_index:number}>;
      for(const cycle of cycles){let parsed:unknown;try{parsed=JSON.parse(cycle.order_json);}catch{continue;}if(!Array.isArray(parsed)||!parsed.every(id=>typeof id==="string"))continue;const consumed=parsed.slice(0,cycle.next_index).filter(id=>!ownerIds.has(id));const remaining=parsed.slice(cycle.next_index).filter(id=>!ownerIds.has(id));const order=[...consumed,...remaining];if(order.length)this.db.query("UPDATE round_captain_cycles SET order_json=?,next_index=?,updated_at=? WHERE project_id=?").run(JSON.stringify(order),consumed.length,this.now(),cycle.project_id);else this.db.query("DELETE FROM round_captain_cycles WHERE project_id=?").run(cycle.project_id);}
    })();
  }

  private shuffledCaptainIds(projectId:string,cycleNumber:number,ids:string[]):string[]{const result=[...ids].sort();for(let index=result.length-1;index>0;index--){const digest=createHash("sha256").update(`${projectId}:${cycleNumber}:${index}:${result.join(",")}`).digest();const swap=digest.readUInt32BE(0)%(index+1);[result[index],result[swap]]=[result[swap]!,result[index]!];}return result;}

  saveAuthSession(tokenHash: string, session: { pubkey: string; npub: string; expiresAt: number }): void {
    this.db.query("INSERT OR REPLACE INTO auth_sessions (token_hash,pubkey,npub,expires_at,created_at) VALUES (?,?,?,?,?)").run(tokenHash,session.pubkey,session.npub,session.expiresAt,this.now());
  }
  readAuthSession(tokenHash: string, nowSeconds: number): { pubkey: string; npub: string; expiresAt: number } | null {
    this.db.query("DELETE FROM auth_sessions WHERE expires_at < ?").run(nowSeconds);
    const row=this.db.query("SELECT pubkey,npub,expires_at FROM auth_sessions WHERE token_hash=? AND expires_at>=?").get(tokenHash,nowSeconds) as {pubkey:string;npub:string;expires_at:number}|null;
    return row ? {pubkey:row.pubkey,npub:row.npub,expiresAt:row.expires_at} : null;
  }
  deleteAuthSession(tokenHash: string): void { this.db.query("DELETE FROM auth_sessions WHERE token_hash=?").run(tokenHash); }

  getAgentTrace(id: string): AgentRunTrace | null {
    return this.readAgentTrace(this.db.query("SELECT * FROM agent_run_traces WHERE id=?").get(id));
  }

  saveAgentTrace(trace: AgentRunTrace): void {
    const safe = sanitizeAgentTraceValue(JSON.parse(JSON.stringify(trace))) as AgentRunTrace;
    this.db.transaction(() => {
      this.db.query(`INSERT INTO agent_run_traces (id,stage,client_name,model,max_turns,status,started_at,completed_at,duration_ms,prompt_bytes,max_output_bytes,output_bytes,input_tokens,output_tokens,cost,goose_session_id,error_code,error_detail,output_preview_json,compiled_input_json,final_payload_json,transcript_truncated,fields_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET stage=excluded.stage,client_name=excluded.client_name,model=excluded.model,max_turns=excluded.max_turns,status=excluded.status,started_at=excluded.started_at,completed_at=excluded.completed_at,duration_ms=excluded.duration_ms,prompt_bytes=excluded.prompt_bytes,max_output_bytes=excluded.max_output_bytes,output_bytes=excluded.output_bytes,input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,cost=excluded.cost,goose_session_id=excluded.goose_session_id,error_code=excluded.error_code,error_detail=excluded.error_detail,output_preview_json=excluded.output_preview_json,compiled_input_json=excluded.compiled_input_json,final_payload_json=excluded.final_payload_json,transcript_truncated=excluded.transcript_truncated,fields_json=excluded.fields_json`).run(
        safe.id, safe.stage, safe.clientName, safe.model, safe.maxTurns, safe.status, safe.startedAt, safe.completedAt, safe.durationMs, safe.promptBytes, safe.maxOutputBytes, safe.outputBytes, safe.inputTokens, safe.outputTokens, safe.cost, safe.gooseSessionId, safe.errorCode, safe.errorDetail, JSON.stringify(safe.outputPreview), safe.compiledInput === null ? null : JSON.stringify(safe.compiledInput), safe.finalPayload === null ? null : JSON.stringify(safe.finalPayload), safe.transcriptTruncated ? 1 : 0, JSON.stringify(safe.fields),
      );
      this.db.query("DELETE FROM agent_run_trace_turns WHERE run_id=?").run(safe.id);
      const insertTurn = this.db.query("INSERT INTO agent_run_trace_turns (run_id,turn_number,observed_at,source,value_json,bytes,truncated) VALUES (?,?,?,?,?,?,?)");
      for (const turn of safe.turns) insertTurn.run(safe.id, turn.number, turn.observedAt, turn.source, JSON.stringify(turn.value), turn.bytes, turn.truncated ? 1 : 0);
    })();
  }

  listAgentTraces(projectId?: string | null): AgentRunTrace[] {
    const rows = projectId
      ? this.db.query("SELECT * FROM agent_run_traces WHERE json_extract(fields_json,'$.projectId')=? ORDER BY started_at DESC,rowid DESC").all(projectId)
      : this.db.query("SELECT * FROM agent_run_traces ORDER BY started_at DESC,rowid DESC").all();
    return rows.map((row) => this.readAgentTrace(row)).filter((trace): trace is AgentRunTrace => trace !== null);
  }

  clearAgentTraces(): void { this.db.query("DELETE FROM agent_run_traces").run(); }

  close(): void {
    releaseAgentTraceStore(this);
    this.db.close();
  }

  private hydrateLobby(row: TeamRow, accountId: string): TeamLobby {
    const members = this.db.query(`
      SELECT tm.account_id, a.nostr_npub, tm.role, tm.joined_at
      FROM team_members tm JOIN accounts a ON a.id = tm.account_id
      WHERE tm.team_id = ? ORDER BY tm.joined_at ASC, a.id ASC
    `).all(row.id) as MemberRow[];
    return {
      id: row.id,
      sessionId: row.session_id,
      name: row.name,
      phase: "lobby",
      isOrganiser: row.creator_account_id === accountId,
      members: members.map((member) => ({ accountId: member.account_id, npub: member.nostr_npub, role: member.role, joinedAt: member.joined_at })),
      projects: (this.db.query("SELECT id, team_id, name, phase, selected_template_id, stable_play_url, created_at FROM projects WHERE team_id = ? ORDER BY created_at DESC, rowid DESC").all(row.id) as Array<{ id: string; team_id: string; name: string; phase: ProjectPhase; selected_template_id: string | null; stable_play_url: string | null; created_at: number }>).map((project) => ({ id: project.id, teamId: project.team_id, name: project.name, phase: project.phase, selectedTemplateId: project.selected_template_id, stablePlayUrl: project.stable_play_url, createdAt: project.created_at })),
      profiles: this.readProfilesForTeam(row.id),
    };
  }

  private projectRow(projectId: string, accountId: string): ProjectRow | null {
    return this.db.query(`SELECT p.id, p.team_id, p.name, p.phase, p.selected_template_id, p.stable_play_url, p.selection_started_at, p.selection_deadline_at, p.selection_closed_at, p.created_at, t.name AS team_name, t.creator_account_id
      FROM projects p JOIN teams t ON t.id = p.team_id JOIN team_members tm ON tm.team_id = t.id
      WHERE p.id = ? AND tm.account_id = ?`).get(projectId, accountId) as ProjectRow | null;
  }

  private hydrateProject(row: ProjectRow, accountId: string): ProjectRoom {
    const rankings = this.rankings(row.id);
    const selections = (this.db.query("SELECT template_id FROM project_template_selections WHERE project_id = ? AND account_id = ? ORDER BY template_id").all(row.id, accountId) as Array<{ template_id: string }>).map((choice) => choice.template_id);
    const templates = this.templates();
    const selectedTemplate = row.selected_template_id ? this.template(row.selected_template_id) : null;
    const round = row.selected_template_id ? this.loop.currentRound(row.id, accountId) : null;
    const captainRoundNumber=round&&["brief","building","playtest","failed"].includes(round.phase)?round.number+1:round?.number??1;
    const captain=this.ensureRoundCaptain(row.id,captainRoundNumber);
    return { id: row.id, teamId: row.team_id, teamName: row.team_name, name: row.name, phase: row.phase, selectedTemplateId: row.selected_template_id, stablePlayUrl: row.stable_play_url, selectedTemplate, isOrganiser: row.creator_account_id === accountId, selectionStartedAt: row.selection_started_at, selectionDeadlineAt: row.selection_deadline_at, selectionClosedAt: row.selection_closed_at, serverTime: this.now(), templates, selections, rankings, topThree: rankings.slice(0, 3), tiedLeaderIds: row.phase === "resolving_template_tie" ? this.tiedLeaderIds(row.id) : [], round, captain:captain?{...captain,roundNumber:captainRoundNumber}:null, profiles:this.readProfilesForTeam(row.team_id), createdAt: row.created_at };
  }

  private readProfilesForTeam(teamId: string): PublicProfile[] {
    const pubkeys=(this.db.query("SELECT a.nostr_pubkey FROM team_members tm JOIN accounts a ON a.id=tm.account_id WHERE tm.team_id=? ORDER BY tm.joined_at,a.id LIMIT ?").all(teamId,MAX_PROFILE_BATCH) as Array<{nostr_pubkey:string}>).map((row)=>row.nostr_pubkey);
    return this.readProfiles(pubkeys);
  }

  private readProfiles(pubkeys: string[]): PublicProfile[] {
    if (!pubkeys.length) return [];
    const rows=this.db.query(`SELECT pubkey,event_json,fetched_at FROM nostr_profile_cache WHERE pubkey IN (${pubkeys.map(()=>"?").join(",")})`).all(...pubkeys) as Array<{pubkey:string;event_json:string;fetched_at:number}>;
    return rows.flatMap((row)=>{try{const event=JSON.parse(row.event_json) as Event;return selectLatestProfile([event],row.pubkey)?[profileFromEvent(row.pubkey,event,row.fetched_at)]:[];}catch{return[];}});
  }

  private templates(): GameTemplate[] {
    const rows = this.db.query("SELECT id, title, description, theme_prompts_json, preview_url, visual FROM game_templates WHERE selectable = 1 ORDER BY rowid").all() as Array<{ id: string; title: string; description: string; theme_prompts_json: string; preview_url: string; visual: string }>;
    return rows.map((row) => ({ id: row.id, title: row.title, description: row.description, themePrompts: JSON.parse(row.theme_prompts_json) as string[], previewUrl: row.preview_url, visual: row.visual }));
  }

  private template(id: string): GameTemplate | null {
    const row = this.db.query("SELECT id, title, description, theme_prompts_json, preview_url, visual FROM game_templates WHERE id = ?").get(id) as { id:string; title:string; description:string; theme_prompts_json:string; preview_url:string; visual:string } | null;
    return row ? { id:row.id,title:row.title,description:row.description,themePrompts:JSON.parse(row.theme_prompts_json) as string[],previewUrl:row.preview_url,visual:row.visual } : null;
  }

  private rankings(projectId: string): TemplateRanking[] {
    const counts = new Map((this.db.query("SELECT template_id, COUNT(*) AS votes FROM project_template_selections WHERE project_id = ? GROUP BY template_id").all(projectId) as Array<{ template_id: string; votes: number }>).map((row) => [row.template_id, row.votes]));
    return this.templates().map((template) => ({ ...template, votes: counts.get(template.id) ?? 0 })).sort((a, b) => b.votes - a.votes || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  }

  private tiedLeaderIds(projectId: string): string[] {
    const rankings = this.rankings(projectId);
    const high = rankings[0]?.votes ?? 0;
    return rankings.filter((template) => template.votes === high).map((template) => template.id).sort();
  }

  private closeExpiredProject(projectId: string): void {
    const row = this.db.query("SELECT phase, selection_started_at, selection_deadline_at FROM projects WHERE id = ?").get(projectId) as { phase: ProjectPhase; selection_started_at:number; selection_deadline_at: number } | null;
    if (row?.phase === "selecting_template" && row.selection_started_at > 0 && this.now() >= row.selection_deadline_at) this.finalizeSelection(projectId, row.selection_deadline_at);
  }

  private finalizeSelection(projectId: string, closedAt: number): void {
    const leaders = this.tiedLeaderIds(projectId);
    const uniqueWinner = leaders.length === 1 ? leaders[0]! : null;
    this.db.query("UPDATE projects SET phase = ?, selected_template_id = ?, selection_closed_at = ?, updated_at = ? WHERE id = ? AND phase = 'selecting_template'").run(uniqueWinner ? "round_1_brainstorm" : "resolving_template_tie", uniqueWinner, closedAt, this.now(), projectId);
    if (uniqueWinner) this.ensureRoundOne(projectId, closedAt);
  }

  private requireProjectMember(projectId: string, accountId: string): ProjectRow {
    const row = this.projectRow(projectId, accountId);
    if (!row) throw new RepositoryError("forbidden", "You are not a member of this project's team.", 403);
    if (!row.selected_template_id) throw new RepositoryError("round_not_ready", "Choose a template before starting Round 1.", 409);
    return row;
  }

  private ensureRoundOne(projectId: string, startedAt?: number): void {
    const project = this.db.query("SELECT selected_template_id, selection_closed_at FROM projects WHERE id = ?").get(projectId) as { selected_template_id: string | null; selection_closed_at: number | null } | null;
    if (!project?.selected_template_id) throw new RepositoryError("round_not_ready", "Choose a template before starting Round 1.", 409);
    const authoritativeStart = startedAt ?? project.selection_closed_at ?? this.now();
    this.loop.ensureFirstRound(projectId, authoritativeStart);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        nostr_pubkey TEXT NOT NULL UNIQUE,
        nostr_npub TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token_hash TEXT PRIMARY KEY,
        pubkey TEXT NOT NULL,
        npub TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS nostr_profile_cache (
        pubkey TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        fetched_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS game_sessions (
        id TEXT PRIMARY KEY,
        creator_account_id TEXT NOT NULL REFERENCES accounts(id),
        status TEXT NOT NULL CHECK (status IN ('lobby', 'active', 'complete')),
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_members (
        session_id TEXT NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('organiser', 'player')),
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, account_id)
      );
      CREATE TABLE IF NOT EXISTS teams (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        creator_account_id TEXT NOT NULL REFERENCES accounts(id),
        phase TEXT NOT NULL CHECK (phase = 'lobby'),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS team_members (
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('organiser', 'player')),
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (team_id, account_id)
      );
      CREATE TABLE IF NOT EXISTS team_invites (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        secret_hash TEXT NOT NULL UNIQUE,
        short_code TEXT UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
        creator_account_id TEXT NOT NULL REFERENCES accounts(id),
        expires_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS game_templates (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL,
        theme_prompts_json TEXT NOT NULL, preview_url TEXT NOT NULL, visual TEXT NOT NULL,
        selectable INTEGER NOT NULL DEFAULT 1 CHECK(selectable IN (0,1))
      );
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN ('selecting_template', 'resolving_template_tie', 'round_1_brainstorm')),
        selected_template_id TEXT REFERENCES game_templates(id),
        selection_started_at INTEGER NOT NULL,
        selection_deadline_at INTEGER NOT NULL,
        selection_closed_at INTEGER,
        repository_ref TEXT,
        stable_play_url TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_template_selections (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        template_id TEXT NOT NULL REFERENCES game_templates(id),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (project_id, account_id, template_id)
      );
      CREATE TABLE IF NOT EXISTS project_creation_requests (
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (team_id, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS rounds (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        number INTEGER NOT NULL CHECK (number = 1),
        phase TEXT NOT NULL CHECK (phase IN ('brainstorm', 'proposals')),
        started_at INTEGER NOT NULL,
        deadline_at INTEGER NOT NULL,
        closed_at INTEGER,
        last_sequence INTEGER NOT NULL DEFAULT 0,
        UNIQUE (project_id, number)
      );
      CREATE TABLE IF NOT EXISTS round_contributions (
        id TEXT PRIMARY KEY,
        round_id TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
        author_account_id TEXT NOT NULL REFERENCES accounts(id),
        body TEXT NOT NULL,
        client_event_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (round_id, client_event_id),
        UNIQUE (round_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS round_events (
        round_id TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('contribution_committed', 'phase_changed')),
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (round_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS team_members_account_idx ON team_members(account_id, joined_at);
      CREATE INDEX IF NOT EXISTS team_invites_team_status_idx ON team_invites(team_id, status);
      CREATE INDEX IF NOT EXISTS projects_team_idx ON projects(team_id, created_at);
      CREATE INDEX IF NOT EXISTS project_selections_project_idx ON project_template_selections(project_id, template_id);
      CREATE INDEX IF NOT EXISTS round_contributions_round_idx ON round_contributions(round_id, sequence);
      CREATE INDEX IF NOT EXISTS round_events_round_idx ON round_events(round_id, sequence);
      CREATE TABLE IF NOT EXISTS agent_run_traces (
        id TEXT PRIMARY KEY, stage TEXT NOT NULL, client_name TEXT NOT NULL, model TEXT, max_turns INTEGER NOT NULL,
        status TEXT NOT NULL, started_at INTEGER NOT NULL, completed_at INTEGER, duration_ms INTEGER, prompt_bytes INTEGER NOT NULL,
        max_output_bytes INTEGER NOT NULL, output_bytes INTEGER, input_tokens INTEGER, output_tokens INTEGER, cost REAL,
        goose_session_id TEXT, error_code TEXT, error_detail TEXT, output_preview_json TEXT, compiled_input_json TEXT,
        final_payload_json TEXT, transcript_truncated INTEGER NOT NULL DEFAULT 0, fields_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS agent_run_trace_turns (
        run_id TEXT NOT NULL REFERENCES agent_run_traces(id) ON DELETE CASCADE, turn_number INTEGER NOT NULL,
        observed_at INTEGER NOT NULL, source TEXT NOT NULL, value_json TEXT NOT NULL, bytes INTEGER NOT NULL,
        truncated INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (run_id, turn_number)
      );
      CREATE TABLE IF NOT EXISTS round_captains (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, round_number INTEGER NOT NULL,
        account_id TEXT NOT NULL REFERENCES accounts(id), assigned_at INTEGER NOT NULL,
        PRIMARY KEY(project_id,round_number)
      );
      CREATE TABLE IF NOT EXISTS round_captain_cycles (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,cycle_number INTEGER NOT NULL,
        order_json TEXT NOT NULL,next_index INTEGER NOT NULL,updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS group_runs (
        id TEXT PRIMARY KEY,name TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('draft','running','paused','completed')),
        initial_stage TEXT NOT NULL,created_by_account_id TEXT NOT NULL REFERENCES accounts(id),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS group_run_projects (
        group_run_id TEXT NOT NULL REFERENCES group_runs(id) ON DELETE CASCADE,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,PRIMARY KEY(group_run_id,project_id)
      );
      CREATE TABLE IF NOT EXISTS group_action_audit (
        id TEXT PRIMARY KEY,group_run_id TEXT NOT NULL REFERENCES group_runs(id) ON DELETE CASCADE,actor_account_id TEXT NOT NULL REFERENCES accounts(id),
        request_id TEXT NOT NULL,command TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(group_run_id,request_id)
      );
      CREATE TABLE IF NOT EXISTS group_command_results (
        id TEXT PRIMARY KEY,group_run_id TEXT NOT NULL REFERENCES group_runs(id) ON DELETE CASCADE,project_id TEXT NOT NULL,
        request_id TEXT NOT NULL,command TEXT NOT NULL,status TEXT NOT NULL,code TEXT,message TEXT NOT NULL,created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_run_traces_started_idx ON agent_run_traces(started_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS agent_run_trace_turns_run_idx ON agent_run_trace_turns(run_id, turn_number);
    `);
    const inviteColumns = this.db.query("PRAGMA table_info(team_invites)").all() as Array<{name:string}>;
    if (!inviteColumns.some(column => column.name === "short_code")) this.db.exec("ALTER TABLE team_invites ADD COLUMN short_code TEXT");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS team_invites_short_code_idx ON team_invites(short_code) WHERE short_code IS NOT NULL");
    const columns = this.db.query("PRAGMA table_info(game_templates)").all() as Array<{name:string}>;
    if (!columns.some(column => column.name === "selectable")) this.db.exec("ALTER TABLE game_templates ADD COLUMN selectable INTEGER NOT NULL DEFAULT 1 CHECK(selectable IN (0,1))");
    const legacySeed=this.db.query("INSERT OR IGNORE INTO game_templates(id,title,description,theme_prompts_json,preview_url,visual,selectable) VALUES(?,?,?,?,?,?,0)");
    for(const template of LEGACY_TEMPLATES) legacySeed.run(template.id,template.title,template.description,JSON.stringify(template.themePrompts),template.previewUrl,template.visual);
    this.db.query(`UPDATE game_templates SET selectable=0 WHERE id IN (${LEGACY_TEMPLATE_IDS.map(()=>"?").join(",")})`).run(...LEGACY_TEMPLATE_IDS);
    const reconcile = this.db.query(`INSERT INTO game_templates (id,title,description,theme_prompts_json,preview_url,visual,selectable) VALUES (?,?,?,?,?,?,1)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,theme_prompts_json=excluded.theme_prompts_json,preview_url=excluded.preview_url,visual=excluded.visual,selectable=1`);
    for (const template of CURATED_TEMPLATES) reconcile.run(template.id, template.title, template.description, JSON.stringify(template.themePrompts), template.previewUrl, template.visual);
  }

  private readAgentTrace(value: unknown): AgentRunTrace | null {
    if (!value || typeof value !== "object") return null;
    const row = value as Record<string, unknown>;
    try {
      const turns = this.db.query("SELECT turn_number,observed_at,source,value_json,bytes,truncated FROM agent_run_trace_turns WHERE run_id=? ORDER BY turn_number").all(String(row.id)) as Array<Record<string, unknown>>;
      const parse = (raw: unknown) => typeof raw === "string" ? JSON.parse(raw) as unknown : null;
      return sanitizeAgentTraceValue({
        id: String(row.id), stage: String(row.stage), clientName: String(row.client_name), model: row.model === null ? null : String(row.model), maxTurns: Number(row.max_turns), status: row.status,
        startedAt: Number(row.started_at), completedAt: row.completed_at === null ? null : Number(row.completed_at), durationMs: row.duration_ms === null ? null : Number(row.duration_ms), promptBytes: Number(row.prompt_bytes), maxOutputBytes: Number(row.max_output_bytes),
        outputBytes: row.output_bytes === null ? null : Number(row.output_bytes), inputTokens: row.input_tokens === null ? null : Number(row.input_tokens), outputTokens: row.output_tokens === null ? null : Number(row.output_tokens), cost: row.cost === null ? null : Number(row.cost),
        gooseSessionId: row.goose_session_id === null ? null : String(row.goose_session_id), errorCode: row.error_code === null ? null : String(row.error_code), errorDetail: row.error_detail === null ? null : String(row.error_detail), outputPreview: parse(row.output_preview_json),
        compiledInput: parse(row.compiled_input_json), finalPayload: parse(row.final_payload_json), transcriptTruncated: Number(row.transcript_truncated) === 1, fields: parse(row.fields_json) ?? {},
        turns: turns.map((turn) => ({ number: Number(turn.turn_number), observedAt: Number(turn.observed_at), source: turn.source === "acp" ? "acp" : "provider", value: parse(turn.value_json), bytes: Number(turn.bytes), truncated: Number(turn.truncated) === 1 })),
      }) as AgentRunTrace;
    } catch { return null; }
  }
}
