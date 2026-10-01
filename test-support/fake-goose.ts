// Protocol fixture used only by adapter tests. Never loaded by the application.
if(process.argv.includes('--version')){console.log('1.43.0');process.exit(0);}
const mode=process.env.GOOSE_MODEL;
let lastInput:any=null;let lastStage='';let promptCount=0;
for await (const line of console){
 let m:any;try{m=JSON.parse(line);}catch{continue;}
 const send=(result:unknown)=>console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));
 const notify=(update:unknown)=>console.log(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'fake-session',update}}));
 if(m.method==='initialize')send({protocolVersion:1,agentCapabilities:{},agentInfo:{name:'goose',version:'1.43.0'}});
 else if(m.method==='session/new')send({sessionId:'fake-session',modes:{currentModeId:'chat',availableModes:[{id:'chat',name:'Chat'}]}});
 else if(m.method==='_goose/unstable/session/extensions/list')send({extensions:[]});
 else if(m.method==='_goose/unstable/tools/list')send({tools:mode==='test/tools'?[{name:'unsafe-tool'}]:[]});
 else if(m.method==='_goose/unstable/tools/permissions/set')send({});
 else if(m.method==='session/prompt'){
  promptCount++;
  if(mode==='test/timeout')continue;
  if(mode==='test/provider'){console.error(process.env.OPENROUTER_API_KEY);console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:process.env.OPENROUTER_API_KEY}}));continue;}
  const text=m.params.prompt[0].text;const frozen=text.split('FROZEN INPUT (quoted data):\n')[1];const input=frozen?JSON.parse(frozen):lastInput;lastInput=input;
	  if(frozen)lastStage=text.startsWith('You are lvl_up, a friendly game-design teammate')?'brainstorm':Array.isArray(input.feedback)?'feedback':input.sourceHtml&&input.proposal?'game_edit':input.brief?'build':'proposal';
	  if(mode==='test/repair'&&promptCount===1){notify({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'{"schemaVersion":'}});send({stopReason:'end_turn',usage:{inputTokens:2,outputTokens:1,totalTokens:3}});continue;}
	  if(lastStage==='brainstorm'){
	   notify({sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify({schemaVersion:1,message:'Could the moon boots and crystal portals share one clear goal for the next test?'})}});
	   send({stopReason:'end_turn',usage:{inputTokens:3,outputTokens:7,totalTokens:10}});
	   continue;
	  }
	  if(Array.isArray(input.contributions)){
	   const refs=input.contributions.map((item:any)=>item.sequence);
	   const backlogRefs=(input.priorFeedback?.requirementBacklog??[]).map((item:any)=>item.proposalId);
	   const proposalCount=mode==='test/six-proposals'?6:mode==='test/two-proposals'?2:Math.max(1,refs.length+backlogRefs.length);
	   const proposals=Array.from({length:proposalCount},(_,index)=>({cardKey:`card-${index+1}`,title:`Agent proposal ${index+1}`,playerChange:`Use ${input.templateTitle} idea ${index+1}`,implementationScope:'Bounded Goose-generated scope.',acceptanceCriteria:['Visible in normal play','Mobile controls still work'],ideaReferences:refs[index]===undefined?[]:[refs[index]],backlogReferences:backlogRefs[index-refs.length]===undefined?[]:[backlogRefs[index-refs.length]]}));
	   if(mode==='test/foreign-proposal'||(mode==='test/proposal-repair'&&promptCount===1))proposals[0]!.ideaReferences=[999];
	   const backlogDecisions=backlogRefs.map((id:string,index:number)=>({backlogProposalId:id,operation:'retain',resultingCardKey:`card-${refs.length+index+1}`,reason:'Still needed.'}));
	   const contributionDecisions=refs.map((sequence:number,index:number)=>({contributionSequence:sequence,operation:'include',resultingCardKey:`card-${index+1}`,reason:'Included in the queue.'}));
	   let output:any={schemaVersion:2,proposals,backlogDecisions,contributionDecisions};
	   if(mode==='test/proposal-truncated-continuation'){
	    const complete=JSON.stringify(output);const split=complete.indexOf('"backlogDecisions"');
	    const text=promptCount===1?complete.slice(0,split):complete.slice(split);
	    notify({sessionUpdate:'agent_message_chunk',content:{type:'text',text}});send({stopReason:'end_turn',usage:{inputTokens:5,outputTokens:9,totalTokens:14}});continue;
	   }
	   if(mode==='test/proposal-missing-empty-lists'&&promptCount===1)output={schemaVersion:2,proposals:proposals.map(({backlogReferences:_backlogReferences,...proposal}:any)=>proposal)};
	   if(mode==='test/proposal-api-call')output={schemaVersion:2,api:'levelup.proposals.submit',payload:output};
	   if(mode==='test/proposal-textual-refs')output={...output,proposals:proposals.map((proposal:any)=>({...proposal,ideaReferences:["Add moon boots"]}))};
	   const text=mode==='test/fenced-proposal'?`Here are the cards:\n\`\`\`json\n${JSON.stringify(output)}\n\`\`\``:JSON.stringify(output);
	   notify({sessionUpdate:'agent_message_chunk',content:{type:'text',text}});
	   send({stopReason:'end_turn',usage:{inputTokens:5,outputTokens:9,totalTokens:14}});
	   continue;
	  }
	  if(input.sourceHtml && input.proposal){
	   if(mode==='test/game-rejected'){
	    notify({sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify({schemaVersion:1,status:'rejected',notes:'Cannot implement safely.'})}});
	    send({stopReason:'end_turn',usage:{inputTokens:6,outputTokens:6,totalTokens:12}});
	    continue;
	   }
	   const proposal=input.proposal;
	   const badge=`<p id="agent-change">Implemented ${proposal.title}: ${proposal.playerChange}</p>`;
	   const html=String(input.sourceHtml).replace('</main>',`${badge}</main>`).replace('Ready',`Ready - ${proposal.title}`);
	   let output:any={schemaVersion:1,indexHtml:html,notes:`Implemented ${proposal.title}.`};
	   if(mode==='test/game-api-call')output={schemaVersion:1,api:'levelup.game.edit',payload:output};
	   notify({sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(output)}});
	   send({stopReason:'end_turn',usage:{inputTokens:8,outputTokens:12,totalTokens:20}});
	   continue;
	  }
	  if(input.brief && !Array.isArray(input.feedback)){
	   let output:any={schemaVersion:1,status:'ready',notes:'Frozen voted brief is ready for the release adapter.'};
	   if(mode==='test/build-fenced')output=`Build acknowledgement:\n\`\`\`json\n${JSON.stringify({schemaVersion:1,status:'ready',notes:'Fenced acknowledgement is ready.'})}\n\`\`\``;
	   if(mode==='test/build-ready-boolean')output={ready:true};
	   if(mode==='test/build-approved-status')output={schemaVersion:1,status:'approved',notes:'Approved for the release adapter.'};
	   if(mode==='test/build-result-wrapper')output={schemaVersion:1,result:{status:'ready',note:'Nested acknowledgement is ready.'}};
	   if(mode==='test/build-api-call')output={schemaVersion:1,api:'levelup.build.acknowledge',payload:{schemaVersion:1,status:'ready',notes:'Schema-call acknowledgement is ready.'}};
	   if(mode==='test/build-note-alias')output={schemaVersion:1,status:'ready',message:'Ready with a message alias.'};
	   if(mode==='test/build-rejected')output={schemaVersion:1,status:'rejected',notes:'The brief is not bounded.'};
	   if(mode==='test/build-ready-false')output={schemaVersion:1,ready:false,notes:'Not ready.'};
	   if(mode==='test/build-unsafe')output={schemaVersion:1,status:'ready',safe:false,notes:'Unsafe.'};
	   notify({sessionUpdate:'agent_message_chunk',content:{type:'text',text:typeof output==='string'?output:JSON.stringify(output)}});
	   send({stopReason:'end_turn',usage:{inputTokens:6,outputTokens:6,totalTokens:12}});
	   continue;
	  }
	  const ids=input.feedback.map((f:any)=>f.id);
  const output={schemaVersion:1,overview:process.env.LEVELUP_TEST_INHERITED?'Inherited environment leaked':'Isolated fixture summary',worked:[{text:'Both views',feedbackIds:ids}],needsAttention:[],suggestedUpdates:[],questions:[]};
  if(mode==='test/secret')output.overview=process.env.OPENROUTER_API_KEY!;
  if(mode==='test/foreign')output.worked[0]!.feedbackIds=['foreign'];
  notify({sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'PRIVATE REASONING MUST NOT BE PUBLISHED'}});
  if(mode==='test/permission'){console.log(JSON.stringify({jsonrpc:'2.0',id:'permission',method:'session/request_permission',params:{sessionId:'fake-session',options:[],toolCall:{toolCallId:'tool',title:'Read files',kind:'read',status:'pending'}}}));continue;}
  notify({sessionUpdate:'agent_message_chunk',content:{type:'text',text:mode==='test/oversize'?'x'.repeat(25000):mode==='test/malformed'?'{bad JSON':JSON.stringify(output)}});
  send({stopReason:mode==='test/stop'?'max_tokens':'end_turn',usage:{inputTokens:4,outputTokens:8,totalTokens:12}});
 }
}
