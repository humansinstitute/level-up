import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { nip19 } from "nostr-tools";
import { AppFooter, AuthChoices, ConversationBubble, createSelectionRequestGate, countdownState, formatCountdown, normalizeProjectRoom, normalizeRoundOutboxRecord, normalizeRoundSocketMessage, normalizeTeam, normalizeTeamListPayload, projectIdFromPath, ProjectRoomView, remainingWholeSeconds, selectionContextFromPath, teamSelectionDestination, TEAM_UPDATE_MESSAGE, TeamChooserView, type ProjectRoom, type Team } from "./App";

const templates = [
  { id: "maze", title: "Maze", description: "Escape", themePrompts: ["Hero"], previewUrl: "/templates/maze/index.html", visual: "maze", votes: 3 },
  { id: "snake", title: "Snake", description: "Grow", themePrompts: ["Trail"], previewUrl: "/templates/snake/index.html", visual: "snake", votes: 2 },
  { id: "pong", title: "Pong", description: "Defend", themePrompts: ["Court"], previewUrl: "/templates/pong/index.html", visual: "pong", votes: 1 },
  { id: "frog", title: "Frog", description: "Cross", themePrompts: ["World"], previewUrl: "/templates/frog/index.html", visual: "frog", votes: 0 },
];
const project: ProjectRoom = { id: "project one", teamId: "team", teamName: "Crew", name: "Arcade", phase: "selecting_template", selectedTemplateId: null, stablePlayUrl: null, selectedTemplate: null, isOrganiser: true, selectionStartedAt: 1_000, selectionDeadlineAt: 177_000, selectionClosedAt: null, serverTime: 1_000, templates, selections: ["maze", "snake"], rankings: templates, topThree: templates.slice(0, 3), tiedLeaderIds: [], round: null, createdAt: 1_000 };
const noop = () => undefined;

describe("project client presentation", () => {
  test("makes player-account creation the primary first-login choice", () => {
    const html = renderToStaticMarkup(<AuthChoices deviceNpub={null} busy={false} checking={false} onCreatePlayer={noop} onResumeDevice={noop} onSignInWithNostr={noop} />);
    expect(html.indexOf("Create a player account")).toBeLessThan(html.indexOf("Sign in with Nostr"));
    expect(html).toMatch(/primary-button[^>]*>[\s\S]*Create a player account/);
    expect(html).toMatch(/secondary-auth[^>]*>[\s\S]*Sign in with Nostr/);
  });

  test("keeps the existing-device return choices unchanged", () => {
    const html = renderToStaticMarkup(<AuthChoices deviceNpub="npub1existingplayer" busy={false} checking={false} onCreatePlayer={noop} onResumeDevice={noop} onSignInWithNostr={noop} />);
    expect(html).toMatch(/primary-button[^>]*>[\s\S]*Sign in with Nostr/);
    expect(html).toMatch(/secondary-auth[^>]*>[\s\S]*Continue as this device player/);
  });

  test("normalizes a pre-project team payload instead of crashing the lobby", () => {
    const team = normalizeTeam({ id: "team", sessionId: "session", name: "Crew", phase: "lobby", isOrganiser: true, members: undefined });
    expect(team.members).toEqual([]);
    expect(team.projects).toEqual([]);
    expect(() => renderToStaticMarkup(<><span>{team.projects.length} total</span><span>{team.members.length} here</span></>)).not.toThrow();
  });

  test("normalizes malformed team collections and rejects invalid team identities", () => {
    const team = normalizeTeam({ id: "team", sessionId: "session", name: "Crew", phase: "lobby", members: "old", projects: { stale: true } });
    expect(team.members).toEqual([]);
    expect(team.projects).toEqual([]);
    expect(() => normalizeTeam(null)).toThrow("invalid team response");
    expect(() => normalizeTeam({ id: "team", name: "Crew" })).toThrow("invalid team response");
  });

  test("treats a missing or malformed team-list collection as a recoverable update mismatch", () => {
    expect(() => normalizeTeamListPayload({})).toThrow(TEAM_UPDATE_MESSAGE);
    expect(() => normalizeTeamListPayload({ teams: null })).toThrow(TEAM_UPDATE_MESSAGE);
    expect(normalizeTeamListPayload({ teams: [] })).toEqual([]);
  });

  test("normalizes the previous server round shape before rendering a new client", () => {
    const legacy = normalizeProjectRoom({
      ...project,
      phase: "round_1_brainstorm",
      selectedTemplateId: "maze",
      selectedTemplate: templates[0],
      round: {
        id: "legacy-round",
        projectId: project.id,
        number: 1,
        phase: "proposals",
        startedAt: 1_000,
        deadlineAt: 301_000,
        closedAt: 4_000,
        serverTime: 4_000,
        lastSequence: 2,
        contributions: [],
      },
    });
    expect(legacy.round?.selections).toEqual([]);
    expect(legacy.round?.proposals).toEqual([]);
    expect(legacy.round?.feedback).toEqual([]);
    expect(legacy.round?.feedbackHistory).toEqual([]);
    expect(legacy.round?.versionHistory).toEqual([]);
    expect(legacy.round?.proposalVoteAllowance).toBe(5);
    expect(legacy.stablePlayUrl).toBeNull();
    expect(() => renderToStaticMarkup(<ProjectRoomView project={legacy} draft={[]} remaining={0} busy={false} status="" onChoose={noop} onClose={noop} onResolve={noop} />)).not.toThrow();
  });

  test("normalizes the previous outbox shape to an actionable non-resend state",()=>{
    expect(normalizeRoundOutboxRecord({clientEventId:"old-event",projectId:"project",body:"Old idea",status:"pending",createdAt:5})).toEqual(expect.objectContaining({roundId:"",roundNumber:0,error:expect.stringContaining("predates round-safe delivery")}));
    expect(normalizeRoundOutboxRecord({clientEventId:"new-event",projectId:"project",roundId:"round-2",roundNumber:2,body:"New idea",status:"pending",createdAt:6})).toEqual(expect.objectContaining({roundId:"round-2",roundNumber:2,error:undefined}));
  });

  test("normalizes current socket snapshots and rejects invalid required round identity",()=>{
    const round={id:"round",projectId:"project",number:2,phase:"brainstorm",startedAt:1,deadlineAt:2,serverTime:1,lastSequence:0,contributions:[],feedbackHistory:[]};
    expect(normalizeRoundSocketMessage({type:"round.sync",round})).toEqual(expect.objectContaining({type:"round.sync",round:expect.objectContaining({id:"round",proposalVoteAllowance:5,feedback:[],feedbackHistory:[]})}));
    expect(()=>normalizeRoundSocketMessage({type:"round.sync",round:{...round,id:null}})).toThrow(TEAM_UPDATE_MESSAGE);
    expect(()=>normalizeRoundSocketMessage({type:"round.sync",round:{...round,contributions:[{id:"message-without-author"}]}})).toThrow(TEAM_UPDATE_MESSAGE);
  });

  test("parses encoded project routes without accepting unrelated paths", () => {
    expect(projectIdFromPath("/projects/project%20one")).toBe("project one");
    expect(projectIdFromPath("/projects/%E0%A4%A")).toBeNull();
    expect(projectIdFromPath("/teams/team")).toBeNull();
    expect(selectionContextFromPath("/teams/team%20two")).toEqual({ kind: "team", id: "team two" });
    expect(selectionContextFromPath("/projects/project%20one")).toEqual({ kind: "project", id: "project one" });
    expect(selectionContextFromPath("/")).toEqual({ kind: "root" });
  });

  test("keeps the last explicit team or project selection authoritative over delayed responses", () => {
    const gate = createSelectionRequestGate({ kind: "root" });
    const teamA = gate.select({ kind: "team", id: "team-a" });
    const teamB = gate.select({ kind: "team", id: "team-b" });
    expect(gate.accepts({ kind: "team", id: "team-a" }, teamA)).toBeFalse();
    expect(gate.accepts({ kind: "team", id: "team-b" }, teamB)).toBeTrue();
    const projectX = gate.select({ kind: "project", id: "project-x" });
    const projectY = gate.select({ kind: "project", id: "project-y" });
    expect(gate.accepts({ kind: "project", id: "project-x" }, projectX)).toBeFalse();
    expect(gate.accepts({ kind: "project", id: "project-y" }, projectY)).toBeTrue();
  });

  test("opens only a non-lead member's sole active project after team selection", () => {
    const summary = { id: "project-a", teamId: "team-a", name: "Arcade", phase: "round_1_brainstorm" as const, selectedTemplateId: "maze", stablePlayUrl: null, createdAt: 1 };
    const member: Team = { id: "team-a", sessionId: "session", name: "A", phase: "lobby", isOrganiser: false, members: [], projects: [summary] };

    expect(teamSelectionDestination(member)).toEqual({ kind: "project", id: "project-a" });
    expect(teamSelectionDestination({ ...member, isOrganiser: true })).toEqual({ kind: "team", id: "team-a" });
    expect(teamSelectionDestination({ ...member, projects: [] })).toEqual({ kind: "team", id: "team-a" });
    expect(teamSelectionDestination({ ...member, projects: [summary, { ...summary, id: "project-b" }] })).toEqual({ kind: "team", id: "team-a" });
  });

  test("keeps an explicit team route as the lobby navigation boundary", () => {
    const teamRoute = selectionContextFromPath("/teams/team-a");
    expect(teamRoute).toEqual({ kind: "team", id: "team-a" });
    const gate = createSelectionRequestGate({ kind: "project", id: "project-a" });
    gate.select(teamRoute);
    expect(gate.current()).toBe("team:team-a");
  });

  test("fences stale refreshes across back, forward, and route-derived reload context", () => {
    const reloaded = selectionContextFromPath("/projects/project-y");
    const gate = createSelectionRequestGate(reloaded);
    const reloadRequest = gate.refresh(reloaded);
    const backTeam = selectionContextFromPath("/teams/team-b");
    gate.select(backTeam);
    expect(gate.accepts(reloaded, reloadRequest)).toBeFalse();
    const teamRequest = gate.refresh(backTeam);
    const forwardProject = selectionContextFromPath("/projects/project-y");
    gate.select(forwardProject);
    expect(gate.accepts(backTeam, teamRequest)).toBeFalse();
    expect(gate.current()).toBe("project:project-y");
  });

  test("team choices remain tappable during an older selection request", () => {
    const team: Team = { id: "team-a", sessionId: "session", name: "A", phase: "lobby", isOrganiser: false, members: [], projects: [] };
    const html = renderToStaticMarkup(<TeamChooserView userNpub="npub1player" teams={[team, { ...team, id: "team-b", name: "B" }]} teamName="" joinInput="" busy onTeamName={noop} onJoinInput={noop} onCreate={noop} onJoin={noop} onOpenTeam={noop} />);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('href="/teams/team-a"');
    expect(html).toContain('href="/teams/team-b"');
    expect(html).not.toMatch(/<button[^>]*>[^<]*<a|<a[^>]*>[^<]*<button/);
    expect(html.match(/disabled=""/g)?.length ?? 0).toBe(1);
  });

  test("derives the 02:56 countdown from server time and clamps at zero", () => {
    expect(remainingWholeSeconds(177_000, 1_000, 0)).toBe(176);
    expect(formatCountdown(176)).toBe("02:56");
    expect(remainingWholeSeconds(177_000, 1_000, 176_500)).toBe(0);
    expect(formatCountdown(0)).toBe("00:00");
  });

  test("uses the urgent threshold at 21 seconds and a distinct zero state", () => {
    expect(countdownState(22)).toBe("normal");
    expect(countdownState(21)).toBe("urgent");
    expect(countdownState(1)).toBe("urgent");
    expect(countdownState(0)).toBe("zero");
  });

  test("renders server top-three totals and accessible timer state", () => {
    const html = renderToStaticMarkup(<ProjectRoomView project={project} draft={project.selections} remaining={176} busy={false} status="Saved" onChoose={noop} onClose={noop} onResolve={noop} />);
    expect(html).toContain("02:56");
    expect(html).toContain("Live top three");
    expect(html).toContain("Maze");
    expect(html).toContain(">3</em>");
    expect(html).toContain('role="timer"');
    expect(html).toContain('aria-label="176 seconds remaining"');
  });

  test("renders an untimed play-first gallery before the organiser starts voting", () => {
    const preview = { ...project, selectionStartedAt: 0, selectionDeadlineAt: 0, selections: [], rankings: templates.map((template) => ({ ...template, votes: 0 })), topThree: templates.slice(0, 3).map((template) => ({ ...template, votes: 0 })) };
    const html = renderToStaticMarkup(<ProjectRoomView project={preview} draft={[]} remaining={0} busy={false} status="Try the games" onChoose={noop} onClose={noop} onResolve={noop} />);
    expect(html).toContain("TRY THE GAMES");
    expect(html).toContain("Try the games, soon you’ll have to select one to build on and make better.");
    expect(html).toContain("Start Voting");
    expect(html).toContain("Play preview");
    expect(html).not.toContain("Ready to choose?");
    expect(html).not.toContain("NO COUNTDOWN");
    expect(html).not.toContain("PLAY FIRST");
    expect(html).not.toContain('role="timer"');
    expect(html).not.toContain("Live top three");
    expect(html).not.toContain(">Choose</button>");
    expect(html).not.toContain("Time is up");
  });

  test("uses a verified Nostr profile picture and links the product footer", () => {
    const pubkey = "a".repeat(64);
    const npub = nip19.npubEncode(pubkey);
    const html = renderToStaticMarkup(<><ConversationBubble authorNpub={npub} profileMap={{ [pubkey]: { pubkey, npub, displayName: "Extension Player", picture: "https://example.com/profile.webp", about: "", metadata: {}, fetchedAt: 1 } }} variant="idea" status="sent" metadata="#1" message="Hello" /><AppFooter /></>);
    expect(html).toContain("Extension Player");
    expect(html).toContain('src="https://example.com/profile.webp"');
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html).toContain('href="https://otherstuff.ai"');
    expect(html).toContain("Vibed with Love by");
  });

  test("renders urgent and zero timer classes", () => {
    const urgent = renderToStaticMarkup(<ProjectRoomView project={project} draft={[]} remaining={21} busy={false} status="" onChoose={noop} onClose={noop} onResolve={noop} />);
    const zero = renderToStaticMarkup(<ProjectRoomView project={project} draft={[]} remaining={0} busy={false} status="" onChoose={noop} onClose={noop} onResolve={noop} />);
    expect(urgent).toContain("voxel-timer urgent");
    expect(urgent).toContain("00:21");
    expect(zero).toContain("voxel-timer zero");
    expect(zero).toContain("Time is up");
  });

  test("renders the shared round, pending delivery feedback, and proposal boundary", () => {
    const brainstorm: ProjectRoom = { ...project, phase: "round_1_brainstorm", selectedTemplateId: "maze", selectedTemplate: templates[0]!, round: { id: "round", projectId: project.id, number: 1, phase: "brainstorm", startedAt: 1_000, deadlineAt: 301_000, votingDeadlineAt: null, closedAt: null, serverTime: 1_000, lastSequence: 1, proposalVoteAllowance: 5, contributions: [{ id: "idea-1", roundId: "round", authorAccountId: "member", authorNpub: "npub1abcdefghijklmnopqrstuvwxyz0123456789", body: "Add moon boots", clientEventId: "event-1-long", sequence: 1, createdAt: 2_000 }], proposals: [], selections: [], rankings: null, brief: null, build: null, feedback: [], feedbackHistory: [], priorFeedback: null } };
    const html = renderToStaticMarkup(<ProjectRoomView project={brainstorm} draft={[]} remaining={0} roundRemaining={300} pending={[{ clientEventId: "pending-event", projectId: project.id, roundId:"round", roundNumber:1, body: "Low gravity", status: "pending", createdAt: 3_000 }]} idea="New boss" connection="live" busy={false} status="Connected" onChoose={noop} onClose={noop} onResolve={noop} />);
    expect(html).toContain("ROUND 1 · BRAINSTORM");
    expect(html).toContain("Add moon boots");
    expect(html).toContain("Low gravity");
    expect(html).toContain("pending");
    expect(html).toContain("Close early and generate proposals");
    expect(html).toContain("automatically reconciles ideas");

    const proposals = renderToStaticMarkup(<ProjectRoomView project={{ ...brainstorm, round: { ...brainstorm.round!, phase: "proposals", closedAt: 4_000, proposals: [{ id: "proposal", roundId: "round", position: 1, title: "Moon boots", playerChange: "Add moon boots", implementationScope: "Tune movement", acceptanceCriteria: ["Boots work"], ideaReferences: [1] }] } }} draft={[]} remaining={0} busy={false} status="" onChoose={noop} onClose={noop} onResolve={noop} />);
    expect(proposals).toContain("Review requirement cards");
    expect(proposals).toContain("Moon boots");
    expect(proposals).not.toContain("Close brainstorm and generate proposals");

    const failed=renderToStaticMarkup(<ProjectRoomView project={brainstorm} draft={[]} remaining={0} pending={[{clientEventId:"failed-event",projectId:project.id,roundId:"round",roundNumber:1,body:"Retry me",status:"failed",createdAt:4_000,error:"The socket expired."}]} busy={false} status="" onChoose={noop} onClose={noop} onResolve={noop}/>);
    expect(failed).toContain("The socket expired.");expect(failed).toContain("Retry");expect(failed).toContain("Dismiss");
  });

  test("shows captain-only tie and proposal-voting actions with friendly waiting copy", () => {
    const captainNpub="npub1captainfriendlyidentity";
    const tied={...project,phase:"resolving_template_tie" as const,tiedLeaderIds:["maze","snake"],captain:{accountId:"captain",npub:captainNpub,roundNumber:1}};
    const waitingTie=renderToStaticMarkup(<ProjectRoomView project={tied} draft={[]} remaining={0} viewerNpub="npub1organiser" isOwnerAdmin={false} busy={false} status="" onChoose={noop} onClose={noop} onResolve={noop}/>);
    expect(waitingTie).toContain("Waiting for the Round Captain");expect(waitingTie).toContain("the Round Captain, will choose");expect(waitingTie).not.toContain(captainNpub);
    const captainTie=renderToStaticMarkup(<ProjectRoomView project={tied} draft={[]} remaining={0} viewerNpub={captainNpub} isOwnerAdmin={false} busy={false} status="" onChoose={noop} onClose={noop} onResolve={noop}/>);
    expect(captainTie).toContain("As Round Captain");expect(captainTie).not.toMatch(/<button[^>]*disabled=""[^>]*>Maze/);

    const review={...tied,phase:"round_1_brainstorm" as const,selectedTemplateId:"maze",selectedTemplate:templates[0]!,round:{id:"round",projectId:project.id,number:1,phase:"proposals" as const,startedAt:1,deadlineAt:2,votingDeadlineAt:null,closedAt:2,serverTime:2,lastSequence:0,proposalVoteAllowance:5,contributions:[],proposals:[],selections:[],rankings:null,brief:null,build:null,feedback:[],feedbackHistory:[],versionHistory:[],priorFeedback:null}};
    const waitingReview=renderToStaticMarkup(<ProjectRoomView project={review} draft={[]} remaining={0} viewerNpub="npub1organiser" isOwnerAdmin={false} busy={false} status="" onChoose={noop} onClose={noop} onResolve={noop}/>);
    expect(waitingReview).toContain("this round’s captain, to open voting");expect(waitingReview).toContain('class="round-player-identity is-captain"');expect(waitingReview).toContain('class="round-captain-badge">ROUND CAPTAIN');expect(waitingReview).not.toContain(">Open voting →</button>");expect(waitingReview).not.toContain(captainNpub);
    const captainReview=renderToStaticMarkup(<ProjectRoomView project={review} draft={[]} remaining={0} viewerNpub={captainNpub} isOwnerAdmin={false} busy={false} status="" onChoose={noop} onClose={noop} onResolve={noop}/>);
    expect(captainReview).toContain('class="round-player-identity is-captain"');expect(captainReview).toContain('class="round-captain-badge">ROUND CAPTAIN');expect(captainReview).toContain(">Open voting →</button>");
  });

  test("reduced motion disables the urgent pulse while retaining visual urgency", async () => {
    const css = await Bun.file(new URL("./styles.css", import.meta.url)).text();
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce[\s\S]*?\.voxel-timer\.urgent\s*\{\s*animation:\s*none;/);
    expect(css).toContain(".voxel-timer.urgent");
    expect(css).toMatch(/\.template-voting-action \.primary-button\s*\{[^}]*display:\s*flex;[^}]*justify-content:\s*center;/);
  });

  test("does not restore retired feedback history from a previous payload",()=>{
    const feedback={id:"feedback",authorAccountId:"member",authorNpub:"npub1member",worked:"Round one worked",improve:"Round one improve",nextIdea:"Round one next",clientEventId:"feedback-event",submittedAt:10};
    const current=normalizeProjectRoom({...project,phase:"round_1_brainstorm",selectedTemplateId:"maze",selectedTemplate:templates[0],round:{id:"round-3",projectId:project.id,number:3,phase:"brainstorm",startedAt:20,deadlineAt:30,serverTime:20,lastSequence:0,contributions:[],feedbackHistory:[{roundNumber:1,feedback:[feedback]},{roundNumber:2,feedback:[{...feedback,id:"feedback-2",worked:"Round two worked"}]}]}});
    const html=renderToStaticMarkup(<ProjectRoomView project={current} draft={[]} remaining={0} busy={false} status="" onChoose={noop} onClose={noop} onResolve={noop}/>);
    expect(html).not.toContain("Feedback history");expect(html).not.toContain("Round one worked");expect(html).not.toContain("Round two worked");
  });
});
