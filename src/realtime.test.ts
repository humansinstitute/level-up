import { describe, expect, test } from "bun:test";
import { AuthService } from "./auth";
import { createApplication } from "./api";
import type { RoundSnapshot } from "./loop";
import { RoundRealtimeHub, type RoundSocketData } from "./realtime";
import { RepositoryError, SqliteTeamRepository, type TeamRepository } from "./storage";

type FakeSocket = {
  data: RoundSocketData;
  sent: Array<Record<string, unknown>>;
  send: (payload: string) => void;
  close: () => void;
};

function setupSelectedProject() {
  const repository = new SqliteTeamRepository(":memory:", { now: () => Date.now(), brainstormDurationSeconds: 300 });
  const organiser = repository.accountForNostr("d".repeat(64), "npub-organiser");
  const player = repository.accountForNostr("e".repeat(64), "npub-player");
  const team = repository.createTeam(organiser.id, "Socket Crew");
  repository.redeemInvite(player.id, team.invite.secret);
  const created = repository.createProject(team.team.id, organiser.id, "Socket World");
  repository.startTemplateSelection(created.id, organiser.id);
  repository.replaceTemplateSelections(created.id, organiser.id, ["citadel-strike", "skyline-sprint"]);
  repository.replaceTemplateSelections(created.id, player.id, ["citadel-strike", "village-games"]);
  const project = repository.closeTemplateSelection(created.id, organiser.id);
  return { repository, organiser, player, project };
}

function socket(data: RoundSocketData): FakeSocket {
  const fake: FakeSocket = { data, sent: [], send(payload) { this.sent.push(JSON.parse(payload) as Record<string, unknown>); }, close() {} };
  return fake;
}

test("WebSocket hub broadcasts only committed events and reconnects from a sequence", () => {
  const { repository, organiser, player, project } = setupSelectedProject();
  const hub = new RoundRealtimeHub(new AuthService({ accessMode: "open" }), repository);
  const organiserSocket = socket({ projectId: project.id, accountId: organiser.id, roundNumber:1, afterSequence: 0 });
  const playerSocket = socket({ projectId: project.id, accountId: player.id, roundNumber:1, afterSequence: 0 });
  hub.open(organiserSocket as unknown as Bun.ServerWebSocket<RoundSocketData>);
  hub.open(playerSocket as unknown as Bun.ServerWebSocket<RoundSocketData>);

  hub.message(playerSocket as unknown as Bun.ServerWebSocket<RoundSocketData>, JSON.stringify({ type: "contribution.submit", clientEventId: "socket-event-001", body: "Add comet power-ups" }));
  expect(playerSocket.sent).toContainEqual(expect.objectContaining({ type: "contribution.ack", status: "sent", sequence: 1 }));
  expect(playerSocket.sent).toContainEqual(expect.objectContaining({ type: "round.event", round: expect.objectContaining({ lastSequence: 1 }) }));
  expect(organiserSocket.sent).toContainEqual(expect.objectContaining({ type: "round.event", event: expect.objectContaining({ type: "contribution_committed", sequence: 1 }) }));

  const organiserBroadcasts = organiserSocket.sent.length;
  hub.message(playerSocket as unknown as Bun.ServerWebSocket<RoundSocketData>, JSON.stringify({ type: "contribution.submit", clientEventId: "socket-event-001", body: "retry" }));
  expect(organiserSocket.sent).toHaveLength(organiserBroadcasts);

  hub.message(organiserSocket as unknown as Bun.ServerWebSocket<RoundSocketData>, JSON.stringify({ type: "brainstorm.close" }));
  expect(playerSocket.sent).toContainEqual(expect.objectContaining({ type: "round.event", round: expect.objectContaining({ phase: "proposals", lastSequence: 2 }) }));

  const reconnecting = socket({ projectId: project.id, accountId: player.id, roundNumber:1, afterSequence: 1 });
  hub.open(reconnecting as unknown as Bun.ServerWebSocket<RoundSocketData>);
  expect(reconnecting.sent[0]).toEqual(expect.objectContaining({ type: "round.sync", events: [expect.objectContaining({ sequence: 2, type: "phase_changed" })], round: expect.objectContaining({ phase: "proposals" }) }));

  hub.close(organiserSocket as unknown as Bun.ServerWebSocket<RoundSocketData>);
  hub.close(playerSocket as unknown as Bun.ServerWebSocket<RoundSocketData>);
  hub.close(reconnecting as unknown as Bun.ServerWebSocket<RoundSocketData>);
  repository.close();
});

test("all clients receive authoritative proposal-generation running and failed snapshots", async () => {
  let rejectGeneration:(error:Error)=>void=()=>undefined;
  const generation=new Promise<never>((_resolve,reject)=>{rejectGeneration=reject;});
  const {repository,organiser,player,project}=setupSelectedProject();
  const wrapped=new Proxy(repository,{get(target,property){
    if(property==="closeBrainstorm")return (projectId:string,accountId:string)=>{
      const round=target.round(projectId,accountId);
      (target as any).db.query("UPDATE collaboration_rounds SET proposal_generation_status='running',proposal_generation_attempts=proposal_generation_attempts+1 WHERE id=?").run(round.id);
      return generation.catch((error)=>{(target as any).db.query("UPDATE collaboration_rounds SET proposal_generation_status='failed',proposal_generation_error='The proposal agent could not finish. Try again.' WHERE id=?").run(round.id);throw error;});
    };
    const value=(target as any)[property];return typeof value==="function"?value.bind(target):value;
  }}) as TeamRepository;
  const hub=new RoundRealtimeHub(new AuthService({accessMode:"open"}),wrapped);
  const organiserSocket=socket({projectId:project.id,accountId:organiser.id,roundNumber:1,afterSequence:0});
  const playerSocket=socket({projectId:project.id,accountId:player.id,roundNumber:1,afterSequence:0});
  hub.open(organiserSocket as any);hub.open(playerSocket as any);
  hub.message(organiserSocket as any,JSON.stringify({type:"brainstorm.close"}));
  await Bun.sleep(5);
  for(const client of [organiserSocket,playerSocket])expect(client.sent).toContainEqual(expect.objectContaining({type:"round.sync",round:expect.objectContaining({proposalGeneration:expect.objectContaining({status:"running"})})}));
  const reconnecting=socket({projectId:project.id,accountId:player.id,roundNumber:1,afterSequence:0});hub.open(reconnecting as any);
  expect(reconnecting.sent[0]).toEqual(expect.objectContaining({type:"round.sync",round:expect.objectContaining({proposalGeneration:expect.objectContaining({status:"running"})})}));
  rejectGeneration(new Error("fixture failure"));await Bun.sleep(5);
  for(const client of [organiserSocket,playerSocket])expect(client.sent).toContainEqual(expect.objectContaining({type:"round.sync",round:expect.objectContaining({proposalGeneration:expect.objectContaining({status:"failed"})})}));
  repository.close();
});

test("HTTP early close broadcasts the proposal splash state to every connected client", async () => {
  let rejectGeneration:(error:Error)=>void=()=>undefined;
  const generation=new Promise<never>((_resolve,reject)=>{rejectGeneration=reject;});
  const {repository,organiser,player,project}=setupSelectedProject();
  const wrapped=new Proxy(repository,{get(target,property){
    if(property==="closeBrainstorm")return (projectId:string,accountId:string)=>{
      const round=target.round(projectId,accountId);
      (target as any).db.query("UPDATE collaboration_rounds SET proposal_generation_status='running',proposal_generation_attempts=proposal_generation_attempts+1 WHERE id=?").run(round.id);
      return generation.catch((error)=>{(target as any).db.query("UPDATE collaboration_rounds SET proposal_generation_status='failed',proposal_generation_error='The proposal agent could not finish. Try again.' WHERE id=?").run(round.id);throw error;});
    };
    const value=(target as any)[property];return typeof value==="function"?value.bind(target):value;
  }}) as TeamRepository;
  const auth={readSession:()=>({pubkey:"d".repeat(64),npub:"npub-organiser",expiresAt:Date.now()+60_000})} as unknown as AuthService;
  const hub=new RoundRealtimeHub(auth,wrapped);
  const organiserSocket=socket({projectId:project.id,accountId:organiser.id,roundNumber:1,afterSequence:0});
  const playerSocket=socket({projectId:project.id,accountId:player.id,roundNumber:1,afterSequence:0});
  hub.open(organiserSocket as any);hub.open(playerSocket as any);
  const application=createApplication({auth,repository:wrapped,onRoundSnapshot:(projectId,reason)=>hub.publishSnapshot(projectId,reason)});
  const response=await application.fetch(new Request(`http://level.test/api/projects/${project.id}/rounds/1/brainstorm/close`,{method:"POST",headers:{cookie:"levelup_session=organiser"}}));
  expect(response.status).toBe(202);
  for(const client of [organiserSocket,playerSocket])expect(client.sent).toContainEqual(expect.objectContaining({type:"round.sync",round:expect.objectContaining({proposalGeneration:expect.objectContaining({status:"running"})})}));
  rejectGeneration(new Error("fixture failure"));await Bun.sleep(5);
  for(const client of [organiserSocket,playerSocket])expect(client.sent).toContainEqual(expect.objectContaining({type:"round.sync",round:expect.objectContaining({proposalGeneration:expect.objectContaining({status:"failed"})})}));
  repository.close();
});

test("a socket opened for an earlier round cannot post into its successor",()=>{
  const {repository,organiser,player,project}=setupSelectedProject();const hub=new RoundRealtimeHub(new AuthService({accessMode:"open"}),repository);
  const stale=socket({projectId:project.id,accountId:player.id,roundNumber:1,afterSequence:0});hub.open(stale as unknown as Bun.ServerWebSocket<RoundSocketData>);
  repository.submitContribution(project.id,organiser.id,"stale-round-seed","Add a visible gate");repository.closeBrainstorm(project.id,organiser.id);repository.beginProposalVoting(project.id,repository.project(project.id,organiser.id).captain!.accountId);const ids=repository.round(project.id,organiser.id).proposals.map((item)=>item.id);repository.replaceProposalVotes(project.id,organiser.id,[ids[0]!,ids[0]!,ids[0]!]);repository.replaceProposalVotes(project.id,player.id,[ids[0]!,ids[0]!,ids[0]!]);repository.closeProposalVoting(project.id,organiser.id);repository.startBuild(project.id,organiser.id);for(let index=0;index<5;index++)repository.advanceBuild(project.id);repository.submitFeedback(project.id,player.id,"stale-round-feedback",{worked:"Worked",improve:"Improve",nextIdea:"Next"});repository.closeFeedback(project.id,organiser.id);
  hub.message(stale as unknown as Bun.ServerWebSocket<RoundSocketData>,JSON.stringify({type:"contribution.submit",clientEventId:"stale-socket-event",body:"Must not cross rounds"}));
  expect(stale.sent).toContainEqual(expect.objectContaining({type:"contribution.ack",clientEventId:"stale-socket-event",status:"failed"}));expect(repository.round(project.id,player.id).number).toBe(2);expect(repository.round(project.id,player.id).contributions).toEqual([]);repository.close();
});

test("realtime publish isolates a failing personalized socket snapshot",()=>{
  const {repository,organiser,player,project}=setupSelectedProject();
  const repositoryWithFailingPlayerRound=new Proxy(repository,{
    get(target,property){
      if(property==="round")return (projectId:string,accountId:string,roundNumber?:number)=>{
        if(accountId===player.id)throw new RepositoryError("round_snapshot_failed","Round snapshot failed.",500);
        return target.round(projectId,accountId,roundNumber);
      };
      const value=(target as unknown as Record<PropertyKey,unknown>)[property];
      return typeof value==="function" ? value.bind(target) : value;
    }
  }) as TeamRepository;
  const hub=new RoundRealtimeHub(new AuthService({accessMode:"open"}),repositoryWithFailingPlayerRound);
  const organiserSocket=socket({projectId:project.id,accountId:organiser.id,roundNumber:1,afterSequence:0});
  const playerSocket=socket({projectId:project.id,accountId:player.id,roundNumber:1,afterSequence:0});
  hub.open(organiserSocket as unknown as Bun.ServerWebSocket<RoundSocketData>);
  hub.open(playerSocket as unknown as Bun.ServerWebSocket<RoundSocketData>);

  const result=repository.submitContribution(project.id,organiser.id,"publish-isolated-failure","Add an ice tunnel");
  expect(()=>hub.publish(project.id,result.event!,result.round)).not.toThrow();
  expect(organiserSocket.sent).toContainEqual(expect.objectContaining({type:"round.event",event:expect.objectContaining({sequence:1})}));
  expect(playerSocket.sent).toContainEqual(expect.objectContaining({type:"round.error",message:"Round snapshot failed."}));
  repository.close();
});

test("deadline timer logs closure failures without crashing the process", async () => {
  const { repository, organiser, project } = setupSelectedProject();
  const failingRepository = new Proxy(repository, {
    get(target, property) {
      if (property === "closeExpiredBrainstorm") return async () => { throw new Error("deadline agent unavailable"); };
      const value = (target as unknown as Record<PropertyKey, unknown>)[property];
      return typeof value === "function" ? value.bind(target) : value;
    }
  }) as TeamRepository;
  const logs: Array<{ event: string; fields?: Record<string, string | number | boolean | null> }> = [];
  const hub = new RoundRealtimeHub(new AuthService({ accessMode: "open" }), failingRepository, (event, fields) => logs.push({ event, fields }));
  const round = repository.round(project.id, organiser.id);
  (hub as unknown as { scheduleDeadline(projectId: string, round: RoundSnapshot): void }).scheduleDeadline(project.id, { ...round, deadlineAt: Date.now() });

  const deadline = Date.now() + 500;
  while (!logs.some((entry) => entry.event === "round.deadline_failed") && Date.now() < deadline) await Bun.sleep(10);
  expect(logs).toContainEqual(expect.objectContaining({ event: "round.deadline_failed", fields: expect.objectContaining({ projectId: project.id, roundNumber: 1, phase: "brainstorm", error: "deadline agent unavailable" }) }));
  repository.close();
});

test("durable deadline recovery closes an expired brainstorm without a connected client",async()=>{
  let now=Date.now();const repository=new SqliteTeamRepository(":memory:",{now:()=>now,brainstormDurationSeconds:1});
  const organiser=repository.accountForNostr("a".repeat(64),"npub-auto");const team=repository.createTeam(organiser.id,"Auto Crew");const created=repository.createProject(team.team.id,organiser.id,"Auto Game");repository.startTemplateSelection(created.id,organiser.id);
  repository.replaceTemplateSelections(created.id,organiser.id,["citadel-strike","skyline-sprint"]);let project=repository.closeTemplateSelection(created.id,organiser.id);if(project.phase==="resolving_template_tie")project=repository.resolveTemplateTie(created.id,organiser.id,"citadel-strike");repository.submitContribution(project.id,organiser.id,"automatic-deadline-idea","Add an automatic gate");
  now+=1_001;const hub=new RoundRealtimeHub(new AuthService({accessMode:"open"}),repository);hub.startDeadlineRecovery(10);
  const phase=()=>((repository as any).db.query("SELECT phase FROM collaboration_rounds WHERE project_id=?").get(project.id) as {phase:string}).phase;
  const limit=Date.now()+500;while(phase()!=="proposals"&&Date.now()<limit)await Bun.sleep(10);
  expect(repository.round(project.id,organiser.id).phase).toBe("proposals");hub.stopDeadlineRecovery();repository.close();
});

test("proxy-compatible cookie handshake acknowledges ordered delivery, replay, and HTTP snapshot convergence", async () => {
  const { repository, organiser, player, project } = setupSelectedProject();
  const auth = { readSession(cookie: string | null) {
    if (cookie === "levelup_session=organiser") return { pubkey: "d".repeat(64), npub: "npub-organiser" };
    if (cookie === "levelup_session=player") return { pubkey: "e".repeat(64), npub: "npub-player" };
    return null;
  } } as unknown as AuthService;
  const application=createApplication({auth,repository});
  const hub = new RoundRealtimeHub(auth, repository);
  const server = Bun.serve<RoundSocketData>({
    port: 0,
    fetch(request, bunServer) { const response = hub.upgrade(request, bunServer); return response === null ? application.fetch(request) : response; },
    websocket: { open: (ws) => hub.open(ws), message: (ws, message) => hub.message(ws, message), close: (ws) => hub.close(ws) },
  });
  const organiserMessages: Array<Record<string, any>> = [];const playerMessages:Array<Record<string,any>>=[];
  const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
  const organiserClient = new BunWebSocket(new URL(`/api/projects/${project.id}/round-stream?after=0`, server.url).toString(), { headers: { Cookie: "levelup_session=organiser" } });
  let playerClient = new BunWebSocket(new URL(`/api/projects/${project.id}/round-stream?after=0`, server.url).toString(), { headers: { Cookie: "levelup_session=player" } });
  organiserClient.onmessage=(event)=>organiserMessages.push(JSON.parse(String(event.data)));playerClient.onmessage = (event) => playerMessages.push(JSON.parse(String(event.data)));
  const waitFor=async(predicate:()=>boolean)=>{const deadline=Date.now()+2000;while(!predicate()&&Date.now()<deadline)await Bun.sleep(10);expect(predicate()).toBe(true);};
  try {
    await Promise.all([new Promise<void>((resolve, reject) => { organiserClient.onopen = () => resolve(); organiserClient.onerror = () => reject(new Error("organiser socket failed")); }), new Promise<void>((resolve, reject) => { playerClient.onopen = () => resolve(); playerClient.onerror = () => reject(new Error("player socket failed")); })]);
    organiserClient.send(JSON.stringify({ type: "contribution.submit", clientEventId: "end-to-end-event-1", body: "Add a portal" }));
    await waitFor(()=>organiserMessages.some((message)=>message.type==="contribution.ack"&&message.sequence===1)&&playerMessages.some((message)=>message.event?.sequence===1));
    playerClient.send(JSON.stringify({ type: "contribution.submit", clientEventId: "end-to-end-event-2", body: "Add moon boots" }));
    await waitFor(()=>playerMessages.some((message)=>message.type==="contribution.ack"&&message.sequence===2)&&organiserMessages.some((message)=>message.event?.sequence===2));
    expect(repository.round(project.id,organiser.id).contributions.map((item)=>item.sequence)).toEqual([1,2]);
    playerClient.close();await Bun.sleep(10);const replayMessages:Array<Record<string,any>>=[];
    playerClient=new BunWebSocket(new URL(`/api/projects/${project.id}/round-stream?after=1`,server.url).toString(),{headers:{Cookie:"levelup_session=player"}});playerClient.onmessage=(event)=>replayMessages.push(JSON.parse(String(event.data)));
    await new Promise<void>((resolve,reject)=>{playerClient.onopen=()=>resolve();playerClient.onerror=()=>reject(new Error("reconnect failed"));});
    await waitFor(()=>replayMessages.some((message)=>message.type==="round.sync"));
    expect(replayMessages.find((message)=>message.type==="round.sync")).toEqual(expect.objectContaining({events:[expect.objectContaining({sequence:2})],round:expect.objectContaining({contributions:[expect.objectContaining({sequence:1}),expect.objectContaining({sequence:2})]})}));
    const snapshotResponse=await fetch(new URL(`/api/projects/${project.id}`,server.url),{headers:{Cookie:"levelup_session=player","x-forwarded-proto":"https","x-forwarded-host":"levelup.test"}});const snapshot=await snapshotResponse.json() as any;
    expect(snapshotResponse.status).toBe(200);expect(snapshot.project.round.contributions.map((item:any)=>item.sequence)).toEqual([1,2]);
    const unauthorized = await fetch(new URL(`/api/projects/${project.id}/round-stream`, server.url));
    expect(unauthorized.status).toBe(401);
  } finally {
    organiserClient.close(); playerClient.close();
    await Bun.sleep(5);
    server.stop(true);
    repository.close();
  }
});

test("build progression does not depend on a connected WebSocket client", async () => {
  const { repository, organiser, player, project } = setupSelectedProject();
  const hub = new RoundRealtimeHub(new AuthService({ accessMode: "open" }), repository);
  repository.submitContribution(project.id, player.id, "headless-build-idea", "Add comet gates");
  repository.closeBrainstorm(project.id, organiser.id);
  let result = repository.beginProposalVoting(project.id, repository.project(project.id,organiser.id).captain!.accountId);
  const ids = result.round.proposals.map((proposal) => proposal.id);
  repository.replaceProposalVotes(project.id, organiser.id, [ids[0]!, ids[0]!, ids[0]!]);
  repository.replaceProposalVotes(project.id, player.id, [ids[0]!, ids[0]!, ids[0]!]);
  repository.closeProposalVoting(project.id, organiser.id);

  result = repository.startBuild(project.id, organiser.id);
  hub.publish(project.id, result.event!, result.round);

  const deadline = Date.now() + 2_500;
  while (repository.round(project.id, organiser.id).phase !== "playtest" && Date.now() < deadline) {
    await Bun.sleep(25);
  }
  const completed = repository.round(project.id, organiser.id);
  expect(completed.phase).toBe("playtest");
  expect(completed.build?.validated).toBe(true);
  repository.close();
});

test("build recovery never starts a second advancement while one is awaiting the agent", async () => {
  let resolveBuild: (value: null) => void = () => undefined;
  let running = true;
  let advances = 0;
  const pending = new Promise<null>((resolve) => { resolveBuild = resolve; });
  const repository = {
    deadlineProjectIds: () => [],
    builderProjectIds: () => running ? ["project"] : [],
    advanceBuild: () => { advances += 1; return pending; },
  } as unknown as TeamRepository;
  const hub = new RoundRealtimeHub(new AuthService({ accessMode: "open" }), repository);
  hub.startDeadlineRecovery(5);
  const startedBy = Date.now() + 500;
  while (advances === 0 && Date.now() < startedBy) await Bun.sleep(5);
  expect(advances).toBe(1);
  await Bun.sleep(50);
  expect(advances).toBe(1);
  running = false;
  resolveBuild(null);
  await Bun.sleep(20);
  expect(advances).toBe(1);
  hub.stopDeadlineRecovery();
});

test("two real clients converge through proposals, hidden voting, build, feedback, and Round 2",async()=>{
  const {repository,organiser,player,project}=setupSelectedProject();
  const auth={readSession(cookie:string|null){if(cookie==="levelup_session=organiser")return{pubkey:"d".repeat(64),npub:"npub-organiser"};if(cookie==="levelup_session=player")return{pubkey:"e".repeat(64),npub:"npub-player"};return null;}} as unknown as AuthService;
  const hub=new RoundRealtimeHub(auth,repository);const server=Bun.serve<RoundSocketData>({port:0,fetch(request,bunServer){const response=hub.upgrade(request,bunServer);return response===null?new Response("not found",{status:404}):response;},websocket:{open:(ws)=>hub.open(ws),message:(ws,message)=>hub.message(ws,message),close:(ws)=>hub.close(ws)}});
  const organiserMessages:any[]=[];const playerMessages:any[]=[];const BunWebSocket=WebSocket as unknown as new(url:string,options:Bun.WebSocketOptions)=>WebSocket;
  const organiserClient=new BunWebSocket(new URL(`/api/projects/${project.id}/round-stream?after=0`,server.url).toString(),{headers:{Cookie:"levelup_session=organiser"}});const playerClient=new BunWebSocket(new URL(`/api/projects/${project.id}/round-stream?after=0`,server.url).toString(),{headers:{Cookie:"levelup_session=player"}});
  organiserClient.onmessage=(event)=>organiserMessages.push(JSON.parse(String(event.data)));playerClient.onmessage=(event)=>playerMessages.push(JSON.parse(String(event.data)));
  const waitFor=async(predicate:()=>boolean,timeout=2500)=>{const end=Date.now()+timeout;while(!predicate()&&Date.now()<end)await Bun.sleep(20);expect(predicate()).toBe(true);};
  try{
    await Promise.all([new Promise<void>((resolve,reject)=>{organiserClient.onopen=()=>resolve();organiserClient.onerror=()=>reject(new Error("organiser socket failed"));}),new Promise<void>((resolve,reject)=>{playerClient.onopen=()=>resolve();playerClient.onerror=()=>reject(new Error("player socket failed"));})]);
    playerClient.send(JSON.stringify({type:"contribution.submit",clientEventId:"full-loop-idea-1",body:"Add comet gates"}));await waitFor(()=>organiserMessages.some((x)=>x.round?.contributions?.length===1));
    organiserClient.send(JSON.stringify({type:"brainstorm.close"}));await waitFor(()=>playerMessages.some((x)=>x.round?.phase==="proposals"&&x.round.proposals.length===1));
    let result=repository.beginProposalVoting(project.id,repository.project(project.id,organiser.id).captain!.accountId);hub.publish(project.id,result.event!,result.round);await waitFor(()=>organiserMessages.some((x)=>x.round?.phase==="voting")&&playerMessages.some((x)=>x.round?.phase==="voting"));
    const ids=result.round.proposals.map((x)=>x.id);repository.replaceProposalVotes(project.id,organiser.id,[ids[0]!,ids[0]!,ids[0]!]);const playerVote=repository.replaceProposalVotes(project.id,player.id,[ids[0]!,ids[0]!,ids[0]!]);expect(playerVote.round.rankings).toBeNull();
    result=repository.closeProposalVoting(project.id,organiser.id);hub.publish(project.id,result.event!,result.round);await waitFor(()=>organiserMessages.some((x)=>x.round?.phase==="building")&&playerMessages.some((x)=>x.round?.brief?.selected?.[0]?.id===ids[0]));
    const organiserBrief=organiserMessages.slice().reverse().find((x:any)=>x.round?.phase==="building");const playerBrief=playerMessages.slice().reverse().find((x:any)=>x.round?.phase==="building");expect(organiserBrief.round.selections).toEqual([ids[0]!,ids[0]!,ids[0]!]);expect(playerBrief.round.selections).toEqual([ids[0]!,ids[0]!,ids[0]!]);
    result=repository.startBuild(project.id,organiser.id);hub.publish(project.id,result.event!,result.round);await waitFor(()=>organiserMessages.some((x)=>x.round?.phase==="playtest"),3000);await waitFor(()=>playerMessages.some((x)=>x.round?.build?.validated===true));
    result=repository.submitFeedback(project.id,player.id,"full-loop-feedback",{worked:"Fast gates",improve:"Clearer warning",nextIdea:"Gate combos"});hub.publish(project.id,result.event!,result.round);await waitFor(()=>organiserMessages.some((x)=>x.round?.feedback?.length===1));
    result=repository.closeFeedback(project.id,organiser.id);hub.publish(project.id,result.event!,result.round);await waitFor(()=>organiserMessages.some((x)=>x.round?.number===2&&x.round?.phase==="brainstorm")&&playerMessages.some((x)=>x.round?.number===2&&x.round?.priorFeedback?.nextIdeas?.[0]==="Gate combos"));
  }finally{organiserClient.close();playerClient.close();await Bun.sleep(5);server.stop(true);repository.close();}
});
