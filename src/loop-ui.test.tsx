import { describe,expect,test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { nip19 } from "nostr-tools";
import { PROPOSAL_GENERATION_STATUS_LINES, PROPOSAL_STATUS_ROTATION_MS, ProjectRoomView, featureLoopDurationMs, formatBuildDuration, shouldSubmitIdeaFromKey, updateProposalVotes, type ProjectRoom,type RoundSnapshot } from "./App";
import type { FeatureBuild, FrozenBrief } from "./loop";
import { generatedNickname } from "./player-identity";

const noop=()=>undefined;
const proposal=(id:string,position:number)=>({id,roundId:"round",position,title:`Choice ${position}`,playerChange:`Visible change ${position}`,implementationScope:"Bounded scope",acceptanceCriteria:["It works"],ideaReferences:[position]});
const baseRound:RoundSnapshot={id:"round",projectId:"project",number:1,phase:"voting",startedAt:1,deadlineAt:2,votingDeadlineAt:3,closedAt:2,serverTime:2,lastSequence:2,proposalVoteAllowance:5,contributions:[],proposals:[proposal("one",1),proposal("two",2),proposal("three",3),proposal("four",4)],selections:[],rankings:null,brief:null,build:null,feedback:[],feedbackHistory:[],priorFeedback:null};
const project:ProjectRoom={id:"project",teamId:"team",teamName:"Crew",name:"Shared Game",phase:"round_1_brainstorm",selectedTemplateId:"maze",stablePlayUrl:null,selectedTemplate:{id:"maze",title:"Maze",description:"Escape",themePrompts:[],previewUrl:"/templates/maze/index.html",visual:"maze"},isOrganiser:true,selectionStartedAt:0,selectionDeadlineAt:1,selectionClosedAt:1,serverTime:2,templates:[],selections:[],rankings:[],topThree:[],tiedLeaderIds:[],round:baseRound,createdAt:0};
const render=(round:RoundSnapshot,isOwnerAdmin=false)=>renderToStaticMarkup(<ProjectRoomView project={{...project,round}} draft={[]} remaining={0} roundRemaining={120} isOwnerAdmin={isOwnerAdmin} busy={false} status="" onChoose={noop} onClose={noop} onResolve={noop}/>);

test("build cycle timing retains completed durations and ticks the active loop",()=>{
  const feature:FeatureBuild={proposalId:"one",queuePosition:1,status:"building",currentAgentLoop:"build",steps:[{loop:"review",status:"complete",at:1_000,detail:"Reviewing"},{loop:"build",status:"active",at:6_000,detail:"Building"}],releaseUrl:null,failure:null,reportCount:0,latestReport:null,startedAt:1_000,completedAt:null};
  expect(featureLoopDurationMs(feature,0,16_250)).toBe(5_000);
  expect(featureLoopDurationMs(feature,1,16_250)).toBe(10_250);
  expect(formatBuildDuration(5_000)).toBe("5s");
  expect(formatBuildDuration(125_000)).toBe("2m 05s");
});

test("light work surfaces use their dark semantic foreground pair",async()=>{
  const css=await Bun.file(new URL("./styles.css",import.meta.url)).text();
  expect(css).toMatch(/\.loop-panel, \.feedback-context\s*\{[^}]*background:\s*var\(--surface-light\);[^}]*color:\s*var\(--text-on-light\);/);
  expect(css).toMatch(/\.loop-panel \.eyebrow, \.loop-panel \.section-heading > span, \.feedback-context \.eyebrow\s*\{\s*color:\s*var\(--accent-on-light\);\s*\}/);
  expect(css).toMatch(/\.build-panel li\.active\s*\{[^}]*background:\s*#fff1a8;[^}]*color:\s*var\(--text-on-light\);/);
  expect(css).toMatch(/\.build-panel li\.complete\s*\{[^}]*background:\s*#dff5e8;[^}]*color:\s*var\(--text-on-light\);/);
  expect(css).not.toContain("var(--yellow)");
  expect(css).toMatch(/\.danger-button:hover:not\(:disabled\)/);
  expect(css).toMatch(/\.danger-button:focus-visible/);
  expect(css).toMatch(/\.danger-button:active:not\(:disabled\)/);
});

describe("collaborative loop UI",()=>{
  test("build states start with the useful workspace instead of the oversized project hero",()=>{
    const build={id:"build",status:"running" as const,currentStage:"coding" as const,simulated:false,steps:[],includedProposalIds:[],deferredProposalIds:[],startedAt:5,completedAt:null,validated:false,releaseUrl:null,failure:null};
    const html=render({...baseRound,phase:"building",build});
    expect(html).not.toContain('class="round-hero"');
    expect(html).toContain('class="round-progress"');
    expect(html).toContain('id="active-build"');
  });

  test("brainstorm idea textarea sends on Enter and keeps Shift+Enter for new lines",()=>{const key=(overrides:Partial<Parameters<typeof shouldSubmitIdeaFromKey>[0]>)=>({key:"Enter",shiftKey:false,altKey:false,ctrlKey:false,metaKey:false,isComposing:false,...overrides});expect(shouldSubmitIdeaFromKey(key({}))).toBe(true);expect(shouldSubmitIdeaFromKey(key({shiftKey:true}))).toBe(false);expect(shouldSubmitIdeaFromKey(key({key:"a"}))).toBe(false);expect(shouldSubmitIdeaFromKey(key({isComposing:true}))).toBe(false);});
  test("shows proposal preparation immediately while the organiser request is local",()=>{
    const round={...baseRound,phase:"brainstorm" as const,proposalGeneration:{status:"idle" as const,error:null,attempts:0}};
    const html=renderToStaticMarkup(<ProjectRoomView project={{...project,round}} draft={[]} remaining={0} roundRemaining={120} busy={true} status="lvl_up is turning the brainstorm into checked requirement cards..." proposalGenerationPending onChoose={noop} onClose={noop} onResolve={noop}/>);
    expect(html).toContain("Preparing your proposal cards");
    expect(html).not.toContain("Ideas in the room");
    expect(html).not.toContain("Close early and generate proposals");
  });
  test("shows the authoritative running splash to organisers and players",()=>{
    const running={...baseRound,phase:"brainstorm" as const,proposalGeneration:{status:"running" as const,error:null,attempts:1}};
    for(const isOrganiser of [true,false]){
      const html=renderToStaticMarkup(<ProjectRoomView project={{...project,isOrganiser,round:running}} draft={[]} remaining={0} roundRemaining={120} busy={false} status="" onChoose={noop} onClose={noop} onResolve={noop}/>);
      expect(html).toContain("Preparing your proposal cards");
      expect(html).not.toContain("Ideas in the room");
      expect(html).not.toContain("Retry proposal agent");
    }
    expect(PROPOSAL_GENERATION_STATUS_LINES.length).toBeGreaterThanOrEqual(16);
    expect(PROPOSAL_STATUS_ROTATION_MS).toBe(10_000);
  });
  test("exits proposal preparation on completion and recovers to actionable failure states",()=>{
    const complete=render({...baseRound,phase:"proposals",proposalGeneration:{status:"complete",error:null,attempts:1}});
    expect(complete).toContain("Review requirement cards");
    expect(complete).not.toContain("Preparing your proposal cards");
    const failed={...baseRound,phase:"brainstorm" as const,proposalGeneration:{status:"failed" as const,error:"The proposal agent could not finish. Try again.",attempts:1}};
    const organiser=renderToStaticMarkup(<ProjectRoomView project={{...project,round:failed}} draft={[]} remaining={0} busy={false} status="" onChoose={noop} onClose={noop} onResolve={noop}/>);
    expect(organiser).not.toContain("Preparing your proposal cards");
    expect(organiser).toContain("The proposal agent could not finish. Try again.");
    expect(organiser).toContain("Retry proposal agent");
    const player=renderToStaticMarkup(<ProjectRoomView project={{...project,isOrganiser:false,round:failed}} draft={[]} remaining={0} busy={false} status="" onChoose={noop} onClose={noop} onResolve={noop}/>);
    expect(player).toContain("Waiting for the organiser to retry the proposal agent.");
    expect(player).not.toContain("Retry proposal agent</button>");
  });
  test("shows private vote-token controls without aggregate totals",()=>{const html=render({...baseRound,selections:["one","one","two"]});expect(html).toContain("Spend your 5 votes");expect(html).toContain("3/5 vote tokens saved");expect(html).toContain("2 VOTES");expect(html).toContain('aria-label="Add vote to Choice 1"');expect(html).toContain('aria-label="Remove vote from Choice 1"');expect(html).not.toMatch(/\d+ points/);});
  test("allows the full server-provided proposal vote allowance",()=>{
    const four=["one","one","two","two"];
    expect(updateProposalVotes(four,"one",1,5)).toEqual([...four,"one"]);
    expect(updateProposalVotes([...four,"one"],"two",1,5)).toHaveLength(5);
  });
  test("keeps complete proposal details expanded in review and voting",()=>{
    for(const phase of ["proposals","voting"] as const){
      const html=render({...baseRound,phase,contributions:[{id:"idea-one",roundId:"round",authorAccountId:"member",authorNpub:"npub-member",body:"Add moon boots to jump hazards",clientEventId:"idea-one",sequence:1,createdAt:4}]});
      expect(html).toContain("Player change");
      expect(html).toContain("Visible change 1");
      expect(html).toContain("Implementation scope");
      expect(html).toContain("Bounded scope");
      expect(html).toContain("Acceptance criteria");
      expect(html).toContain("It works");
      expect(html).toContain("Reflected sources");
      expect(html).toContain("#1: Add moon boots to jump hazards");
      expect(html).toContain('aria-label="Games and brainstorm"');
      expect(html).toContain("Play V1");
      expect(html).toContain("Brainstorm available when Build starts");
      expect(html).toContain("Pop out");
      expect(html).toContain("Collapse");
      expect(html).not.toContain("<details");
      expect(html).not.toContain("<summary");
      if(phase==="voting"){expect(html).toContain("Finish prioritising and start Build");expect(html).not.toContain("Close voting and freeze brief");}
    }
  });
  test("shows loop progress and the current agent boundary message",()=>{
    const html=render({...baseRound,phase:"building",build:{id:"build",status:"running",currentStage:"analysing",simulated:false,steps:[{stage:"preparing",status:"complete",at:4,detail:"Ready"},{stage:"analysing",status:"active",at:5,detail:"Checking the frozen brief"},{stage:"coding",status:"pending",at:null,detail:"Waiting"}],includedProposalIds:[],deferredProposalIds:[],startedAt:4,completedAt:null,validated:false,releaseUrl:null,failure:null}});
    expect(html).toContain('aria-label="Round 1 collaboration loop"');
    expect(html).toContain("Brainstorm");
    expect(html).toContain("Build");
    expect(html).toContain("Prioritise");
    expect(html).toContain("Iterate");
    expect(html).toContain("loops to Brainstorm");
    expect(html).not.toContain(">Vote<");
    expect(html).not.toContain(">Brief<");
    expect(html).not.toContain(">Play<");
    expect(html).toContain('<li class=" iterate-loop"><b>5</b><span>Iterate</span>');
    expect(html).toContain("Checking the frozen brief");
    expect(html).toContain('aria-label="Collapse Game Versions"');
  });
  test("removes the redundant brainstorm hint without hiding live controls or waiting status",()=>{
    const html=render({...baseRound,phase:"brainstorm",contributions:[]});
    expect(html).not.toContain('class="agent-stage-note"');
    expect(html).not.toContain("lvl_up starts an empty room with two ideas");
    expect(html).toContain("Send idea");
    expect(html).toContain("Close early and generate proposals");
    expect(html).toContain("CONNECTING");
  });
  test("uses the shared avatar-led bubble for committed ideas without rendering legacy feedback",()=>{
    const pubkey="1".repeat(64);const author=nip19.npubEncode(pubkey);
    const feedback={id:"feedback",authorAccountId:"member",authorNpub:author,worked:"The jump felt crisp",improve:"Make hazards clearer",nextIdea:"Add a shield",clientEventId:"feedback-event",submittedAt:10};
    const html=render({...baseRound,phase:"brainstorm",contributions:[{id:"idea",roundId:"round",authorAccountId:"member",authorNpub:author,body:"Add moon boots",clientEventId:"idea-event",sequence:7,createdAt:4}],feedbackHistory:[{roundNumber:1,feedback:[feedback]}]});
    expect(html).toContain('class="conversation-bubble conversation-bubble-idea delivery-sent"');
    expect(html).not.toContain('conversation-bubble-feedback');
    expect(html).toMatch(/class="mini-avatar avatar-[0-3]"/);
    expect(html).toContain(generatedNickname(pubkey));
    expect(html).not.toContain("The jump felt crisp");
    expect(html).toContain("#7");
    expect(html).toContain("sent");
  });
  test("renders cached and missing player identities without npub text",()=>{
    const firstKey="2".repeat(64),secondKey="3".repeat(64);const first=nip19.npubEncode(firstKey),second=nip19.npubEncode(secondKey);
    const contributions=[first,second].map((authorNpub,index)=>({id:`idea-${index}`,roundId:"round",authorAccountId:`member-${index}`,authorNpub,body:"Friendly idea",clientEventId:`event-${index}`,sequence:index+1,createdAt:4}));
    const html=renderToStaticMarkup(<ProjectRoomView project={{...project,round:{...baseRound,phase:"brainstorm",contributions}}} draft={[]} remaining={0} roundRemaining={120} profileMap={{[firstKey]:{...({pubkey:firstKey,npub:first,displayName:"Pixel Pete",metadata:{}})}}} busy={false} status="" onChoose={noop} onClose={noop} onResolve={noop}/>);
    expect(html).toContain("Pixel Pete");expect(html).toContain(generatedNickname(secondKey));expect(html).not.toContain(first);expect(html).not.toContain(second);
  });
  test("renders brainstorm screenshot thumbnails in the shared bubble and composer",()=>{
    const attachment={id:"shot-0001",kind:"image" as const,filename:"maze.png",contentType:"image/png" as const,dataUrl:"data:image/png;base64,aGk=",sizeBytes:2};
    const html=renderToStaticMarkup(<ProjectRoomView project={{...project,round:{...baseRound,phase:"brainstorm",contributions:[{id:"idea",roundId:"round",authorAccountId:"member",authorNpub:"npub-member",body:"",clientEventId:"idea-event",sequence:4,createdAt:4,attachments:[attachment]}]}}} draft={[]} remaining={0} roundRemaining={120} ideaAttachments={[attachment]} busy={false} status="" onChoose={noop} onClose={noop} onResolve={noop}/>);
    expect(html).toContain("conversation-attachments");
    expect(html).toContain('src="data:image/png;base64,aGk="');
    expect(html).toContain("idea-attachment-preview");
    expect(html).toContain("paperclip-button");
    expect(html).toContain("maze.png");
  });
  test("renders lvl_up brainstorm suggestions as bot chat, not human delivery",()=>{
    const html=render({...baseRound,phase:"brainstorm",contributions:[{id:"bot-idea",roundId:"round",authorAccountId:"level-up-bot-account",authorNpub:"bot:lvl_up",authorKind:"bot",authorLabel:"lvl_up",body:"Try combining the moon boots with one clear finish line.",clientEventId:"lvl-up-suggestion",sequence:3,createdAt:4}]});
    expect(html).toContain("<strong>lvl_up</strong>");
    expect(html).toContain("<small>BOT</small>");
    expect(html).toContain("Try combining the moon boots");
    expect(html).toContain("bot-avatar");
  });
  test("shows honest empty-room seed progress and retry status",()=>{
    const running=render({...baseRound,phase:"brainstorm",lastSequence:0,contributions:[],brainstormSeed:{status:"running",error:null,attempts:1}});
    expect(running).toContain("lvl_up is preparing two starter ideas");
    const failed=render({...baseRound,phase:"brainstorm",lastSequence:0,contributions:[],brainstormSeed:{status:"failed",error:"The brainstorm agent is not configured.",attempts:1}});
    expect(failed).toContain("The brainstorm agent is not configured.");expect(failed).toContain("will retry while this room stays open");expect(failed).toContain("Send idea");
  });
  test("treats a previous-shape brief snapshot as a transient Build state",()=>{const rankings=baseRound.proposals.slice(0,3).map((item,index)=>({...item,rank:index+1,votes:3-index,firstPlaceVotes:index===0?1:0,secondPlaceVotes:index===1?1:0,thirdPlaceVotes:index===2?1:0}));const selected=[rankings[0]!,rankings[1]!,rankings[2]!] as [typeof rankings[number],typeof rankings[number],typeof rankings[number]];const html=render({...baseRound,phase:"brief",rankings,brief:{committed:selected[0],stretch:[selected[1],selected[2]],selected,frozenAt:4,tieBreakRule:"Vote tokens descending."}});expect(html).toContain("BUILD STARTING");expect(html).toContain("Priorities are frozen");expect(html).toContain("#1 · 3 vote tokens");expect(html).not.toContain("Run build agent");});
  test("shows a completed simulated build with an immediate Brainstorm path",()=>{const steps=["preparing","analysing","coding","testing","publishing","complete"].map((stage,index)=>({stage:stage as any,status:(index<2?"complete":index===2?"active":"pending") as any,at:index<3?10:null,detail:`${stage} detail`}));const build={id:"build",status:"running" as const,currentStage:"coding" as const,simulated:true as const,steps,includedProposalIds:["one"],deferredProposalIds:["two","three"],startedAt:5,completedAt:null,validated:false,releaseUrl:null,failure:null};expect(render({...baseRound,phase:"building",build})).toContain("VISIBLE SIMULATED BUILD");const play=render({...baseRound,phase:"playtest",build:{...build,status:"succeeded",currentStage:"complete",validated:true,releaseUrl:"/templates/maze/index.html"}});expect(play).toContain("Build complete");expect(play).toContain("Brainstorm New Features");expect(play).not.toContain("Submit feedback");});
  test("opens generated playable releases without a feedback destination",()=>{const steps=["preparing","analysing","coding","testing","publishing","complete"].map((stage)=>({stage:stage as any,status:"complete" as const,at:10,detail:`${stage} detail`}));const build={id:"build",status:"succeeded" as const,currentStage:"complete" as const,simulated:false,steps,includedProposalIds:["one"],deferredProposalIds:["two","three"],startedAt:5,completedAt:20,validated:true,releaseUrl:"/projects/project123/versions/v1/",failure:null};const html=render({...baseRound,phase:"playtest",build});expect(html).toContain("Brainstorm New Features");expect(html).not.toContain("Play it, then report back");expect(html).toContain('href="/projects/project123/versions/v1/"');expect(html).toContain('target="_blank"');expect(html).toContain('rel="noreferrer"');});
  test("failed builds link to the previous stable playable release",()=>{const steps=["preparing","analysing","coding","testing"].map((stage)=>({stage:stage as any,status:stage==="testing"?"failed" as const:"complete" as const,at:10,detail:`${stage} detail`}));const build={id:"build",status:"failed" as const,currentStage:"failed" as const,simulated:false,steps,includedProposalIds:[],deferredProposalIds:["one","two","three"],startedAt:5,completedAt:20,validated:false,releaseUrl:null,failure:"Generated game did not draw anything into its visible canvas."};const html=renderToStaticMarkup(<ProjectRoomView project={{...project,stablePlayUrl:"/projects/project123/play/",round:{...baseRound,phase:"failed",build}}} draft={[]} remaining={0} roundRemaining={120} busy={false} status="" onChoose={noop} onClose={noop} onResolve={noop}/>);expect(html).toContain("Build failed safely");expect(html).toContain("Generated game did not draw anything");expect(html).toContain('href="/projects/project123/play/"');expect(html).toContain("Retry build agent");});
  test("renders active feature queue, truthful cycle loops, play link, and report action",()=>{
    const rankings=baseRound.proposals.slice(0,3).map((item,index)=>({...item,rank:index+1,votes:3-index,firstPlaceVotes:0,secondPlaceVotes:0,thirdPlaceVotes:0}));
    const selected=[rankings[0]!,rankings[1]!,rankings[2]!] as [typeof rankings[number],typeof rankings[number],typeof rankings[number]];
    const brief:FrozenBrief={committed:selected[0],stretch:[selected[1],selected[2]],selected,frozenAt:4,tieBreakRule:"Vote tokens descending."};
    const build={id:"build",status:"running" as const,currentStage:"coding" as const,simulated:false,steps:[],includedProposalIds:["one"],deferredProposalIds:["three"],startedAt:5,completedAt:null,validated:false,releaseUrl:null,failure:null,featureBuilds:[{proposalId:"one",queuePosition:1,status:"succeeded" as const,currentAgentLoop:null,steps:[{loop:"review" as const,status:"complete" as const,at:6,detail:"Reviewed"},{loop:"build" as const,status:"complete" as const,at:7,detail:"Built"},{loop:"test" as const,status:"complete" as const,at:8,detail:"Tested"}],releaseUrl:"/projects/project123/versions/v2/",failure:null,reportCount:0,latestReport:null,startedAt:5,completedAt:8},{proposalId:"two",queuePosition:2,status:"building" as const,currentAgentLoop:"build" as const,steps:[{loop:"review" as const,status:"complete" as const,at:9,detail:"Reviewed"},{loop:"build" as const,status:"active" as const,at:10,detail:"Building"}],releaseUrl:null,failure:null,reportCount:0,latestReport:null,startedAt:9,completedAt:null,activity:[{phase:"editing" as const,message:"LvlUP updated 2 game files and is checking the feature against the brief.",at:11}]},{proposalId:"three",queuePosition:3,status:"queued" as const,currentAgentLoop:null,steps:[],releaseUrl:null,failure:null,reportCount:0,latestReport:null,startedAt:null,completedAt:null}],activeFeatureProposalId:"two",reportCount:0,latestReport:null,previousStableUrl:"/projects/project123/versions/v1/"};
    const versionHistory=[{roundNumber:1,proposalId:"one",title:"Choice 1",playerChange:"Visible change 1",status:"succeeded" as const,releaseUrl:"/projects/project123/versions/v2/",completedAt:8}];
    const html=render({...baseRound,phase:"building",rankings,brief,build,versionHistory},true);
    expect(html).toContain("FEATURE BUILD QUEUE");
    expect(html).toContain("Choice 2");
    expect(html).toContain("Play this feature");
    expect(html).toContain('href="/projects/project123/versions/v2/"');
    expect(html).toContain("Game versions");
    expect(html).toContain("V1");
    expect(html).toContain("V2");
    expect(html).toContain("Visible change 1");
    expect(html).toContain("Play V1");
    expect(html).toContain("Play V2");
    expect(html).toContain("Review");
    expect(html).toContain("Build");
    expect(html).toContain("lvl_up is working");
    expect(html).toContain("LvlUP updated 2 game files");
    expect(html).not.toContain("Goose updated 2 game files");
    expect(html).not.toContain(">preparing<");
    expect(html).not.toContain(">publishing<");
    expect(html).toContain("Game is not running");
    expect(html).not.toContain("Play or follow the build");
    expect(html).not.toContain("Wait for the next feature");
    expect(html).toContain("Brainstorm New Features");
    expect(html).toContain('class="primary-button version-brainstorm-button"');
    expect(html).toContain('class="round-workspace version-rail-docked"');
    expect(html).toContain('class="project-utility-rail"');
    expect(html.indexOf('class="feature-build-card building"')).toBeLessThan(html.indexOf('class="feature-cycle-panel"'));
    expect(html).toContain("Cancel current build");
    expect(html).toContain("danger-button compact-button build-cancel-trigger");
    expect(render({...baseRound,phase:"building",rankings,brief,build,versionHistory},false)).not.toContain("Cancel current build");
    expect(html).not.toContain("Plan what comes next");
    expect(html).not.toContain("Brainstorm more features");
  });
  test("keeps prior-round releases and notes visible in a later Build screen",()=>{
    const proposal={...baseRound.proposals[0]!,roundId:"round-2",id:"round-two",title:"Round two feature",playerChange:"Adds the second-round feature",rank:1,votes:5,firstPlaceVotes:1,secondPlaceVotes:0,thirdPlaceVotes:0};
    const brief:FrozenBrief={committed:proposal,stretch:[],selected:[proposal],frozenAt:20,tieBreakRule:"Vote tokens descending."};
    const build={id:"build-2",status:"running" as const,currentStage:"analysing" as const,simulated:false,steps:[],includedProposalIds:[],deferredProposalIds:[proposal.id],startedAt:20,completedAt:null,validated:false,releaseUrl:null,failure:null,featureBuilds:[{proposalId:proposal.id,queuePosition:1,status:"reviewing" as const,currentAgentLoop:"review" as const,steps:[],releaseUrl:null,failure:null,reportCount:0,latestReport:null,startedAt:20,completedAt:null}],activeFeatureProposalId:proposal.id};
    const versionHistory=[{roundNumber:1,proposalId:"round-one-a",title:"Moon boots",playerChange:"Adds low-gravity jumps",status:"succeeded" as const,releaseUrl:"/projects/project123/versions/v2/",completedAt:8},{roundNumber:1,proposalId:"round-one-b",title:"Crystal gates",playerChange:"Adds portal shortcuts",status:"succeeded" as const,releaseUrl:"/projects/project123/versions/v3/",completedAt:12}];
    const html=render({...baseRound,id:"round-2",number:2,phase:"building",proposals:[proposal],rankings:[proposal],brief,build,versionHistory});
    expect(html).toContain("Play V2");expect(html).toContain("Play V3");expect(html).toContain("Moon boots");expect(html).toContain("Crystal gates");expect(html).toContain("Round 1");expect(html).toContain("Round two feature");
    expect(html.indexOf("Brainstorm New Features")).toBeLessThan(html.indexOf("Play V3"));
    expect(html.indexOf("Play V3")).toBeLessThan(html.indexOf("Play V2"));
    expect(html.indexOf("Play V2")).toBeLessThan(html.indexOf("Play V1"));
    expect(html).not.toContain("Play notes for this brainstorm");
  });
  test("keeps the Game versions brainstorm action clickable before the first delivery",()=>{
    const rankings=baseRound.proposals.slice(0,3).map((item,index)=>({...item,rank:index+1,votes:3-index,firstPlaceVotes:0,secondPlaceVotes:0,thirdPlaceVotes:0}));
    const brief:FrozenBrief={committed:rankings[0]!,stretch:rankings.slice(1),selected:rankings,frozenAt:4,tieBreakRule:"Vote tokens descending."};
    const build={id:"build",status:"running" as const,currentStage:"analysing" as const,simulated:false,steps:[],includedProposalIds:[],deferredProposalIds:[],startedAt:5,completedAt:null,validated:false,releaseUrl:null,failure:null,featureBuilds:rankings.map((proposal,index)=>({proposalId:proposal.id,queuePosition:index+1,status:(index===0?"reviewing":"queued") as "reviewing"|"queued",currentAgentLoop:index===0?"review" as const:null,steps:[],releaseUrl:null,failure:null,reportCount:0,latestReport:null,startedAt:index===0?5:null,completedAt:null})),activeFeatureProposalId:"one"};
    const html=render({...baseRound,phase:"building",rankings,brief,build,versionHistory:[]});
    expect(html).toMatch(/<button[^>]*>Brainstorm New Features<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Brainstorm New Features<\/button>/);
    expect(html).not.toContain("Plan what comes next");
  });
  test("collapses a previous-round build into a compact safe-release summary",()=>{
    const rankings=baseRound.proposals.slice(0,3).map((item,index)=>({...item,rank:index+1,votes:3-index,firstPlaceVotes:0,secondPlaceVotes:0,thirdPlaceVotes:0}));
    const brief:FrozenBrief={committed:rankings[0]!,stretch:rankings.slice(1),selected:rankings,frozenAt:4,tieBreakRule:"Vote tokens descending."};
    const background={id:"build",status:"failed" as const,currentStage:"failed" as const,simulated:false,steps:[],includedProposalIds:["one"],deferredProposalIds:[],startedAt:5,completedAt:10,validated:true,releaseUrl:"/projects/project123/versions/v2/",failure:"The AI agent replied, but Level Up could not safely read the required update.",featureBuilds:[{proposalId:"one",queuePosition:1,status:"succeeded" as const,currentAgentLoop:null,steps:[],releaseUrl:"/projects/project123/versions/v2/",failure:null,reportCount:0,latestReport:null,startedAt:5,completedAt:8},{proposalId:"two",queuePosition:2,status:"failed" as const,currentAgentLoop:null,steps:[],releaseUrl:null,failure:"The AI agent replied, but Level Up could not safely read the required update.",reportCount:0,latestReport:null,startedAt:9,completedAt:10},{proposalId:"three",queuePosition:3,status:"queued" as const,currentAgentLoop:null,steps:[],releaseUrl:null,failure:null,reportCount:0,latestReport:null,startedAt:null,completedAt:null}],activeFeatureProposalId:"two",previousStableUrl:"/projects/project123/versions/v2/"};
    const html=renderToStaticMarkup(<ProjectRoomView project={{...project,stablePlayUrl:"/projects/project123/versions/v2/",round:{...baseRound,number:2,phase:"brainstorm",activeBuild:{roundNumber:1,brief,build:background}}}} draft={[]} remaining={0} roundRemaining={120} busy={false} status="" onChoose={noop} onClose={noop} onResolve={noop}/>);
    expect(html).toContain('<details class="background-build-summary">');
    expect(html).not.toContain('<details class="background-build-summary" open=""');
    expect(html).toContain("ROUND 1 BUILD · FAILED");
    expect(html).toContain("1 built");
    expect(html).toContain("1 failed");
    expect(html).toContain("1 queued");
    expect(html).toContain("The current playable release is safe. Future builds continue from it.");
    expect(html.indexOf("background-build-summary")).toBeLessThan(html.indexOf("Ideas in the room"));
    expect(html).toContain('href="#ideas-title">Go to Brainstorm</a>');
    expect(html).not.toContain("New feature brainstorm in progress");
    expect(html).not.toContain(">Brainstorm New Features");
    expect(html).toContain("Retry build agent");
    expect(html).toContain("Defer feature");
    expect(html).toContain("Open prior playable game");
  });
});

function shortAuthor(npub:string){return `${npub.slice(0,12)}…${npub.slice(-8)}`;}

test('bot summary is compact, escaped, source-linked and has no human delivery label',()=>{
 const item={id:'source',authorAccountId:'member',authorNpub:'npub-member',worked:'Fast',improve:'Slow',nextIdea:'',clientEventId:'feedback-source',submittedAt:1};
 const html=render({...baseRound,phase:'brainstorm',summaryMessages:[{schemaVersion:1,id:'message',runId:'run',projectId:'project',sourceRoundId:'source-round',sourceRoundNumber:1,successorRoundId:'round',createdAt:1,author:{kind:'bot',id:'lvl_up',displayName:'lvl_up'},content:{schemaVersion:1,overview:'<script>malicious text</script>',worked:[],needsAttention:[{text:'Different speed preferences',feedbackIds:['source']}],suggestedUpdates:[],questions:[]}}],feedbackHistory:[{roundNumber:1,feedback:[item]}]});
 expect(html).toContain('&lt;script&gt;malicious text&lt;/script&gt;');expect(html).not.toContain('<script>malicious');expect(html).toContain('<small>BOT</small>');expect(html).toContain('href="#feedback-source"');expect(html.match(/<strong>lvl_up<\/strong>/g)).toHaveLength(1);expect(html).toContain('<details><summary>');expect(html).not.toContain('<details open');
});
test('summary surfaces and organiser continuation use readable semantic foregrounds',async()=>{
 const css=await Bun.file(new URL('./styles.css',import.meta.url)).text();expect(css).toMatch(/\.conversation-bubble-summary \.conversation-heading strong\s*\{\s*color: var\(--accent-on-light\)/);expect(css).toMatch(/\.summary-actions \.close-vote\s*\{\s*color: var\(--text-on-light\)/);
});
