// Real pinned Goose and ACP; local provider stub only. No paid or live app requests.
import { GooseFeedbackAgent, agentConfig } from '../src/feedback-agent';
import { SqliteTeamRepository } from '../src/storage';
import { playtestFixture,fixtureOutput } from '../test-support/summary-fixtures';
const repo=new SqliteTeamRepository(':memory:');const f=playtestFixture(repo);repo.closeFeedback(f.project.id,f.organiser.id);
const attempt=repo.loop.summaries.claim('preflight',30000,'levelup/local-preflight')!;
const toolProbe=process.argv.includes('--tool-probe'),timeoutProbe=process.argv.includes('--timeout-probe'),cancelProbe=process.argv.includes('--cancel-probe');
const controller=new AbortController();let upstreamCancelled=false;
const sentinel='levelup-preflight-not-a-real-provider-secret';let calls=0,keyMapped=false,toolsEmpty=false;
const server=Bun.serve({port:0,hostname:'127.0.0.1',async fetch(request){
  if(new URL(request.url).pathname.endsWith('/models'))return Response.json({data:[{id:'levelup/local-preflight',name:'Local fixture',context_length:64000,pricing:{prompt:'0',completion:'0'},supported_parameters:['tools'],top_provider:{max_completion_tokens:2000}}]});
  const body=await request.json() as Record<string,unknown>;calls++;keyMapped=request.headers.get('authorization')===`Bearer ${sentinel}`;toolsEmpty=body.tools===undefined||(Array.isArray(body.tools)&&body.tools.length===0);
  console.log(JSON.stringify({providerPath:new URL(request.url).pathname,keyMapped,toolsEmpty,stream:body.stream}));
  if(timeoutProbe||cancelProbe){
    request.signal.addEventListener('abort',()=>{upstreamCancelled=true;},{once:true});
    if(cancelProbe)setTimeout(()=>controller.abort(),50);
    return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({id:'local',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant'},finish_reason:null}]})}\n\n`));},cancel(){upstreamCancelled=true;}}),{headers:{'content-type':'text/event-stream'}});
  }
  if(toolProbe)return new Response(`data: ${JSON.stringify({id:'local',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'probe',type:'function',function:{name:'platform__manage_schedule',arguments:JSON.stringify({action:'list'})}}]},finish_reason:null}]})}\n\ndata: ${JSON.stringify({id:'local',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'tool_calls'}]})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});
  const content=JSON.stringify(fixtureOutput(attempt));
  if(body.stream)return new Response(`data: ${JSON.stringify({id:'local',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',content},finish_reason:null}]})}\n\ndata: ${JSON.stringify({id:'local',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});
  return Response.json({id:'local',object:'chat.completion',choices:[{index:0,message:{role:'assistant',content},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}});
}});
try {
 const agent=new GooseFeedbackAgent(agentConfig({env:{OPENROUTER_API_KEY:sentinel,LEVELUP_AGENT_MODEL:'levelup/local-preflight',LEVELUP_AGENT_TIMEOUT_SECONDS:timeoutProbe?'1':'20'}}),`http://127.0.0.1:${server.port}`);
 const result=await agent.run(attempt,controller.signal,()=>console.log('ACP session created'));
 if(toolProbe||timeoutProbe||cancelProbe)throw new Error('Failure probe must fail');
 if(calls!==1||!keyMapped||!toolsEmpty)throw new Error('Preflight invariant failed');
 console.log(JSON.stringify({ok:true,goose:'1.43.0',sdk:'0.16.0',calls,keyMapped,toolsEmpty,outputValidated:!!result.output,paidInference:false}));
} catch(e){
 const code=e instanceof Error?e.message:'failed';
 if(timeoutProbe||cancelProbe)for(let i=0;i<100&&!upstreamCancelled;i++)await Bun.sleep(10);
 const expected=toolProbe?['permission_denied','invalid_output'].includes(code):timeoutProbe?code==='timeout'&&upstreamCancelled:cancelProbe?code==='interrupted'&&upstreamCancelled:false;
 const passed=expected&&calls===1&&keyMapped&&toolsEmpty;
 console.log(JSON.stringify({ok:passed,error:code,calls,keyMapped,toolsEmpty,toolProbe,timeoutProbe,cancelProbe,upstreamCancelled,paidInference:false}));if(!passed)process.exitCode=1;
}
finally{server.stop(true);repo.close();}
