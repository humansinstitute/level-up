// Isolated real HTTP/WS/React browser acceptance with a replaceable, deferred model adapter.
// Writes screenshots only under .validation-dist; never serves or mutates live dist/data.
import { chromium, type Page } from 'playwright';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, type EventTemplate } from 'nostr-tools';
import { mkdir } from 'node:fs/promises';
import { createApplication } from '../src/api';
import { AuthService } from '../src/auth';
import { SqliteTeamRepository } from '../src/storage';
import { RoundRealtimeHub, type RoundSocketData } from '../src/realtime';
import { FeedbackWorker } from '../src/feedback-agent';
import { SummaryError } from '../src/feedback-summary';
import type { SummaryAttempt, SummaryCompletion } from '../src/summary-store';
import { playtestFixture, fixtureOutput } from '../test-support/summary-fixtures';
const assert=(condition:unknown,message:string)=>{if(!condition)throw new Error(message);};
const identity=()=>{const secret=generateSecretKey(),pubkey=getPublicKey(secret);return {secret,pubkey,npub:nip19.npubEncode(pubkey)};};
const organiserIdentity=identity(),playerIdentity=identity();
const repository=new SqliteTeamRepository(':memory:');const f=playtestFixture(repository,{organiser:organiserIdentity,player:playerIdentity});
const auth=new AuthService({accessMode:'open',sessionStore:repository});const hub=new RoundRealtimeHub(auth,repository);
const app=createApplication({repository,auth,staticRoot:new URL('../.validation-dist',import.meta.url).pathname,onRoundEvent:(id,event,round)=>hub.publish(id,event,round)});
const sockets=new Set<Bun.ServerWebSocket<RoundSocketData>>();let reconnects=0;
const server=Bun.serve<RoundSocketData>({hostname:'127.0.0.1',port:0,fetch(req,s){const result=hub.upgrade(req,s);return result===null?app.fetch(req):result;},websocket:{open(s){sockets.add(s);reconnects++;hub.open(s);},message(s,m){hub.message(s,m);},close(s){sockets.delete(s);hub.close(s);}}});
const origin=`http://127.0.0.1:${server.port}`;
let active: {attempt:SummaryAttempt;resolve:(r:SummaryCompletion)=>void;reject:(e:Error)=>void}|undefined;
const worker=new FeedbackWorker(repository.loop.summaries,{run(attempt){return new Promise((resolve,reject)=>{active={attempt,resolve,reject};});}},{model:'mock/browser-fixture',timeoutMs:120000,concurrency:1},()=>hub.refreshSummaryChanges());worker.start();
const browser=await chromium.launch({headless:true,channel:'chrome'});const errors:string[]=[];
const contexts=[];
async function signedContext(who:ReturnType<typeof identity>,width:number){
 const context=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce'});contexts.push(context);
 const challenge=await (await fetch(`${origin}/api/auth/challenge`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pubkey:who.pubkey})})).json() as {nonce:string;event:EventTemplate};
 const login=await fetch(`${origin}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pubkey:who.pubkey,nonce:challenge.nonce,event:finalizeEvent(challenge.event,who.secret)})});assert(login.ok,'signed login');
 const cookie=login.headers.get('set-cookie')!.split(';')[0]!.split('=');await context.addCookies([{name:cookie[0]!,value:cookie[1]!,url:origin}]);
 // Relay/extension noise is unrelated to the app flow; no external traffic required.
 await context.route(/https:\/\/(?!127\.0\.0\.1)/,route=>route.abort());
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));return {context,page};
}
async function visible(page:Page,text:string){await page.getByText(text,{exact:false}).first().waitFor({state:'visible'});}
async function noOverflow(page:Page,label:string){const sizes=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth}));assert(sizes.scroll<=sizes.width,`${label}: overflow ${JSON.stringify(sizes)}`);}
async function shot(page:Page,name:string){await noOverflow(page,name);await page.screenshot({path:`.validation-dist/screenshots/${name}.png`,fullPage:true});}
async function contrast(page:Page){
 const pairs=await page.evaluate(()=>['.conversation-bubble-summary .conversation-heading strong','.conversation-bubble-summary .conversation-meta small','.summary-actions .close-vote','.conversation-bubble-summary .conversation-content p'].map(selector=>{const el=document.querySelector(selector)!;const style=getComputedStyle(el);let surface:Element|null=el;while(surface&&['rgba(0, 0, 0, 0)','transparent'].includes(getComputedStyle(surface).backgroundColor))surface=surface.parentElement;return {selector,foreground:style.color,background:getComputedStyle(surface!).backgroundColor};}));
 const lum=(color:string)=>{const c=color.match(/[\d.]+/g)!.slice(0,3).map(Number).map(v=>{const s=v/255;return s<=0.04045?s/12.92:((s+0.055)/1.055)**2.4;});return c[0]!*0.2126+c[1]!*0.7152+c[2]!*0.0722;};
 for(const p of pairs){const a=lum(p.foreground),b=lum(p.background);assert((Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)>=4.5,`contrast: ${p.selector}`);}
 const button=page.getByRole('button',{name:'Start discussion with original feedback',exact:true});const bounds=await button.boundingBox();assert(bounds&&bounds.height>=44&&bounds.width>=44,'continuation touch target');
 await button.focus();await page.keyboard.press('Shift+Tab');await page.keyboard.press('Tab');assert(await button.evaluate(el=>getComputedStyle(el).outlineStyle!=='none'),'visible keyboard focus');
}
try{
 await mkdir('.validation-dist/screenshots',{recursive:true});
 const organiser=await signedContext(organiserIdentity,320),player=await signedContext(playerIdentity,390);
 // Immediately previous HTTP payload shape at a fresh visible boundary.
 await organiser.page.route(`**/api/projects/${f.project.id}`,async route=>{const response=await route.fetch();const json=await response.json();delete json.project.round.summaryRun;delete json.project.round.summaryMessages;await route.fulfill({response,json});});
 await organiser.page.goto(`${origin}/projects/${f.project.id}`);await visible(organiser.page,'2 submitted notes');await organiser.page.unroute(`**/api/projects/${f.project.id}`);
 await player.page.goto(`${origin}/projects/${f.project.id}`);await visible(player.page,'Play it, then report back');
 // Lost acknowledgement: server commits once, reload retries the same durable client ID.
 let ackLost=true, submittedClientId='';
 await player.page.route('**/rounds/1/feedback',async route=>{if(ackLost){ackLost=false;submittedClientId=route.request().postDataJSON().clientEventId;await route.fetch();await route.abort('failed');}else await route.continue();});
 await player.page.getByLabel('What worked?').fill('Lost acknowledgement test note');await player.page.getByRole('button',{name:'Submit feedback',exact:true}).click();
 for(let i=0;i<100&&repository.round(f.project.id,f.player.id).feedback.length<3;i++)await Bun.sleep(20);
 await player.page.reload();await visible(player.page,'Play it, then report back');assert(await player.page.getByLabel('What worked?').inputValue()==='Lost acknowledgement test note','unacknowledged draft survives reload');
 const stored=await player.page.evaluate(key=>JSON.parse(localStorage.getItem(key)!),`levelup-feedback:${playerIdentity.npub}:${f.project.id}`);assert(stored.clientEventId===submittedClientId,'durable feedback client event ID');
 await player.page.getByRole('button',{name:'Submit feedback',exact:true}).click();for(let i=0;i<100&&await player.page.getByLabel('What worked?').inputValue();i++)await Bun.sleep(20);assert(await player.page.getByLabel('What worked?').inputValue()==='', 'acknowledged retry clears unchanged draft');
 assert(repository.round(f.project.id,f.player.id).feedback.length===3,'lost acknowledgement retry does not duplicate');await player.page.unroute('**/rounds/1/feedback');
 await player.page.getByLabel('What should improve?').fill('Late draft: make the doorway clearer');
 let releaseLate!:()=>void;const lateGate=new Promise<void>(resolve=>releaseLate=resolve);let lateHeld=false;
 await player.page.route('**/rounds/1/feedback',async route=>{lateHeld=true;await lateGate;await route.continue();});
 const pendingClick=player.page.getByRole('button',{name:'Submit feedback',exact:true}).click();await pendingClick;
 for(let i=0;i<50&&!lateHeld;i++)await Bun.sleep(20);assert(lateHeld,'late request held before closure');
 await organiser.page.getByRole('button',{name:'Summarise feedback & start discussion',exact:true}).click();
 await visible(organiser.page,"I'm reviewing the team's feedback.");await visible(player.page,'Your unsubmitted feedback');releaseLate();
 await visible(player.page,'Keep your draft');assert(await player.page.getByLabel('Retained feedback draft').inputValue()==='Late draft: make the doorway clearer','late draft retained');
 assert(await organiser.page.getByRole('timer').count()===0,'no countdown while summary pending');
 await shot(organiser.page,'summary-pending-320');
 assert(await organiser.page.locator('.bot-avatar img').evaluate((img:any)=>img.complete&&img.naturalWidth>0),'bundled bot avatar loads');
 await player.page.reload();await visible(player.page,'Late draft: make the doorway clearer');
 for(let i=0;i<50&&!active;i++)await Bun.sleep(20);assert(active,'worker claimed queued feedback');active!.reject(new SummaryError('provider_error'));
 await visible(organiser.page,'Retry summary');assert(await organiser.page.getByRole('timer').count()===0,'no timer while failed');assert(await player.page.getByRole('button',{name:'Retry summary'}).count()===0,'member has no retry');
 await contrast(organiser.page);await shot(organiser.page,'summary-failed-320');
 await organiser.page.getByRole('button',{name:'Retry summary',exact:true}).click();
 for(let i=0;i<50&&active!.attempt.attemptNumber!==2;i++)await Bun.sleep(20);assert(active!.attempt.attemptNumber===2,'retry attempt claimed');
 active!.resolve({output:fixtureOutput(active!.attempt),sessionId:'browser-fixture',usage:null});
 await visible(organiser.page,'The team enjoyed different aspects');assert(await organiser.page.getByRole('timer').count()===1,'successor has one timer');await visible(player.page,'The team enjoyed different aspects');
 assert(await organiser.page.locator('.summary-history .conversation-bubble-summary').count()===1,'one completed bot message');
 await organiser.page.locator('.summary-history summary').click();await visible(organiser.page,'Suggested updates');
 for(const width of [320,390,1280]){await organiser.page.setViewportSize({width,height:900});await shot(organiser.page,`summary-completed-${width}`);}
 const id=repository.round(f.project.id,f.player.id).summaryMessages![0]!.id;const beforeReconnect=reconnects;
 for(const s of sockets)if(s.data.accountId===f.player.id)s.close(1012,'isolated reconnect test');
 for(let i=0;i<150&&reconnects===beforeReconnect;i++)await Bun.sleep(20);assert(reconnects>beforeReconnect,'real WebSocket reconnect');
 await visible(player.page,'The team enjoyed different aspects');await player.page.reload();await visible(player.page,'The team enjoyed different aspects');
 assert(repository.round(f.project.id,f.player.id).summaryMessages![0]!.id===id,'same durable ID after reconnect/fresh load');
 await player.page.getByLabel('Add an idea').fill('Keep both speed preferences in discussion');await player.page.getByRole('button',{name:'Send idea'}).click();await visible(organiser.page,'Keep both speed preferences in discussion');
 const other=repository.createProject(f.project.teamId,f.organiser.id,'Separate draft project');repository.replaceTemplateSelections(other.id,f.organiser.id,['maze-minotaur','neon-snake']);repository.closeTemplateSelection(other.id,f.organiser.id);repository.resolveTemplateTie(other.id,f.organiser.id,'maze-minotaur');
 await player.page.evaluate(id=>{history.pushState({},'',`/projects/${id}`);dispatchEvent(new PopStateEvent('popstate'));},other.id);
 await visible(player.page,'Separate draft project');assert(await player.page.getByLabel('Retained feedback draft').count()===0,'project change does not leak previous draft');
 assert(errors.length===0,`application exceptions: ${errors.join('; ')}`);
 console.log(JSON.stringify({ok:true,real:['signed auth','HTTP close and late submission','WebSocket broadcast/reconnect','fresh React load','previous HTTP shape','draft reload','human discussion action'],mocked:['feedback model output','provider failure'],screenshots:['summary-pending-320','summary-failed-320','summary-completed-320','summary-completed-390','summary-completed-1280'],live:false,paidInference:false,applicationExceptions:errors}));
}finally{worker.stop();for(const s of sockets)s.close();await browser.close();server.stop(true);repository.close();}
