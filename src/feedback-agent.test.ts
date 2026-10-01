import { afterAll, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentConfig, deniedClient, GooseFeedbackAgent, summaryPrompt } from './feedback-agent';
import { SqliteTeamRepository } from './storage';
import { playtestFixture } from '../test-support/summary-fixtures';
const dirs:string[]=[],repositories:SqliteTeamRepository[]=[];afterAll(()=>{for(const repository of repositories)repository.close();for(const dir of dirs)rmSync(dir,{recursive:true,force:true});});
function attempt(){const r=new SqliteTeamRepository(':memory:');repositories.push(r);const f=playtestFixture(r);const project=r.project(f.project.id,f.organiser.id);const round=r.round(f.project.id,f.organiser.id,1);r.loop.summaries.queue({schemaVersion:1,promptVersion:1,project:{id:project.id,name:project.name,templateTitle:project.selectedTemplate!.title,templateDescription:project.selectedTemplate!.description},sourceRound:{id:round.id,number:1},release:round.build,brief:round.brief,feedback:round.feedback},'test/model',65536);return r.loop.summaries.claim('test',5000,'test/model')!;}
function fixtureBinary(){const dir=mkdtempSync(join(tmpdir(),'levelup-fake-goose-'));dirs.push(dir);const path=join(dir,'goose');writeFileSync(path,`#!${process.execPath}\n`+require('node:fs').readFileSync(new URL('../test-support/fake-goose.ts',import.meta.url),'utf8'));chmodSync(path,0o700);return path;}
const sentinel='LEVELUP_SECRET_SENTINEL_NOT_REAL';
function config(binary:string,model='test/success'){return {...agentConfig({env:{OPENROUTER_API_KEY:sentinel,LEVELUP_AGENT_MODEL:model,LEVELUP_GOOSE_BIN:binary}}),timeoutMs:model==='test/timeout'?1000:3000};}
test.serial('missing configuration and invalid budgets fail safely before process launch',async()=>{
 for(const [env,code] of [[{},'setup_missing_key'],[{OPENROUTER_API_KEY:sentinel},'setup_missing_model']] as const){await expect(new GooseFeedbackAgent(agentConfig({env})).run(attempt(),new AbortController().signal,()=>{})).rejects.toMatchObject({code});}
 expect(()=>agentConfig({env:{LEVELUP_AGENT_CONCURRENCY:'0'}})).toThrow('setup_config');
 await expect(new GooseFeedbackAgent(config('/missing/goose')).run(attempt(),new AbortController().signal,()=>{})).rejects.toMatchObject({code:'setup_binary'});
});
test.serial('initial executable failure is classified, not an unhandled child error',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'levelup-bad-exec-'));dirs.push(dir);const binary=join(dir,'goose');writeFileSync(binary,'#!/this/interpreter/does/not/exist\n');chmodSync(binary,0o700);
 await expect(new GooseFeedbackAgent(config(binary)).run(attempt(),new AbortController().signal,()=>{})).rejects.toMatchObject({code:'setup_binary'});
});
test.serial('ACP subprocess receives minimal environment, collects final message only, and captures available usage',async()=>{
 const a=attempt();process.env.LEVELUP_TEST_INHERITED='must-not-be-inherited';
 try{const result=await new GooseFeedbackAgent(config(fixtureBinary())).run(a,new AbortController().signal,()=>{});expect(result.output).toMatchObject({overview:'Isolated fixture summary'});expect(result.usage).toEqual({inputTokens:4,outputTokens:8,cost:null});expect(JSON.stringify(result)).not.toContain(sentinel);expect(JSON.stringify(result)).not.toContain('PRIVATE REASONING');expect(summaryPrompt(a.input)).not.toContain(sentinel);}
 finally{delete process.env.LEVELUP_TEST_INHERITED;}
});
test.serial('feedback structured call repairs a malformed first turn in the same session',async()=>{
 const result=await new GooseFeedbackAgent(config(fixtureBinary(),'test/repair')).run(attempt(),new AbortController().signal,()=>{});
 expect(result.output).toMatchObject({overview:'Isolated fixture summary'});
 expect(result.usage).toEqual({inputTokens:6,outputTokens:9,cost:null});
});
test.serial('provider errors, timeouts, malformed/oversize output, foreign IDs, permissions and nonterminal stop fail safely',async()=>{
 const binary=fixtureBinary();const a=attempt();
 for(const [mode,code] of [['provider','provider_error'],['timeout','timeout'],['malformed','invalid_output'],['oversize','output_too_large'],['foreign','invalid_output'],['permission','permission_denied'],['stop','invalid_output'],['tools','setup_isolation'],['secret','invalid_output']]){
  try{await new GooseFeedbackAgent(config(binary,`test/${mode}`)).run(a,new AbortController().signal,()=>{});throw new Error(`Unexpected success: ${mode}`);}catch(e){expect(e).toMatchObject({code});expect(String(e)).not.toContain(sentinel);}
 }
});
test.serial('oversize input explicitly fails without truncation; cancelled attempt kills only its owned child',async()=>{
 const a=attempt();const binary=fixtureBinary();await expect(new GooseFeedbackAgent({...config(binary),maxInputBytes:20}).run(a,new AbortController().signal,()=>{})).rejects.toMatchObject({code:'input_too_large'});
 const controller=new AbortController();const run=new GooseFeedbackAgent(config(binary,'test/timeout')).run(a,controller.signal,()=>controller.abort());await expect(run).rejects.toMatchObject({code:'interrupted'});
});
test.serial('client declines ACP file, terminal and permission requests',async()=>{
 let denied=0;const client=deniedClient(()=>{},()=>denied++);
 expect(await client.requestPermission({sessionId:'s',options:[],toolCall:{toolCallId:'t',title:'test',status:'pending'}})).toEqual({outcome:{outcome:'cancelled'}});
 await expect(client.readTextFile!({sessionId:'s',path:'/not-permitted'})).rejects.toThrow('permission_denied');
 await expect(client.writeTextFile!({sessionId:'s',path:'/not-permitted',content:'no'})).rejects.toThrow('permission_denied');
 await expect(client.createTerminal!({sessionId:'s',command:'false'})).rejects.toThrow('permission_denied');expect(denied).toBe(4);
});

test.serial('attempt-local provider guard allows the configured turn budget and rejects extras',async()=>{
 const {summaryProviderGateway}=await import('./summary-provider-gateway');let calls=0;
 const upstream=Bun.serve({hostname:'127.0.0.1',port:0,fetch(){calls++;return new Response('data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});}});
 const c=config('/unused');const gateway=summaryProviderGateway(c,new AbortController().signal,`http://127.0.0.1:${upstream.port}`);
 const request=()=>fetch(`${gateway.origin}/api/v1/chat/completions`,{method:'POST',headers:{authorization:`Bearer ${sentinel}`,'content-type':'application/json'},body:JSON.stringify({model:c.model,messages:[],tools:[],tool_choice:'none',stream:true,max_tokens:100})});
 try{expect((await request()).status).toBe(200);expect((await request()).status).toBe(200);expect((await request()).status).toBe(200);expect((await request()).status).toBe(429);expect(calls).toBe(3);expect((await fetch(`${gateway.origin}/api/v1/models`)).status).toBe(401);}
 finally{gateway.stop();upstream.stop(true);}
});
