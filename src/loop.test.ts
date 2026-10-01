import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { SqliteTeamRepository } from "./storage";
import { DeterministicProposalGenerator, type BrainstormSuggestionGenerator, type BrainstormSuggestionInput, type BuildAdapter, type ProposalGenerator, type ProposalGeneratorInput } from "./loop";
import { saveAdminSettings } from "./admin-settings";

const cleanup:string[]=[];
afterEach(()=>{for(const path of cleanup.splice(0)){rmSync(path,{force:true});rmSync(`${path}-wal`,{force:true});rmSync(`${path}-shm`,{force:true});}});

function setup(repository:SqliteTeamRepository){
  const organiser=repository.accountForNostr("1".repeat(64),"npub-organiser");
  const player=repository.accountForNostr("2".repeat(64),"npub-player");
  const outsider=repository.accountForNostr("3".repeat(64),"npub-outsider");
  const created=repository.createTeam(organiser.id,"Loop Crew");repository.redeemInvite(player.id,created.invite.secret);
  const project=repository.createProject(created.team.id,organiser.id,"Loop Game");
  repository.startTemplateSelection(project.id,organiser.id);
  repository.replaceTemplateSelections(project.id,organiser.id,["citadel-strike","skyline-sprint"]);
  repository.replaceTemplateSelections(project.id,player.id,["citadel-strike","village-games"]);
  return {organiser,player,outsider,project:repository.closeTemplateSelection(project.id,organiser.id)};
}

function ensureFourIdeas(repository:SqliteTeamRepository,projectId:string,accountId:string){
  const count=repository.round(projectId,accountId).contributions.filter((item)=>item.authorKind!=="bot").length;
  for(let index=count;index<4;index++)repository.submitContribution(projectId,accountId,`fixture-idea-${index}-${crypto.randomUUID()}`,`Add distinct fixture feature ${index+1}`);
}

function closeWithIdeas(repository:SqliteTeamRepository,projectId:string,organiserId:string){ensureFourIdeas(repository,projectId,organiserId);return repository.closeBrainstorm(projectId,organiserId);}

function beginVoting(repository:SqliteTeamRepository,projectId:string,viewerId:string){
  const captain=repository.project(projectId,viewerId).captain;
  if(!captain)throw new Error("expected a Round Captain fixture");
  return repository.beginProposalVoting(projectId,captain.accountId);
}

function reachPlaytest(repository:SqliteTeamRepository,projectId:string,organiserId:string,playerId:string){
  closeWithIdeas(repository,projectId,organiserId);beginVoting(repository,projectId,organiserId);
  const ids=repository.round(projectId,organiserId).proposals.map((proposal)=>proposal.id);
  repository.replaceProposalVotes(projectId,organiserId,[ids[0]!,ids[1]!,ids[2]!]);repository.replaceProposalVotes(projectId,playerId,[ids[1]!,ids[2]!,ids[0]!]);repository.closeProposalVoting(projectId,organiserId);repository.startBuild(projectId,organiserId);
  for(let index=0;index<9;index++)repository.advanceBuild(projectId);
}

describe("complete collaborative loop",()=>{
  test("keeps votes hidden, freezes deterministic rankings, builds, gathers feedback, and creates Round 2 idempotently",()=>{
    let now=100_000;const repository=new SqliteTeamRepository(":memory:",{now:()=>now,brainstormDurationSeconds:300,votingDurationSeconds:180});
    const {organiser,player,outsider,project}=setup(repository);
    repository.submitContribution(project.id,organiser.id,"idea-organiser-1","Add moon boots");
    repository.submitContribution(project.id,player.id,"idea-player-001","Add crystal portals");
    const proposals=closeWithIdeas(repository,project.id,organiser.id).round;
    expect(proposals.phase).toBe("proposals");expect(proposals.proposals).toHaveLength(4);
    expect(proposals.proposals[0]).toEqual(expect.objectContaining({ideaReferences:[1],acceptanceCriteria:expect.any(Array)}));
    expect(()=>repository.beginProposalVoting(project.id,organiser.id)).toThrow("round's captain");
    const voting=beginVoting(repository,project.id,organiser.id).round;const ids=voting.proposals.map((x)=>x.id);
    repository.replaceProposalVotes(project.id,organiser.id,[ids[0]!,ids[0]!,ids[0]!]);
    const privatePlayer=repository.replaceProposalVotes(project.id,player.id,[ids[1]!,ids[1]!,ids[0]!]).round;
    expect(privatePlayer.rankings).toBeNull();expect(privatePlayer.selections).toEqual([ids[1]!,ids[1]!,ids[0]!]);
    const privateOrganiser=repository.round(project.id,organiser.id);expect(privateOrganiser.selections).toEqual([ids[0]!,ids[0]!,ids[0]!]);expect(privateOrganiser.rankings).toBeNull();
    expect(()=>repository.closeProposalVoting(project.id,player.id)).toThrow("Only the team organiser");
    const brief=repository.closeProposalVoting(project.id,organiser.id).round;
    expect(brief.phase).toBe("building");expect(brief.rankings?.map((x)=>x.votes)).toEqual([4,2,0,0]);
    expect(brief.build).toEqual(expect.objectContaining({status:"running",featureBuilds:expect.any(Array)}));
    expect(brief.brief?.selected.map((x)=>x.id)).toEqual(ids);
    expect(brief.brief?.selected.map((x)=>x.votes)).toEqual([4,2,0,0]);
    expect(brief.brief?.tieBreakRule).toContain("Vote tokens");
    expect(repository.closeProposalVoting(project.id,organiser.id).round.brief).toEqual(brief.brief);
    expect(()=>repository.startBuild(project.id,outsider.id)).toThrow("not a member");
    expect(repository.startBuild(project.id,organiser.id).round.build).toEqual(expect.objectContaining({simulated:true,currentStage:"preparing",validated:false}));
    expect(repository.startBuild(project.id,organiser.id).duplicate).toBe(true);
    for(let index=0;index<9;index++){now+=10;repository.advanceBuild(project.id);}
    const playtest=repository.round(project.id,player.id);expect(playtest.phase).toBe("playtest");expect(playtest.build).toEqual(expect.objectContaining({status:"succeeded",currentStage:"complete",validated:true,releaseUrl:"/templates/citadel-strike/index.html"}));
    expect(repository.startBuild(project.id,organiser.id).duplicate).toBe(true);
    const feedback=repository.submitFeedback(project.id,player.id,"feedback-player-1",{worked:"Portals felt fun",improve:"Show a portal warning",nextIdea:"Add portal combos"});
    expect(feedback.round.feedback).toHaveLength(1);expect(repository.submitFeedback(project.id,player.id,"feedback-player-1",{worked:"ignored",improve:"",nextIdea:""}).duplicate).toBe(true);
    const round2=repository.closeFeedback(project.id,organiser.id).round;expect(round2).toEqual(expect.objectContaining({number:2,phase:"brainstorm"}));expect(round2.priorFeedback).toEqual(expect.objectContaining({roundNumber:1,improve:["Show a portal warning"],nextIdeas:["Add portal combos"]}));
    const retried=repository.closeFeedback(project.id,organiser.id,1);expect(retried.duplicate).toBe(true);expect(retried.round.id).toBe(round2.id);
    repository.close();
  });

  test("starts Build directly when the Prioritise deadline closes",()=>{
    let now=150_000;const repository=new SqliteTeamRepository(":memory:",{now:()=>now,votingDurationSeconds:10});const{organiser,player,project}=setup(repository);
    closeWithIdeas(repository,project.id,organiser.id);const voting=beginVoting(repository,project.id,organiser.id).round;const ids=voting.proposals.map((proposal)=>proposal.id);
    repository.replaceProposalVotes(project.id,organiser.id,[ids[0]!,ids[0]!,ids[0]!]);repository.replaceProposalVotes(project.id,player.id,[ids[1]!,ids[1]!,ids[1]!]);
    now=voting.votingDeadlineAt!;const closed=repository.closeExpiredBrainstorm(project.id) as ReturnType<SqliteTeamRepository["closeProposalVoting"]>;
    expect(closed.round.phase).toBe("building");expect(closed.round.brief?.selected).toHaveLength(ids.length);expect(closed.round.build).toEqual(expect.objectContaining({status:"running",featureBuilds:expect.any(Array)}));
    repository.close();
  });

  test("reconstructs proposals, votes, brief, build, feedback, and current round from SQLite",()=>{
    const path=join(tmpdir(),`level-up-loop-${crypto.randomUUID()}.sqlite`);cleanup.push(path);let now=200_000;
    const first=new SqliteTeamRepository(path,{now:()=>now});const {organiser,player,project}=setup(first);
    first.submitContribution(project.id,player.id,"persistent-idea-1","Add a glowing key");closeWithIdeas(first,project.id,organiser.id);beginVoting(first,project.id,organiser.id);
    const ids=first.round(project.id,organiser.id).proposals.map((x)=>x.id);first.replaceProposalVotes(project.id,organiser.id,[ids[0]!,ids[1]!,ids[2]!]);first.replaceProposalVotes(project.id,player.id,[ids[1]!,ids[2]!,ids[0]!]);first.closeProposalVoting(project.id,organiser.id);first.startBuild(project.id,organiser.id);for(let i=0;i<9;i++)first.advanceBuild(project.id);first.submitFeedback(project.id,player.id,"persistent-feedback",{worked:"Key was clear",improve:"More colour",nextIdea:"Add a lock"});first.close();
    now+=100;const second=new SqliteTeamRepository(path,{now:()=>now});const restored=second.accountForNostr("1".repeat(64),"npub-organiser");const round=second.round(project.id,restored.id);
    expect(round).toEqual(expect.objectContaining({number:1,phase:"playtest",brief:expect.any(Object),build:expect.objectContaining({validated:true}),feedback:[expect.objectContaining({nextIdea:"Add a lock"})]}));
    second.close();
  });

  test("migrates the old distinct-proposal vote table before accepting stacked vote tokens",()=>{
    const path=join(tmpdir(),`level-up-vote-migration-${crypto.randomUUID()}.sqlite`);cleanup.push(path);let now=225_000;
    const first=new SqliteTeamRepository(path,{now:()=>now});const {organiser,project}=setup(first);
    closeWithIdeas(first,project.id,organiser.id);beginVoting(first,project.id,organiser.id);
    const ids=first.round(project.id,organiser.id).proposals.map((x)=>x.id);first.replaceProposalVotes(project.id,organiser.id,[ids[0]!,ids[1]!,ids[2]!]);first.close();
    const legacy=new Database(path);
    legacy.exec(`ALTER TABLE collaboration_votes RENAME TO collaboration_votes_new_shape;
      CREATE TABLE collaboration_votes (round_id TEXT NOT NULL REFERENCES collaboration_rounds(id) ON DELETE CASCADE, account_id TEXT NOT NULL REFERENCES accounts(id), proposal_id TEXT NOT NULL REFERENCES collaboration_proposals(id), vote_rank INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL, PRIMARY KEY(round_id,account_id,proposal_id));
      INSERT INTO collaboration_votes SELECT round_id,account_id,proposal_id,vote_rank,updated_at FROM collaboration_votes_new_shape;
      DROP TABLE collaboration_votes_new_shape;`);
    legacy.close();
    now+=100;const second=new SqliteTeamRepository(path,{now:()=>now});const restored=second.accountForNostr("1".repeat(64),"npub-organiser");
    const stacked=second.replaceProposalVotes(project.id,restored.id,[ids[0]!,ids[0]!,ids[0]!]).round;
    expect(stacked.selections).toEqual([ids[0]!,ids[0]!,ids[0]!]);
    second.close();
  });

  test("publishes and enforces the default five-token proposal allowance",()=>{
    const repository=new SqliteTeamRepository(":memory:",{now:()=>240_000});const {organiser,project}=setup(repository);
    closeWithIdeas(repository,project.id,organiser.id);const voting=beginVoting(repository,project.id,organiser.id).round;
    const id=voting.proposals[0]!.id;
    expect(voting.proposalVoteAllowance).toBe(5);
    expect(repository.replaceProposalVotes(project.id,organiser.id,[id,id,id,id,id]).round.selections).toHaveLength(5);
    expect(()=>repository.replaceProposalVotes(project.id,organiser.id,[id,id,id,id,id,id])).toThrow("Use up to 5 proposal vote tokens");
    repository.close();
  });

  test("uses the current configured proposal allowance for atomic replacement",()=>{
    const previous=process.env.LEVELUP_ADMIN_SETTINGS_PATH;const previousPrompts=process.env.LEVELUP_AGENT_PROMPTS_PATH;const previousModel=process.env.LEVELUP_AGENT_MODEL;const root=join(tmpdir(),`level-up-vote-settings-${crypto.randomUUID()}`);
    process.env.LEVELUP_ADMIN_SETTINGS_PATH=join(root,"admin-settings.json");
    process.env.LEVELUP_AGENT_PROMPTS_PATH=join(root,"agent-prompts.json");
    process.env.LEVELUP_AGENT_MODEL="openai/test-model";
    try{
      saveAdminSettings({proposalVoteAllowance:2});
      const repository=new SqliteTeamRepository(":memory:",{now:()=>245_000});const {organiser,project}=setup(repository);
      closeWithIdeas(repository,project.id,organiser.id);const voting=beginVoting(repository,project.id,organiser.id).round;const id=voting.proposals[0]!.id;
      expect(voting.proposalVoteAllowance).toBe(2);
      expect(repository.replaceProposalVotes(project.id,organiser.id,[id,id]).round.selections).toEqual([id,id]);
      expect(()=>repository.replaceProposalVotes(project.id,organiser.id,[id,id,id])).toThrow("Use up to 2 proposal vote tokens");
      expect(repository.round(project.id,organiser.id).selections).toEqual([id,id]);
      repository.close();
    }finally{rmSync(root,{recursive:true,force:true});if(previous===undefined)delete process.env.LEVELUP_ADMIN_SETTINGS_PATH;else process.env.LEVELUP_ADMIN_SETTINGS_PATH=previous;if(previousPrompts===undefined)delete process.env.LEVELUP_AGENT_PROMPTS_PATH;else process.env.LEVELUP_AGENT_PROMPTS_PATH=previousPrompts;if(previousModel===undefined)delete process.env.LEVELUP_AGENT_MODEL;else process.env.LEVELUP_AGENT_MODEL=previousModel;}
  });

  test("retains feedback from two numbered rounds in later snapshots and after restart",()=>{
    const path=join(tmpdir(),`level-up-history-${crypto.randomUUID()}.sqlite`);cleanup.push(path);let now=250_000;
    let version=1;const adapter:BuildAdapter={simulated:false,validate:(input)=>{const proposal=input.activeProposal!;version+=1;return{validated:true,includedProposalIds:[proposal.id],deferredProposalIds:[],releaseUrl:`/projects/project_12345678/versions/v${version}/`,failure:null,featureResults:[{proposalId:proposal.id,status:"succeeded",releaseUrl:`/projects/project_12345678/versions/v${version}/`,failure:null}]};}};
    const first=new SqliteTeamRepository(path,{now:()=>now,buildAdapter:adapter});const {organiser,player,project}=setup(first);
    reachPlaytest(first,project.id,organiser.id,player.id);
    first.submitFeedback(project.id,player.id,"round-one-feedback",{worked:"Round one worked",improve:"Round one improve",nextIdea:"Round one next"});
    const round2=first.closeFeedback(project.id,organiser.id).round;
    expect(round2.feedbackHistory).toEqual([{roundNumber:1,feedback:[expect.objectContaining({worked:"Round one worked"})]}]);
    reachPlaytest(first,project.id,organiser.id,player.id);
    first.submitFeedback(project.id,organiser.id,"round-two-feedback",{worked:"Round two worked",improve:"Round two improve",nextIdea:"Round two next"});
    const round3=first.closeFeedback(project.id,organiser.id).round;
    expect(round3.number).toBe(3);
    expect(round3.feedbackHistory.map((entry)=>[entry.roundNumber,entry.feedback.map((item)=>item.worked)])).toEqual([[1,["Round one worked"]],[2,["Round two worked"]]]);
    expect(round3.versionHistory?.map((entry)=>[entry.roundNumber,entry.releaseUrl])).toEqual([[1,"/projects/project_12345678/versions/v2/"],[1,"/projects/project_12345678/versions/v3/"],[1,"/projects/project_12345678/versions/v4/"],[1,"/projects/project_12345678/versions/v5/"],[2,"/projects/project_12345678/versions/v6/"],[2,"/projects/project_12345678/versions/v7/"],[2,"/projects/project_12345678/versions/v8/"],[2,"/projects/project_12345678/versions/v9/"]]);
    expect(round3.versionHistory?.[0]).toEqual(expect.objectContaining({title:expect.any(String),playerChange:expect.any(String),status:"succeeded"}));
    first.close();const legacy=new Database(path);legacy.query("UPDATE collaboration_rounds SET prior_feedback_json=? WHERE project_id=? AND number=3").run(JSON.stringify({roundNumber:2,nextIdeas:["Previous-shape next"]}),project.id);legacy.close();
    now+=100;const second=new SqliteTeamRepository(path,{now:()=>now});const restored=second.accountForNostr("1".repeat(64),"npub-organiser");
    expect(second.project(project.id,restored.id).round?.feedbackHistory.map((entry)=>entry.roundNumber)).toEqual([1,2]);
    expect(second.project(project.id,restored.id).round?.versionHistory?.map((entry)=>entry.releaseUrl)).toEqual(Array.from({length:8},(_,index)=>`/projects/project_12345678/versions/v${index+2}/`));
    expect(second.project(project.id,restored.id).round?.priorFeedback).toEqual({roundNumber:2,worked:[],improve:[],nextIdeas:["Previous-shape next"],requirementBacklog:[]});
    expect(second.round(project.id,restored.id,1).feedbackHistory.map((entry)=>entry.roundNumber)).toEqual([1,2]);
    second.close();
  });

  test("does not advance before a feedback submission is acknowledged",()=>{
    const repository=new SqliteTeamRepository(":memory:",{now:()=>260_000});const {organiser,player,project}=setup(repository);
    reachPlaytest(repository,project.id,organiser.id,player.id);
    expect(()=>repository.closeFeedback(project.id,organiser.id)).toThrow("Wait for at least one submitted feedback note");
    expect(repository.round(project.id,organiser.id).number).toBe(1);repository.close();
  });

  test("keeps coding active while the build adapter does the real edit and validation",()=>{
    let calls=0;const adapter:BuildAdapter={simulated:false,validate:(input)=>{calls+=1;return{validated:true,includedProposalIds:[input.brief.committed.id],deferredProposalIds:input.brief.selected.slice(1).map((item)=>item.id),releaseUrl:"/projects/project_12345678/versions/v2/",failure:null};}};
    const repository=new SqliteTeamRepository(":memory:",{now:()=>265_000,buildAdapter:adapter});const {organiser,player,project}=setup(repository);
    closeWithIdeas(repository,project.id,organiser.id);beginVoting(repository,project.id,organiser.id);const ids=repository.round(project.id,organiser.id).proposals.map((x)=>x.id);
    repository.replaceProposalVotes(project.id,organiser.id,[ids[0]!,ids[1]!,ids[2]!]);repository.replaceProposalVotes(project.id,player.id,[ids[1]!,ids[2]!,ids[0]!]);repository.closeProposalVoting(project.id,organiser.id);repository.startBuild(project.id,organiser.id);
    repository.advanceBuild(project.id);expect(calls).toBe(0);expect(repository.round(project.id,organiser.id).build?.currentStage).toBe("analysing");
    repository.advanceBuild(project.id);expect(calls).toBe(0);expect(repository.round(project.id,organiser.id).build?.currentStage).toBe("coding");
    repository.advanceBuild(project.id);expect(calls).toBe(1);const build=repository.round(project.id,organiser.id).build!;
    expect(build.currentStage).toBe("complete");expect(build.featureBuilds?.[0]?.status).toBe("succeeded");expect(build.featureBuilds?.slice(1).map((feature)=>feature.status)).toEqual(["deferred","deferred","deferred"]);
    repository.close();
  });

  test("retains player-safe workspace activity in the feature snapshot",()=>{
    const adapter:BuildAdapter={simulated:false,validate(input){input.featureExecution?.onProgress({phase:"inspecting",changedFiles:[]});input.featureExecution?.onProgress({phase:"editing",changedFiles:["src/game.ts","src/style.css"],activityMessage:"Checking the new movement against the existing touch controls."});return{validated:true,includedProposalIds:[input.activeProposal!.id],deferredProposalIds:[],releaseUrl:"/projects/project_12345678/versions/v2/",failure:null,featureResults:[{proposalId:input.activeProposal!.id,status:"succeeded",releaseUrl:"/projects/project_12345678/versions/v2/",failure:null}]};}};
    const repository=new SqliteTeamRepository(":memory:",{now:()=>265_050,buildAdapter:adapter});const{organiser,player,project}=setup(repository);
    closeWithIdeas(repository,project.id,organiser.id);beginVoting(repository,project.id,organiser.id);const ids=repository.round(project.id,organiser.id).proposals.map((item)=>item.id);
    repository.replaceProposalVotes(project.id,organiser.id,[ids[0]!,ids[1]!,ids[2]!]);repository.replaceProposalVotes(project.id,player.id,[ids[1]!,ids[2]!,ids[0]!]);repository.closeProposalVoting(project.id,organiser.id);repository.startBuild(project.id,organiser.id);
    repository.advanceBuild(project.id);repository.advanceBuild(project.id);repository.advanceBuild(project.id);
    expect(repository.round(project.id,organiser.id).build?.featureBuilds?.[0]?.activity?.map((item)=>item.message)).toEqual(["LvlUP opened the project workspace and is inspecting the game.","Checking the new movement against the existing touch controls."]);
    repository.close();
  });

  test("passes the leased queue feature to the adapter even when the legacy build projection points elsewhere",()=>{
    let received:string|null=null;const adapter:BuildAdapter={simulated:false,validate:input=>{received=input.activeProposal!.id;return{validated:true,includedProposalIds:[input.activeProposal!.id],deferredProposalIds:[],releaseUrl:"/projects/project_12345678/versions/v2/",failure:null,featureResults:[{proposalId:input.activeProposal!.id,status:"succeeded",releaseUrl:"/projects/project_12345678/versions/v2/",failure:null}]};}};
    const repository=new SqliteTeamRepository(":memory:",{now:()=>265_100,buildAdapter:adapter});const{organiser,player,project}=setup(repository);closeWithIdeas(repository,project.id,organiser.id);beginVoting(repository,project.id,organiser.id);const ids=repository.round(project.id,organiser.id).proposals.map(x=>x.id);repository.replaceProposalVotes(project.id,organiser.id,[ids[0]!,ids[1]!,ids[2]!]);repository.replaceProposalVotes(project.id,player.id,[ids[1]!,ids[2]!,ids[0]!]);repository.closeProposalVoting(project.id,organiser.id);const frozen=repository.round(project.id,organiser.id);const leased=frozen.brief!.selected[0]!.id;repository.advanceBuild(project.id);repository.advanceBuild(project.id);const projected=frozen.build!.featureBuilds!.map((feature,index)=>({...feature,status:index===1?"building":"queued",currentAgentLoop:index===1?"build":null}));(repository as any).db.query("UPDATE collaboration_builds SET feature_builds_json=? WHERE round_id=?").run(JSON.stringify(projected),frozen.id);repository.advanceBuild(project.id);expect(String(received)).toBe(leased);repository.close();
  });

  test("configured owner can defer the active feature, abort its owned run, preserve stable, and advance the queue",async()=>{
    let aborted=false;const adapter:BuildAdapter={simulated:false,validate:input=>new Promise(resolve=>{input.featureExecution!.signal.addEventListener("abort",()=>{aborted=true;resolve({validated:false,includedProposalIds:[],deferredProposalIds:[],releaseUrl:null,failure:"interrupted"});},{once:true});})};
    const repository=new SqliteTeamRepository(":memory:",{now:()=>265_200,ownerNpub:"npub-organiser",buildAdapter:adapter});const{organiser,player,project}=setup(repository);(repository as any).db.query("UPDATE projects SET stable_play_url=? WHERE id=?").run("/projects/project_12345678/versions/v1/",project.id);closeWithIdeas(repository,project.id,organiser.id);beginVoting(repository,project.id,organiser.id);const ids=repository.round(project.id,organiser.id).proposals.map(x=>x.id);repository.replaceProposalVotes(project.id,organiser.id,[ids[0]!,ids[1]!,ids[2]!]);repository.replaceProposalVotes(project.id,player.id,[ids[1]!,ids[2]!,ids[0]!]);repository.closeProposalVoting(project.id,organiser.id);repository.advanceBuild(project.id);repository.advanceBuild(project.id);const running=repository.advanceBuild(project.id) as Promise<unknown>;repository.deferInterruptedFeature(project.id,organiser.id);await running;const round=repository.round(project.id,organiser.id);expect(aborted).toBe(true);expect(repository.stablePlayUrl(project.id)).toBe("/projects/project_12345678/versions/v1/");expect(round.phase).toBe("building");expect(round.build?.featureBuilds?.slice(0,2).map(feature=>feature.status)).toEqual(["deferred","reviewing"]);expect((repository as any).loop.featureQueue.list(project.id).filter((feature:any)=>feature.status==="active")).toHaveLength(1);repository.close();
  });

  test("ordinary organisers cannot cancel a build reserved for the configured owner",()=>{
    const repository=new SqliteTeamRepository(":memory:",{now:()=>265_250,ownerNpub:"npub-player"});
    const{organiser,player,project}=setup(repository);closeWithIdeas(repository,project.id,organiser.id);beginVoting(repository,project.id,organiser.id);const ids=repository.round(project.id,organiser.id).proposals.map(x=>x.id);repository.replaceProposalVotes(project.id,organiser.id,[ids[0]!,ids[1]!,ids[2]!]);repository.closeProposalVoting(project.id,organiser.id);
    expect(()=>repository.deferInterruptedFeature(project.id,organiser.id)).toThrow("Only the Level Up owner can cancel the current build.");
    expect(()=>repository.deferInterruptedFeature(project.id,player.id)).not.toThrow();
    repository.close();
  });

  test("tracks feature-card queue outcomes and per-feature playable links",()=>{
    const adapter:BuildAdapter={simulated:false,validate:(input)=>({validated:true,includedProposalIds:[input.brief.committed.id,input.brief.stretch[0]!.id],deferredProposalIds:input.brief.selected.slice(2).map((item)=>item.id),releaseUrl:"/projects/project_12345678/versions/v3/",failure:null,featureResults:[{proposalId:input.brief.committed.id,status:"succeeded",releaseUrl:"/projects/project_12345678/versions/v2/",failure:null},{proposalId:input.brief.stretch[0]!.id,status:"succeeded",releaseUrl:"/projects/project_12345678/versions/v3/",failure:null},...input.brief.selected.slice(2).map((proposal)=>({proposalId:proposal.id,status:"deferred" as const,releaseUrl:null,failure:null}))]})};
    const repository=new SqliteTeamRepository(":memory:",{now:()=>266_000,buildAdapter:adapter});const {organiser,player,project}=setup(repository);
    closeWithIdeas(repository,project.id,organiser.id);beginVoting(repository,project.id,organiser.id);const ids=repository.round(project.id,organiser.id).proposals.map((x)=>x.id);
    repository.replaceProposalVotes(project.id,organiser.id,[ids[0]!,ids[1]!,ids[2]!]);repository.replaceProposalVotes(project.id,player.id,[ids[1]!,ids[2]!,ids[0]!]);repository.closeProposalVoting(project.id,organiser.id);
    let round=repository.startBuild(project.id,organiser.id).round;
    expect(round.build?.featureBuilds?.map((feature)=>feature.status)).toEqual(["queued","queued","queued","queued"]);
    repository.advanceBuild(project.id);round=repository.round(project.id,organiser.id);
    expect(round.build?.featureBuilds?.[0]).toEqual(expect.objectContaining({status:"reviewing",currentAgentLoop:"review"}));
    expect(round.build?.featureBuilds?.[0]?.steps.map((step)=>step.loop)).toEqual(["review"]);
    repository.advanceBuild(project.id);repository.advanceBuild(project.id);repository.advanceBuild(project.id);
    const playtest=repository.round(project.id,organiser.id);
    expect(playtest.phase).toBe("playtest");
    expect(playtest.build?.featureBuilds?.map((feature)=>[feature.status,feature.releaseUrl])).toEqual([["succeeded","/projects/project_12345678/versions/v2/"],["succeeded","/projects/project_12345678/versions/v3/"],["deferred",null],["deferred",null]]);
    expect(repository.stablePlayUrl(project.id)).toBe("/projects/project_12345678/versions/v3/");
    repository.close();
  });

  test("atomically advances a delivered feature while a successor brainstorm stays independent",()=>{
    let version=1;
    const adapter:BuildAdapter={simulated:false,validate:(input)=>{const proposal=input.activeProposal!;version+=1;return{validated:true,includedProposalIds:[proposal.id],deferredProposalIds:[],releaseUrl:`/projects/project_12345678/versions/v${version}/`,failure:null,featureResults:[{proposalId:proposal.id,status:"succeeded",releaseUrl:`/projects/project_12345678/versions/v${version}/`,failure:null}]};}};
    const repository=new SqliteTeamRepository(":memory:",{now:()=>266_250,buildAdapter:adapter});const{organiser,player,project}=setup(repository);
    closeWithIdeas(repository,project.id,organiser.id);beginVoting(repository,project.id,organiser.id);const ids=repository.round(project.id,organiser.id).proposals.map((item)=>item.id);
    repository.replaceProposalVotes(project.id,organiser.id,[ids[0]!,ids[1]!,ids[2]!]);repository.replaceProposalVotes(project.id,player.id,[ids[1]!,ids[2]!,ids[0]!]);repository.closeProposalVoting(project.id,organiser.id);const building=repository.startBuild(project.id,organiser.id).round;
    const frozenIds=building.brief!.selected.map((proposal)=>proposal.id);const successor=repository.startSuccessorBrainstorm(project.id,organiser.id).round;
    expect(successor).toEqual(expect.objectContaining({number:2,phase:"brainstorm"}));expect(successor.activeBuild).toEqual(expect.objectContaining({roundNumber:1,build:expect.objectContaining({status:"running"})}));
    repository.submitContribution(project.id,player.id,"parallel-brainstorm-idea","Add a moonlit bonus room",2);
    repository.advanceBuild(project.id);repository.advanceBuild(project.id);repository.advanceBuild(project.id);
    const concurrent=repository.round(project.id,organiser.id);expect(concurrent.number).toBe(2);expect(concurrent.contributions[0]?.body).toBe("Add a moonlit bonus room");expect(concurrent.activeBuild?.brief.selected.map((proposal)=>proposal.id)).toEqual(frozenIds);expect(concurrent.activeBuild?.build.featureBuilds?.map((feature)=>feature.status)).toEqual(["succeeded","reviewing","queued","queued"]);
    repository.close();
  });

  test("reuses an active feature run and preserves the earlier release when the next feature fails",async()=>{
    let calls=0;let rejectSecond!:(error:unknown)=>void;
    const adapter:BuildAdapter={simulated:false,validate(input){
      calls+=1;
      if(calls===1)return{validated:true,includedProposalIds:[input.activeProposal!.id],deferredProposalIds:[],releaseUrl:"/projects/project_12345678/versions/v2/",failure:null,featureResults:[{proposalId:input.activeProposal!.id,status:"succeeded",releaseUrl:"/projects/project_12345678/versions/v2/",failure:null}]};
      return new Promise((_resolve,reject)=>{rejectSecond=reject;});
    }};
    const repository=new SqliteTeamRepository(":memory:",{now:()=>266_400,ownerNpub:"npub-organiser",buildAdapter:adapter});const{organiser,player,project}=setup(repository);
    closeWithIdeas(repository,project.id,organiser.id);beginVoting(repository,project.id,organiser.id);const ids=repository.round(project.id,organiser.id).proposals.map((item)=>item.id);
    repository.replaceProposalVotes(project.id,organiser.id,[ids[0]!,ids[1]!,ids[2]!]);repository.replaceProposalVotes(project.id,player.id,[ids[1]!,ids[2]!,ids[0]!]);repository.closeProposalVoting(project.id,organiser.id);repository.startBuild(project.id,organiser.id);
    repository.advanceBuild(project.id);repository.advanceBuild(project.id);repository.advanceBuild(project.id);
    const succeededId=repository.round(project.id,organiser.id).build!.featureBuilds![0]!.proposalId;
    expect(repository.stablePlayUrl(project.id)).toBe("/projects/project_12345678/versions/v2/");
    repository.advanceBuild(project.id);
    const first=repository.advanceBuild(project.id) as Promise<unknown>;
    const duplicate=repository.advanceBuild(project.id) as Promise<unknown>;
    expect(calls).toBe(2);
    rejectSecond(new (await import("./feedback-summary")).SummaryError("invalid_output"));
    await Promise.all([first,duplicate]);
    const failed=repository.round(project.id,organiser.id);
    expect(failed.build?.featureBuilds?.slice(0,3).map((feature)=>feature.status)).toEqual(["succeeded","failed","queued"]);
    expect(failed.build).toEqual(expect.objectContaining({releaseUrl:"/projects/project_12345678/versions/v2/",includedProposalIds:[succeededId],validated:true}));
    expect(repository.stablePlayUrl(project.id)).toBe("/projects/project_12345678/versions/v2/");
    expect(failed.build?.failure).toContain("could not safely read");
    repository.deferInterruptedFeature(project.id,organiser.id);
    const deferred=repository.round(project.id,organiser.id);
    expect(deferred.build?.featureBuilds?.slice(0,3).map((feature)=>feature.status)).toEqual(["succeeded","deferred","queued"]);
    expect(deferred.build?.featureBuilds?.[0]?.releaseUrl).toBe("/projects/project_12345678/versions/v2/");
    repository.close();
  });

  test("records a no-change version and advances through zero-vote cards across restart",()=>{
    const path=join(tmpdir(),`level-up-no-change-${crypto.randomUUID()}.sqlite`);cleanup.push(path);let version=1;
    const adapter:BuildAdapter={simulated:false,validate:(input)=>{const proposal=input.activeProposal!;version+=1;const releaseUrl=`/projects/project_12345678/versions/v${version}/`;return{validated:true,includedProposalIds:[proposal.id],deferredProposalIds:[],releaseUrl,failure:null,featureResults:[{proposalId:proposal.id,status:proposal.rank===1?"no_change":"succeeded",releaseUrl,failure:null}]};}};
    const first=new SqliteTeamRepository(path,{now:()=>267_000,buildAdapter:adapter});const{organiser,project}=setup(first);
    closeWithIdeas(first,project.id,organiser.id);beginVoting(first,project.id,organiser.id);const ids=first.round(project.id,organiser.id).proposals.map((item)=>item.id);
    first.replaceProposalVotes(project.id,organiser.id,[ids[0]!,ids[0]!,ids[0]!]);const frozen=first.closeProposalVoting(project.id,organiser.id).round;
    expect(frozen.brief?.selected.map((proposal)=>[proposal.id,proposal.votes])).toEqual([[ids[0]!,3],[ids[1]!,0],[ids[2]!,0],[ids[3]!,0]]);
    first.startBuild(project.id,organiser.id);first.advanceBuild(project.id);first.advanceBuild(project.id);first.advanceBuild(project.id);
    const advanced=first.round(project.id,organiser.id);expect(advanced.build?.featureBuilds?.map((feature)=>feature.status)).toEqual(["no_change","reviewing","queued","queued"]);expect(advanced.build?.featureBuilds?.[0]?.releaseUrl).toBe("/projects/project_12345678/versions/v2/");first.close();
    const second=new SqliteTeamRepository(path,{now:()=>267_100,buildAdapter:adapter});const restored=second.accountForNostr("1".repeat(64),"npub-organiser");const recovered=second.round(project.id,restored.id);
    expect(recovered.build?.featureBuilds?.map((feature)=>feature.status)).toEqual(["no_change","reviewing","queued","queued"]);expect(recovered.build?.activeFeatureProposalId).toBe(ids[1]);second.close();
  });

  test("carries every unimplemented card beside newly generated cards without sending backlog through the model",()=>{
    let proposalInput: ProposalGeneratorInput | undefined;
    const fallback = new DeterministicProposalGenerator();
    const generator: ProposalGenerator = {
      generate(input) {
        proposalInput = input;
        return fallback.generate(input).slice(0, 4);
      },
    };
    const adapter:BuildAdapter={simulated:false,validate:(input)=>({validated:true,includedProposalIds:[input.brief.committed.id,input.brief.stretch[0]!.id],deferredProposalIds:[input.brief.stretch[1]!.id],releaseUrl:"/projects/project_12345678/versions/v3/",failure:null,featureResults:[{proposalId:input.brief.committed.id,status:"succeeded",releaseUrl:"/projects/project_12345678/versions/v2/",failure:null},{proposalId:input.brief.stretch[0]!.id,status:"succeeded",releaseUrl:"/projects/project_12345678/versions/v3/",failure:null},{proposalId:input.brief.stretch[1]!.id,status:"deferred",releaseUrl:null,failure:null}]})};
    const repository=new SqliteTeamRepository(":memory:",{now:()=>266_500,proposalGenerator:generator,buildAdapter:adapter});const {organiser,player,project}=setup(repository);
    repository.submitContribution(project.id,organiser.id,"backlog-round-one","Add a boss key");
    closeWithIdeas(repository,project.id,organiser.id);beginVoting(repository,project.id,organiser.id);const ids=repository.round(project.id,organiser.id).proposals.map((x)=>x.id);
    const deferredTitle=repository.round(project.id,organiser.id).proposals.find((proposal)=>proposal.id===ids[2])!.title;
    repository.replaceProposalVotes(project.id,organiser.id,[ids[0]!,ids[1]!,ids[2]!]);repository.replaceProposalVotes(project.id,player.id,[ids[1]!,ids[0]!,ids[2]!]);repository.closeProposalVoting(project.id,organiser.id);repository.startBuild(project.id,organiser.id);
    for(let i=0;i<5;i++)repository.advanceBuild(project.id);
    repository.submitFeedback(project.id,player.id,"backlog-feedback",{worked:"The release played",improve:"Keep the unbuilt card visible",nextIdea:"Add score drama"});
    const round2=repository.closeFeedback(project.id,organiser.id).round;
    expect(round2.priorFeedback?.requirementBacklog).toEqual([
      expect.objectContaining({proposalId:ids[2],title:deferredTitle,status:"deferred"}),
      expect.objectContaining({proposalId:ids[3],status:"queued"}),
    ]);
    repository.submitContribution(project.id,organiser.id,"backlog-round-two","Add a scoreboard");
    const proposals=repository.closeBrainstorm(project.id,organiser.id).round.proposals;
    expect(proposalInput!.priorFeedback?.requirementBacklog).toEqual([]);
    expect(proposals.slice(-2).map((proposal)=>proposal.backlogReferences)).toEqual([[ids[2]!],[ids[3]!]]);
    expect(proposals.at(-2)?.title).toBe(deferredTitle);
    repository.close();
  });

  test("keeps every old backlog card unchanged and adds newly discovered cards",()=>{
    const backlog=Array.from({length:6},(_,index)=>({proposalId:`prior-${index+1}`,sourceRoundNumber:1,sourceRank:index+1,title:`Backlog ${index+1}`,playerChange:`Keep prior requirement ${index+1}`,implementationScope:`Implement prior requirement ${index+1}`,acceptanceCriteria:[`Requirement ${index+1} is visible`],status:"deferred" as const}));
    const generator:ProposalGenerator={generate(input){
      const sequences=input.contributions.map((item)=>item.sequence);
      const proposals=[
        {cardKey:"new-flight",title:"New bird flight",playerChange:"Add both new bird-flight details.",implementationScope:"Add one bounded flight system.",acceptanceCriteria:["Both flight ideas are visible"],ideaReferences:sequences.slice(0,2),backlogReferences:[]},
        {cardKey:"new-score",title:"New score celebration",playerChange:"Add the score celebration.",implementationScope:"Add one bounded score effect.",acceptanceCriteria:["The score celebration is visible"],ideaReferences:[sequences[2]!],backlogReferences:[]},
      ];
      return{schemaVersion:2,proposals,backlogDecisions:[],contributionDecisions:sequences.map((sequence,index)=>({contributionSequence:sequence,operation:"include" as const,resultingCardKey:index<2?"new-flight":"new-score",reason:"Included."}))};
    }};
    const repository=new SqliteTeamRepository(":memory:",{now:()=>266_750,proposalGenerator:generator});const{organiser,project}=setup(repository);
    (repository as any).db.query("UPDATE collaboration_rounds SET prior_feedback_json=? WHERE project_id=? AND number=1").run(JSON.stringify({roundNumber:1,worked:[],improve:[],nextIdeas:[],requirementBacklog:backlog}),project.id);
    repository.submitContribution(project.id,organiser.id,"overlap-one","Make the boss key glow blue");
    repository.submitContribution(project.id,organiser.id,"overlap-two","Give that boss key a pulsing glow");
    repository.submitContribution(project.id,organiser.id,"new-score","Celebrate a high score with confetti");
    const review=repository.closeBrainstorm(project.id,organiser.id).round;
    expect(review.proposals).toHaveLength(8);
    expect(review.proposals.slice(0,2).map(card=>card.title)).toEqual(["New bird flight","New score celebration"]);
    expect(review.proposals.slice(2).map(card=>card.title)).toEqual(backlog.map(card=>card.title));
    expect(review.proposals.slice(2).map(card=>card.backlogReferences)).toEqual(backlog.map(card=>[card.proposalId]));
    expect(review.proposalReconciliation?.backlogDecisions.every(item=>item.operation==="retain")).toBe(true);
    beginVoting(repository,project.id,organiser.id);const ids=review.proposals.map((card)=>card.id);
    repository.replaceProposalVotes(project.id,organiser.id,[ids[0]!,ids[0]!,ids[1]!]);
    const frozen=repository.closeProposalVoting(project.id,organiser.id).round.brief!;
    expect(frozen.selected).toHaveLength(8);
    expect(frozen.selected.slice(2).every((card)=>card.votes===0)).toBe(true);
    expect(new Set(frozen.selected.map((card)=>card.id))).toEqual(new Set(ids));
    repository.close();
  });

  test("game-not-running report interrupts active build and preserves prior stable release",()=>{
    const adapter:BuildAdapter={simulated:false,validate:(input)=>({validated:true,includedProposalIds:[input.brief.committed.id],deferredProposalIds:input.brief.stretch.map((item)=>item.id),releaseUrl:"/projects/project_12345678/versions/v2/",failure:null})};
    const repository=new SqliteTeamRepository(":memory:",{now:()=>267_000,buildAdapter:adapter});const {organiser,player,project}=setup(repository);
    (repository as any).db.query("UPDATE projects SET stable_play_url = ? WHERE id = ?").run("/projects/project_12345678/versions/v1/",project.id);
    closeWithIdeas(repository,project.id,organiser.id);beginVoting(repository,project.id,organiser.id);const ids=repository.round(project.id,organiser.id).proposals.map((x)=>x.id);
    repository.replaceProposalVotes(project.id,organiser.id,[ids[0]!,ids[1]!,ids[2]!]);repository.replaceProposalVotes(project.id,player.id,[ids[1]!,ids[2]!,ids[0]!]);repository.closeProposalVoting(project.id,organiser.id);repository.startBuild(project.id,organiser.id);
    repository.advanceBuild(project.id);repository.advanceBuild(project.id);
    const interrupted=repository.reportBuildProblem(project.id,player.id,"Canvas stayed blank").round;
    expect(interrupted.phase).toBe("failed");
    expect(interrupted.build).toEqual(expect.objectContaining({status:"interrupted",validated:false,reportCount:1,latestReport:expect.objectContaining({note:"Canvas stayed blank"})}));
    expect(interrupted.build?.featureBuilds?.[0]).toEqual(expect.objectContaining({status:"interrupted",failure:"Game is not running: Canvas stayed blank"}));
    expect(repository.stablePlayUrl(project.id)).toBe("/projects/project_12345678/versions/v1/");
    repository.close();
  });

  test("does not fall back to deterministic proposals when automatic proposal generation fails",()=>{
    let now=270_000;const failingGenerator:ProposalGenerator={generate:()=>{throw new Error("proposal agent unavailable");}};
    const repository=new SqliteTeamRepository(":memory:",{now:()=>now,proposalGenerator:failingGenerator});
    const {organiser,project}=setup(repository);
    now+=301_000;
    const expired=repository.round(project.id,organiser.id);
    expect(expired).toEqual(expect.objectContaining({phase:"brainstorm",number:1}));
    expect(()=>repository.closeBrainstorm(project.id,organiser.id)).toThrow("provider_error");
    repository.close();
  });

  test("one durable proposal lease wins concurrent deadline triggers",async()=>{
    let now=270_000;let calls=0;let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
    const fallback=new DeterministicProposalGenerator();const generator:ProposalGenerator={async generate(input){calls++;await gate;return fallback.generate(input);}};
    const repository=new SqliteTeamRepository(":memory:",{now:()=>now,brainstormDurationSeconds:1,proposalGenerator:generator});const{organiser,project}=setup(repository);repository.submitContribution(project.id,organiser.id,"lease-source-idea","Add a durable gate");now+=1_001;
    const first=repository.closeExpiredBrainstorm(project.id);const second=repository.closeExpiredBrainstorm(project.id);expect(calls).toBe(1);release();await Promise.all([first,second]);
    const round=repository.round(project.id,organiser.id);expect(round.phase).toBe("proposals");expect(round.proposals.length).toBeGreaterThan(0);expect(round.proposalGeneration).toEqual(expect.objectContaining({status:"complete",attempts:1}));repository.close();
  });

  test("restart recovery reclaims an interrupted proposal lease without fabricating cards",async()=>{
    const path=join(tmpdir(),`level-up-proposal-recovery-${crypto.randomUUID()}.sqlite`);cleanup.push(path);let now=280_000;
    const first=new SqliteTeamRepository(path,{now:()=>now,brainstormDurationSeconds:1});const{organiser,project}=setup(first);first.submitContribution(project.id,organiser.id,"restart-proposal-source","Add a restart-safe gate");now+=1_001;
    (first as any).db.query("UPDATE collaboration_rounds SET proposal_generation_status='running',proposal_generation_attempts=1,proposal_generation_lease_at=? WHERE project_id=?").run(now,project.id);first.close();
    let calls=0;const fallback=new DeterministicProposalGenerator();const second=new SqliteTeamRepository(path,{now:()=>now,proposalGenerator:{generate(input){calls++;return fallback.generate(input);}}});const restored=second.accountForNostr("1".repeat(64),"npub-organiser");
    expect(second.deadlineProjectIds()).toContain(project.id);await second.closeExpiredBrainstorm(project.id);const round=second.round(project.id,restored.id);expect(calls).toBe(1);expect(round.phase).toBe("proposals");expect(round.proposalGeneration?.attempts).toBe(2);second.close();
  });

  test("cleans player typos in deterministic proposal work packages",()=>{
    const repository=new SqliteTeamRepository(":memory:",{now:()=>280_000,proposalGenerator:new DeterministicProposalGenerator()});
    const {organiser,project}=setup(repository);
    repository.submitContribution(project.id,organiser.id,"messy-idea-1","Could we have poisen t be avoided>");
    repository.submitContribution(project.id,organiser.id,"messy-idea-2","You should go through to the opsite side");
    const round=repository.closeBrainstorm(project.id,organiser.id).round;
    expect(round.proposals[0]?.playerChange).toContain("poison be avoided");
    expect(round.proposals[0]?.playerChange).not.toContain("poisen");
    expect(round.proposals[1]?.playerChange).toContain("opposite side");
    expect(round.proposals[1]?.acceptanceCriteria).toContain("Player-facing copy is clean and readable");
    repository.close();
  });

  test("a failed simulated validation keeps the playable template and never reaches playtest",()=>{
    const failing:BuildAdapter={simulated:true,validate:(input)=>({validated:false,includedProposalIds:[input.brief.committed.id],deferredProposalIds:input.brief.stretch.map((x)=>x.id),releaseUrl:null,failure:"Simulated checks failed."})};
    const repository=new SqliteTeamRepository(":memory:",{now:()=>300_000,buildAdapter:failing});const {organiser,player,project}=setup(repository);
    closeWithIdeas(repository,project.id,organiser.id);beginVoting(repository,project.id,organiser.id);const ids=repository.round(project.id,organiser.id).proposals.map((x)=>x.id);
    repository.replaceProposalVotes(project.id,organiser.id,[ids[0]!,ids[1]!,ids[2]!]);repository.replaceProposalVotes(project.id,player.id,[ids[1]!,ids[2]!,ids[0]!]);repository.closeProposalVoting(project.id,organiser.id);repository.startBuild(project.id,organiser.id);
    for(let i=0;i<4;i++)repository.advanceBuild(project.id);const failed=repository.round(project.id,player.id);
    expect(failed.phase).toBe("failed");expect(failed.build).toEqual(expect.objectContaining({status:"failed",validated:false,releaseUrl:null,failure:"Simulated checks failed."}));expect(repository.project(project.id,player.id).selectedTemplate?.previewUrl).toBe("/templates/citadel-strike/index.html");repository.close();
  });

  test("a browser validation exception blocks playtest and preserves the previous stable release",async()=>{
    const failing:BuildAdapter={simulated:false,async validate(){const error=new Error("Generated game did not draw anything into its visible canvas.");error.name="PlayableReleaseValidationError";throw error;}};
    const repository=new SqliteTeamRepository(":memory:",{now:()=>305_000,buildAdapter:failing});const {organiser,player,project}=setup(repository);
    (repository as any).db.query("UPDATE projects SET stable_play_url = ? WHERE id = ?").run("/projects/project_12345678/versions/v1/",project.id);
    closeWithIdeas(repository,project.id,organiser.id);beginVoting(repository,project.id,organiser.id);const ids=repository.round(project.id,organiser.id).proposals.map((x)=>x.id);
    repository.replaceProposalVotes(project.id,organiser.id,[ids[0]!,ids[1]!,ids[2]!]);repository.replaceProposalVotes(project.id,player.id,[ids[1]!,ids[2]!,ids[0]!]);repository.closeProposalVoting(project.id,organiser.id);repository.startBuild(project.id,organiser.id);
    for(let i=0;i<4;i++)await repository.advanceBuild(project.id);
    const failed=repository.round(project.id,player.id);
    const stable=(repository as any).db.query("SELECT stable_play_url FROM projects WHERE id = ?").get(project.id) as {stable_play_url:string|null};
    expect(failed.phase).toBe("failed");
    expect(failed.build).toEqual(expect.objectContaining({status:"failed",validated:false,releaseUrl:null,failure:"Generated game did not draw anything into its visible canvas."}));
    expect(stable.stable_play_url).toBe("/projects/project_12345678/versions/v1/");
    repository.close();
  });

  test("posts lvl_up brainstorm suggestions as durable chat at the configured interval",async()=>{
    let now=400_000;const suggestionGenerator:BrainstormSuggestionGenerator={suggest:(input)=>`Try connecting ${input.contributions[0]?.body??"the theme"} to one visible goal.`};
    const repository=new SqliteTeamRepository(":memory:",{now:()=>now,brainstormSuggestionGenerator:suggestionGenerator,brainstormSuggestionIntervalMs:30_000});
    const {organiser,project}=setup(repository);
    repository.submitContribution(project.id,organiser.id,"suggestion-seed-1","Add moon boots");
    const first=await repository.suggestBrainstorm(project.id);
    expect(first).not.toBeNull();
    expect(first).toEqual(expect.objectContaining({event:expect.objectContaining({type:"contribution_committed",sequence:2})}));
    expect(first!.round.contributions.at(-1)).toEqual(expect.objectContaining({authorKind:"bot",authorLabel:"lvl_up",body:"Try connecting Add moon boots to one visible goal."}));
    expect(repository.suggestBrainstorm(project.id)).toBeNull();
    now+=30_000;
    expect(await repository.suggestBrainstorm(project.id)).toBeNull();
    repository.submitContribution(project.id,organiser.id,"suggestion-seed-2","Add crystal gates");
    const second=await repository.suggestBrainstorm(project.id);
    expect(second).not.toBeNull();
    expect(second!.round.contributions.at(-1)).toEqual(expect.objectContaining({body:"Try connecting Add crystal gates to one visible goal."}));
    expect(second!.round.contributions.filter((item)=>item.authorKind==="bot")).toHaveLength(2);
    repository.close();
  });

  test("uses the latest configured brainstorm suggestion interval",async()=>{
    let now=410_000;let intervalMs=30_000;
    const suggestionGenerator:BrainstormSuggestionGenerator={suggest:(input)=>`Try shaping ${input.contributions.at(-1)?.body??"the idea"} into one next move.`};
    const repository=new SqliteTeamRepository(":memory:",{now:()=>now,brainstormSuggestionGenerator:suggestionGenerator,brainstormSuggestionIntervalMs:()=>intervalMs});
    const {organiser,project}=setup(repository);
    repository.submitContribution(project.id,organiser.id,"dynamic-interval-seed-1","Add moon boots");
    expect(await repository.suggestBrainstorm(project.id)).not.toBeNull();
    now+=10_000;repository.submitContribution(project.id,organiser.id,"dynamic-interval-seed-2","Add comet gates");
    expect(await repository.suggestBrainstorm(project.id)).toBeNull();
    intervalMs=10_000;
    const second=await repository.suggestBrainstorm(project.id);
    expect(second?.round.contributions.at(-1)).toEqual(expect.objectContaining({authorKind:"bot",body:"Try shaping Add comet gates into one next move."}));
    repository.close();
  });

  test("seeds an empty brainstorm once, then waits for a fresh human idea",async()=>{
    let now=450_000;const calls:BrainstormSuggestionInput[]=[];const suggestionGenerator:BrainstormSuggestionGenerator={suggest:(input)=>{calls.push(input);return input.mode==="seed"?"Here are two ways we could start: 1. Add a moon-village rescue goal. 2. Make maze walls rotate after treasure pickups.":"What one rule would make this game feel different from the starting template?";}};
    const repository=new SqliteTeamRepository(":memory:",{now:()=>now,brainstormSuggestionGenerator:suggestionGenerator,brainstormSuggestionIntervalMs:30_000});
    const {organiser,project}=setup(repository);
    const seed=await repository.suggestBrainstorm(project.id);
    expect(seed?.round.contributions).toHaveLength(1);
    expect(seed?.round.brainstormSeed).toEqual({status:"complete",error:null,attempts:1});
    expect(calls[0]).toEqual(expect.objectContaining({mode:"seed",contributions:[],templateTitle:"First-Person Shooter — Citadel Strike"}));
    expect(await repository.suggestBrainstorm(project.id)).toBeNull();
    repository.submitContribution(project.id,organiser.id,"suggestion-human-seed","Add a moon village");
    now+=30_000;
    const first=await repository.suggestBrainstorm(project.id);
    expect(first?.round.contributions.at(-1)).toEqual(expect.objectContaining({authorKind:"bot",body:"What one rule would make this game feel different from the starting template?"}));
    expect(calls.at(-1)).toEqual(expect.objectContaining({mode:"nudge",contributions:[expect.objectContaining({body:"Add a moon village"})]}));
    repository.close();
  });

  test("commits one durable empty-room seed under concurrent attempts and replays it",async()=>{
    let release!:()=>void;let calls=0;const suggestionGenerator:BrainstormSuggestionGenerator={suggest:async()=>{calls++;await new Promise<void>((resolve)=>{release=resolve;});return"Here are two ways we could start: 1. Let players rescue a lost explorer. 2. Add doors that swap the maze layout.";}};
    const repository=new SqliteTeamRepository(":memory:",{brainstormSuggestionGenerator:suggestionGenerator});const {organiser,project}=setup(repository);
    const first=repository.suggestBrainstorm(project.id) as Promise<unknown>;expect(repository.suggestBrainstorm(project.id)).toBeNull();release();await first;
    const snapshot=repository.round(project.id,organiser.id);expect(calls).toBe(1);expect(snapshot.contributions.filter((item)=>item.authorKind==="bot")).toHaveLength(1);
    const replay=repository.roundEvents(project.id,organiser.id,0);expect(replay.events).toEqual([expect.objectContaining({type:"contribution_committed",contribution:expect.objectContaining({clientEventId:`lvl-up-seed-${snapshot.id}`})})]);
    repository.close();
  });

  test("persists seed failure, retries without fallback, and recovers an interrupted lease after restart",async()=>{
    const path=join(tmpdir(),`level-up-seed-recovery-${crypto.randomUUID()}.sqlite`);cleanup.push(path);let fail=true;
    const generator:BrainstormSuggestionGenerator={suggest:()=>{if(fail)throw new Error("provider unavailable");return"Here are two ways we could start: 1. Add torch switches that reveal shortcuts. 2. Let the minotaur guard a moving treasure room.";}};
    let repository=new SqliteTeamRepository(path,{brainstormSuggestionGenerator:generator});const {organiser,project}=setup(repository);
    expect(()=>repository.suggestBrainstorm(project.id)).toThrow("provider_error");expect(repository.round(project.id,organiser.id).brainstormSeed).toEqual(expect.objectContaining({status:"failed",attempts:1}));
    (repository as any).db.query("UPDATE collaboration_rounds SET brainstorm_seed_status='running'").run();repository.close();
    repository=new SqliteTeamRepository(path,{brainstormSuggestionGenerator:generator});expect(repository.round(project.id,organiser.id).brainstormSeed).toEqual(expect.objectContaining({status:"failed",error:expect.stringContaining("interrupted")}));
    fail=false;const retried=await repository.suggestBrainstorm(project.id);expect(retried?.round.contributions.filter((item)=>item.authorKind==="bot")).toHaveLength(1);expect(retried?.round.brainstormSeed).toEqual({status:"complete",error:null,attempts:2});repository.close();
  });

  test("does not post deterministic lvl_up fallback nudges when brainstorm agent fails",async()=>{
    let now=500_000;const failingGenerator:BrainstormSuggestionGenerator={suggest:()=>{throw new Error("agent unavailable");}};
    const repository=new SqliteTeamRepository(":memory:",{now:()=>now,brainstormSuggestionGenerator:failingGenerator,brainstormSuggestionIntervalMs:30_000});
    const {organiser,project}=setup(repository);
    repository.submitContribution(project.id,organiser.id,"suggestion-failure-seed","Foods could be different and have different effects");
    repository.submitContribution(project.id,organiser.id,"suggestion-failure-seed-2","Could we have poison to be avoided");
    repository.submitContribution(project.id,organiser.id,"suggestion-failure-seed-3","You shouldn't hit the wall, you should go through to the opposite side");
    expect(()=>repository.suggestBrainstorm(project.id)).toThrow("provider_error");
    expect(repository.round(project.id,organiser.id).contributions.filter((item)=>item.authorKind==="bot")).toHaveLength(0);
    repository.close();
  });

  test("does not commit the same lvl_up suggestion twice",async()=>{
    let now=550_000;const suggestionGenerator:BrainstormSuggestionGenerator={suggest:()=>"Try turning the latest idea into one readable choice."};
    const repository=new SqliteTeamRepository(":memory:",{now:()=>now,brainstormSuggestionGenerator:suggestionGenerator,brainstormSuggestionIntervalMs:30_000});
    const {organiser,project}=setup(repository);
    repository.submitContribution(project.id,organiser.id,"same-answer-seed-1","What is the logs explode?");
    expect(await repository.suggestBrainstorm(project.id)).not.toBeNull();
    now+=30_000;
    repository.submitContribution(project.id,organiser.id,"same-answer-seed-2","What if getting hit only moves back one row?");
    expect(await repository.suggestBrainstorm(project.id)).toBeNull();
    expect(repository.round(project.id,organiser.id).contributions.filter((item)=>item.authorKind==="bot").map((item)=>item.body)).toEqual(["Try turning the latest idea into one readable choice."]);
    repository.close();
  });
});
