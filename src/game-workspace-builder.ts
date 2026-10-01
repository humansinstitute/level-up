import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION, type Client } from "@agentclientprotocol/sdk";
import { activityLog } from "./activity-log";
import { appendAgentTraceTurn, beginAgentTrace, completeAgentTrace, failAgentTrace, markAgentTraceSession } from "./agent-trace";
import { renderAgentPrompt } from "./admin-prompts";
import { invocationAgentConfig, type AgentConfig, GOOSE_VERSION } from "./feedback-agent";
import { SummaryError } from "./feedback-summary";
import type { BuildAdapter, BuildAdapterInput, BuildAdapterResult, FeatureDeliveryOutcome, RankedProposal } from "./loop";
import { summaryProviderGateway } from "./summary-provider-gateway";

export const GAME_PACKAGE_VERSION = 1;
export const FEATURE_BUILD_MAX_TURNS = 100;
const DEFAULT_INACTIVITY_BUDGET_MS = 2 * 60_000;
const DEFAULT_TOTAL_BUDGET_MS = 15 * 60_000;
const IMPLEMENTATION_TOTAL_BUDGET_MS = 15 * 60_000;
const REVIEW_TOTAL_BUDGET_MS = 10 * 60_000;
const DEFAULT_FEATURE_OUTPUT_TOKENS = 32_768;
const MAX_FEATURE_OUTPUT_TOKENS = 256_021;
const ALLOWED_COMMANDS = ["bun run build", "bun test", "bun run check"] as const;

export interface WorkspaceHandoff { status: "complete" | "no_change" | "approved" | "changes_required"; notes: string; evidence: string[] }
export interface WorkspaceAgentProgress { sessionId?: string; providerAttempts: number; meaningfulTurns: number; emptyAttempts: number; phase: "inspecting"|"editing"|"testing"|"repairing"; lastProgressAt: number; changedFiles: string[]; diagnostics: string[]; activityMessage?: string; usage: { inputTokens: number; outputTokens: number; cost: number | null } }
export interface WorkspaceCodingAgent {
  run(input: { workspace: string; prompt: string; signal: AbortSignal; onProgress: (progress: WorkspaceAgentProgress) => void; inactivityBudgetMs?:number; totalBudgetMs?:number; traceFields?: { projectId:string; roundNumber:number; proposalId:string; runId:string } }): Promise<{ handoff: WorkspaceHandoff; progress: WorkspaceAgentProgress }>;
}

export interface WorkspaceBuildOptions {
  templateRoot?: string; workspaceRoot?: string; snapshotRoot?: string; releaseRoot?: string;
  agent: WorkspaceCodingAgent;
}

function safeSegment(value: string, label: string): string {
  if (!/^[a-zA-Z0-9_-]{3,100}$/.test(value)) throw new Error(`invalid_${label}`);
  return value;
}
function inside(root: string, path: string): boolean { const rel=relative(resolve(root),resolve(path)); return rel===""||(!rel.startsWith("..")&&!isAbsolute(rel)); }
function ensureInside(root: string, path: string): string { if(!inside(root,path))throw new Error("workspace_path_escape");return normalize(path); }
function templateId(url: string): string { const match=url.match(/^\/templates\/([a-zA-Z0-9_-]+)\/index\.html$/);if(!match)throw new Error("unsupported_template");return safeSegment(match[1]!,"template_id"); }
function json(value: unknown): string { return JSON.stringify(value,null,2)+"\n"; }
function files(root: string, current=root): string[] { return readdirSync(current,{withFileTypes:true}).flatMap(entry=>entry.name==="node_modules"||entry.name==="dist"?[]:entry.isDirectory()?files(root,join(current,entry.name)):[relative(root,join(current,entry.name))]).sort(); }
function digest(root: string): string { const hash=createHash("sha256");for(const name of files(root)){hash.update(name);hash.update(readFileSync(join(root,name)));}return hash.digest("hex"); }
function checksum(root: string): string { return digest(root); }
function copyContents(from: string, to: string): void { mkdirSync(to,{recursive:true});for(const entry of readdirSync(from,{withFileTypes:true}))cpSync(join(from,entry.name),join(to,entry.name),{recursive:true,errorOnExist:true}); }
function versionFromUrl(url: string|null): number|null { const match=url?.match(/\/versions\/v(\d+)\/?$/);return match?Number(match[1]):null; }
function failureMessage(error: unknown): string {
  if(error instanceof Error)return error.message;
  if(error&&typeof error==="object"&&"message" in error&&typeof error.message==="string")return error.message;
  if(typeof error==="string"&&error.trim())return error.trim();
  return "Feature build failed.";
}
function playerSafeWorkspaceFailure(error: unknown): string {
  const detail=error instanceof SummaryError?(error.correction??error.code):failureMessage(error);
  if(detail==="feature_build_no_progress")return "LvlUP did not complete a tool action, source change, or handoff within the retry limit. Retry the feature or choose another build model.";
  if(detail==="provider_request_budget_exhausted"||detail.includes("request budget"))return "The build agent exhausted its provider request budget before completing the feature. Retry the feature or choose another build model.";
  if(detail==="feature_build_elapsed_budget"||detail==="feature_build_inactivity_budget"||detail==="feature_build_final_cap")return "The build agent stopped making progress before completing the feature. Retry to continue from a fresh workspace.";
  if(detail==="feature_build_reasoning_stall")return "The selected model twice used its full response on reasoning without returning an action. Retry with another model or a lower reasoning setting.";
  if(detail==="setup_missing_key"||detail==="setup_missing_model"||detail==="setup_binary")return `The build agent is not configured correctly (${detail}).`;
  return detail;
}

export function gamePackageAgentInstructions(): string {
  return `# Level Up game package\n\nYou are editing one isolated candidate game. Preserve all completed features and keep keyboard, touch, and directional swipe controls working at mobile widths.\n\nEditable: index.html, game.json, src/**, content/**, assets/**, tests/**. Do not edit AGENTS.md, package.json, scripts/**, dist/**, or files outside this directory. Do not use network commands, browser storage, remote scripts, credentials, or absolute paths.\n\nAllowed commands are exactly: ${ALLOWED_COMMANDS.join(", ")}. Run bun run build and bun test before handing off. The release is cumulative; never replace the game with a demo or status page.\n\nBefore each distinct work step, emit one brief player-facing line beginning exactly with LEVELUP_STATUS:. Describe the concrete goal or check in plain language without revealing private reasoning, prompts, commands, file paths, tool details, credentials, or implementation secrets. Do not put LEVELUP_STATUS inside the final JSON.\n\nFinish with a compact JSON handoff: {"status":"complete"|"no_change","notes":"...","evidence":["..."]}. no_change is valid only when a deterministic test or source reference proves the requested outcome already exists.`;
}

function bootstrapPackage(templateDir: string, target: string, input: BuildAdapterInput): void {
  copyContents(templateDir,target);
  mkdirSync(join(target,"src","systems"),{recursive:true});mkdirSync(join(target,"content"),{recursive:true});mkdirSync(join(target,"assets"),{recursive:true});mkdirSync(join(target,"tests"),{recursive:true});mkdirSync(join(target,"scripts"),{recursive:true});
  writeFileSync(join(target,"AGENTS.md"),gamePackageAgentInstructions());
  writeFileSync(join(target,"game.json"),json({schemaVersion:GAME_PACKAGE_VERSION,projectId:input.projectId,title:input.projectName,template:templateId(input.templatePreviewUrl),entry:"index.html",buildOutput:"dist",commands:{build:"bun run build",test:"bun test",check:"bun run check"}}));
  writeFileSync(join(target,"package.json"),json({name:`levelup-game-${input.projectId}`,private:true,type:"module",scripts:{build:"bun scripts/build.ts",test:"bun test tests",check:"bun run build && bun test"}}));
  writeFileSync(join(target,"src","main.ts"),`import { installInputMode } from "./input";\nimport { initialState } from "./state";\nimport { renderFeatureState } from "./renderer";\ninstallInputMode(); renderFeatureState(initialState);\n`);
  writeFileSync(join(target,"src","state.ts"),`export const initialState = { packageVersion: ${GAME_PACKAGE_VERSION}, features: [] as string[] };\n`);
  writeFileSync(join(target,"src","renderer.ts"),`export function renderFeatureState(state: {features:string[]}) { document.documentElement.dataset.levelupPackage="${GAME_PACKAGE_VERSION}"; document.documentElement.dataset.levelupFeatures=state.features.join(","); }\n`);
  writeFileSync(join(target,"src","input.ts"),`export function installInputMode(){let mode="keyboard";addEventListener("pointerdown",()=>{mode="touch";document.documentElement.dataset.inputMode=mode},{passive:true});addEventListener("keydown",()=>{mode="keyboard";document.documentElement.dataset.inputMode=mode});document.documentElement.dataset.inputMode=mode;}\n`);
  writeFileSync(join(target,"tests","package.test.ts"),`import {expect,test} from "bun:test";import game from "../game.json";test("package contract",()=>{expect(game.schemaVersion).toBe(${GAME_PACKAGE_VERSION});expect(game.commands.build).toBe("bun run build")});\n`);
  writeFileSync(join(target,"scripts","build.ts"),`import{cpSync,existsSync,mkdirSync,rmSync}from"node:fs";rmSync("dist",{recursive:true,force:true});mkdirSync("dist/assets",{recursive:true});await Bun.build({entrypoints:["src/main.ts"],outdir:"dist/assets",target:"browser",minify:true});cpSync("index.html","dist/index.html");for(const name of ["assets","content"]){if(existsSync(name))cpSync(name,"dist/"+name,{recursive:true});}\n`);
  const html=readFileSync(join(target,"index.html"),"utf8");
  if(!html.includes("assets/main.js"))writeFileSync(join(target,"index.html"),html.replace("</body>",'<script type="module" src="./assets/main.js"></script></body>'));
}

function featurePrompt(input: BuildAdapterInput, proposal: RankedProposal): string {
  return renderAgentPrompt("feature_build",{featureGoal:`${proposal.title}: ${proposal.playerChange}`,implementationScope:proposal.implementationScope,acceptanceCriteria:proposal.acceptanceCriteria,preservedBehaviors:["Existing gameplay and completed features remain intact","Keyboard, touch, and directional swipe input remain usable","Mobile layout remains playable"],permittedCommands:ALLOWED_COMMANDS,requiredEvidence:["feature-specific automated tests written before implementation","successful package build","successful package tests","feature-specific source proof"],reviewPolicy:"Work iteratively in this one session: inspect, write focused failing tests from the acceptance criteria first, implement, run the tests, and fix concrete failures until green. Stop after the compact handoff; a separate bounded review follows and humans make the final gameplay decision."});
}

function featureReviewPrompt(proposal: RankedProposal): string {
  return `Independently review the frozen Level Up primary candidate. Do not edit any file. The requested feature is ${proposal.title}: ${proposal.playerChange}. Scope: ${proposal.implementationScope}. Acceptance criteria: ${proposal.acceptanceCriteria.join("; ")}. Inspect the implementation and tests and run the documented tests. Return exactly one compact JSON verdict: {"status":"approved"|"changes_required","notes":"Concise review summary","evidence":["Concrete finding or approval evidence"]}. changes_required must contain at least one concrete finding. Do not propose speculative improvements.`;
}
function featureCorrectionPrompt(proposal:RankedProposal,findings:string[]):string{return `Perform exactly one corrective build for ${proposal.title}: ${proposal.playerChange}. Address only these independent review findings: ${findings.join(" | ")}. Preserve all other checked primary behavior, add or strengthen focused tests, run the documented checks, and finish with the compact AGENTS.md handoff. No further agent review will run after this correction.`;}

async function runPackageCheck(workspace:string):Promise<void>{const build=spawn("bun",["run","check"],{cwd:workspace,env:{PATH:process.env.PATH??"/usr/bin:/bin"},stdio:["ignore","pipe","pipe"]});const exit=await new Promise<number>((resolve,reject)=>{build.on("error",reject);build.on("exit",code=>resolve(code??1));});if(exit!==0)throw new Error("workspace_final_check_failed");}

export function featureOutputTokens(env:Record<string,string|undefined>=process.env):number { const raw=env.LEVELUP_BUILD_MAX_OUTPUT_TOKENS;const value=raw===undefined?DEFAULT_FEATURE_OUTPUT_TOKENS:Number(raw);if(!Number.isSafeInteger(value)||value<8_000||value>MAX_FEATURE_OUTPUT_TOKENS)throw new SummaryError("setup_config");return value; }

export function parseWorkspaceHandoff(output: string): WorkspaceHandoff|null {
  const trimmed=output.trim();
  const fenced=[...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(match=>match[1]?.trim()).filter((value):value is string=>Boolean(value));
  const candidates=[...fenced.reverse(),trimmed];
  const trailing=trimmed.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}\s*$/)?.[0];
  if(trailing)candidates.push(trailing.trim());
  for(const candidate of candidates){
    try{const value=JSON.parse(candidate) as Partial<WorkspaceHandoff>;if((value.status==="complete"||value.status==="no_change"||value.status==="approved"||value.status==="changes_required")&&typeof value.notes==="string"&&Array.isArray(value.evidence)&&value.evidence.every(x=>typeof x==="string"))return{status:value.status,notes:value.notes.slice(0,1000),evidence:value.evidence.slice(0,20).map(x=>x.slice(0,500))};}catch{}
  }
  return null;
}
export function parseBuildStatus(output: string): string|null {
  const matches=[...output.matchAll(/(?:^|\n)LEVELUP_STATUS:\s*([^\r\n]+)/g)];
  const candidate=matches.at(-1)?.[1]?.replace(/\s+/g," ").trim();
  const raw=candidate?.match(/^(.+?[.!?])(?=[A-Z\s]|$)/)?.[1]??candidate;
  if(!raw||raw.length<4)return null;
  const unsafe=/(?:https?:\/\/|\b(?:api[_ -]?key|authorization|bearer|cookie|credential|secret|token)\b|(?:^|\s)(?:\.{0,2}\/|[a-zA-Z]:\\)|\b(?:bun|npm|pnpm|yarn)\s+(?:run|test|exec)\b)/i;
  if(unsafe.test(raw))return null;
  return raw.slice(0,180).replace(/[,:;\s]+$/g,"")+(raw.length>180?"…":"");
}
function permittedToolCall(workspace:string,toolCall:{title?:string|null;rawInput?:unknown;locations?:Array<{path:string}>|null}):boolean { const raw=toolCall.rawInput&&typeof toolCall.rawInput==="object"&&!Array.isArray(toolCall.rawInput)?toolCall.rawInput as Record<string,unknown>:{};const command=typeof raw.command==="string"?raw.command.trim():null;if(command!==null)return (ALLOWED_COMMANDS as readonly string[]).includes(command);const paths=[...(toolCall.locations??[]).map(x=>x.path),...(["path","file_path"].flatMap(key=>typeof raw[key]==="string"?[raw[key] as string]:[]))];return paths.length>0&&paths.every(path=>inside(workspace,isAbsolute(path)?path:join(workspace,path))); }

export class GooseWorkspaceCodingAgent implements WorkspaceCodingAgent {
  constructor(private readonly config: AgentConfig, private readonly options: { inactivityBudgetMs?:number; totalBudgetMs?:number; localPreflightHost?:string }={}) {}
  async run(input: {workspace:string;prompt:string;signal:AbortSignal;onProgress:(p:WorkspaceAgentProgress)=>void;inactivityBudgetMs?:number;totalBudgetMs?:number;traceFields?:{projectId:string;roundNumber:number;proposalId:string;runId:string}}): Promise<{handoff:WorkspaceHandoff;progress:WorkspaceAgentProgress}> {
    const c={...invocationAgentConfig(this.config,"feature_build"),maxOutputTokens:featureOutputTokens()};
    const maxTurns=Math.min(FEATURE_BUILD_MAX_TURNS,Math.max(1,Number(process.env.LEVELUP_BUILD_MAX_TURNS)||FEATURE_BUILD_MAX_TURNS));const inactivityBudget=input.inactivityBudgetMs??this.options.inactivityBudgetMs??DEFAULT_INACTIVITY_BUDGET_MS,totalBudget=input.totalBudgetMs??this.options.totalBudgetMs??DEFAULT_TOTAL_BUDGET_MS;const started=Date.now();let child:ReturnType<typeof spawn>|undefined;const providerAbort=new AbortController();let providerAttempts=0,touchProgress=()=>{};
    const traceId=beginAgentTrace({stage:"feature_build",clientName:"level-up-feature-builder",model:c.model||null,maxTurns,prompt:input.prompt,maxOutputBytes:c.maxOutputTokens*4,fields:input.traceFields});
    let reasoningStalled=false;
    const gateway=summaryProviderGateway({...c,maxTurns,timeoutMs:inactivityBudget,totalTimeoutMs:totalBudget},AbortSignal.any([input.signal,providerAbort.signal]),this.options.localPreflightHost,turn=>{providerAttempts=Math.max(providerAttempts,turn.attempt);touchProgress();appendAgentTraceTurn(traceId,{attempt:turn.attempt,status:turn.status,ok:turn.ok,content:turn.content,contentChars:turn.contentChars,reasoningChars:turn.reasoningChars,toolCallCount:turn.toolCallCount,finishReason:turn.finishReason,inputTokens:turn.inputTokens,outputTokens:turn.outputTokens,errorCode:turn.errorCode});},{allowTools:true,maxProviderAttempts:maxTurns*4,maxConcurrentRequests:1,reasoningEffort:"low",onReasoningStall:()=>{reasoningStalled=true;providerAbort.abort();}});
    let progress:WorkspaceAgentProgress={providerAttempts:0,meaningfulTurns:0,emptyAttempts:0,phase:"inspecting",lastProgressAt:started,changedFiles:[],diagnostics:[],usage:{inputTokens:0,outputTokens:0,cost:null}};
    const root=dirname(input.workspace),configHome=join(root,".config"),dataHome=join(root,".data"),runtimeBin=dirname(process.execPath);const env:Record<string,string>={PATH:`${runtimeBin}:/usr/bin:/bin:/usr/local/bin`,HOME:root,GOOSE_PATH_ROOT:root,XDG_CONFIG_HOME:configHome,XDG_DATA_HOME:dataHome,GOOSE_PROVIDER:"openrouter",GOOSE_MODEL:c.model,OPENROUTER_API_KEY:c.key,OPENROUTER_HOST:gateway.origin,GOOSE_MAX_TOKENS:String(c.maxOutputTokens),GOOSE_MAX_TURNS:String(maxTurns),GOOSE_DISABLE_SESSION_NAMING:"true",GOOSE_MODE:"auto",GOOSE_AUTO_COMPACT_THRESHOLD:"0",CONTEXT_FILE_NAMES:'["AGENTS.md"]',RUST_LOG:"off"};
    try{
      if(!c.key)throw new SummaryError("setup_missing_key");if(!c.model)throw new SummaryError("setup_missing_model");if(!isAbsolute(c.binary))throw new SummaryError("setup_binary");await access(c.binary,constants.X_OK).catch(()=>{throw new SummaryError("setup_binary")});
      mkdirSync(configHome,{recursive:true});writeFileSync(join(configHome,"config.yaml"),"extensions: {}\nGOOSE_DISABLE_SESSION_NAMING: true\n",{mode:0o600});
      child=spawn(c.binary,["acp","--with-builtin","developer"],{cwd:input.workspace,env,stdio:["pipe","pipe","ignore"]});
      let message="",cost:number|null=null,toolEvents=0,lastStatus:string|null=null,statusTimer:ReturnType<typeof setTimeout>|undefined;
      const publishStatus=()=>{if(statusTimer)clearTimeout(statusTimer);statusTimer=undefined;const status=parseBuildStatus(message);if(status&&status!==lastStatus){lastStatus=status;progress.activityMessage=status;progress.lastProgressAt=Date.now();input.onProgress({...progress});}};
      const client:Client={requestPermission:async({options,toolCall})=>{const permitted=permittedToolCall(input.workspace,toolCall);appendAgentTraceTurn(traceId,{event:"tool_permission",title:toolCall.title??null,permitted},"acp");if(!permitted)return{outcome:{outcome:"cancelled"}};const option=options.find(o=>o.kind==="allow_once")??options.find(o=>o.kind==="allow_always");return option?{outcome:{outcome:"selected",optionId:option.optionId}}:{outcome:{outcome:"cancelled"}};},readTextFile:async()=>{throw new SummaryError("permission_denied")},writeTextFile:async()=>{throw new SummaryError("permission_denied")},createTerminal:async()=>{throw new SummaryError("permission_denied")},terminalOutput:async()=>{throw new SummaryError("permission_denied")},releaseTerminal:async()=>{throw new SummaryError("permission_denied")},waitForTerminalExit:async()=>{throw new SummaryError("permission_denied")},killTerminal:async()=>{throw new SummaryError("permission_denied")},extMethod:async()=>{throw new SummaryError("permission_denied")},sessionUpdate:async({update})=>{if(update.sessionUpdate==="agent_message_chunk"&&update.content.type==="text"){touchProgress();message+=update.content.text;if(statusTimer)clearTimeout(statusTimer);statusTimer=setTimeout(publishStatus,250);}if(update.sessionUpdate==="tool_call"){touchProgress();publishStatus();toolEvents++;appendAgentTraceTurn(traceId,{event:"tool_call",title:update.title??null,status:update.status??null},"acp");}if(update.sessionUpdate==="usage_update"&&update.cost?.currency==="USD")cost=(cost??0)+update.cost.amount;}};
      const connection=new ClientSideConnection(()=>client,ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>));const init=await connection.initialize({protocolVersion:PROTOCOL_VERSION,clientInfo:{name:"level-up-feature-builder",version:"1"},clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false}});if(init.agentInfo?.version!==GOOSE_VERSION)throw new SummaryError("setup_binary");const session=await connection.newSession({cwd:input.workspace,mcpServers:[],_meta:{enabledExtensions:[{type:"builtin",name:"developer",available_tools:["edit","shell","tree","write"]}]}});progress.sessionId=session.sessionId;input.onProgress(progress);
      const extensions=await connection.extMethod("_goose/unstable/session/extensions/list",{sessionId:session.sessionId}) as {extensions?:unknown};const extensionList=Array.isArray(extensions.extensions)?extensions.extensions:[];if(extensionList.length!==1||!extensionList[0]||typeof extensionList[0]!=="object"||(extensionList[0] as {type?:unknown}).type!=="builtin"||(extensionList[0] as {name?:unknown}).name!=="developer")throw new SummaryError("setup_isolation");
      const inventory=await connection.extMethod("_goose/unstable/tools/list",{sessionId:session.sessionId}) as {tools?:unknown};const tools=Array.isArray(inventory.tools)?inventory.tools:[];const allowedTools=new Set(["edit","shell","tree","write","platform__manage_schedule"]);if(!tools.length||tools.some(item=>!item||typeof item!=="object"||typeof (item as {name?:unknown}).name!=="string"||!allowedTools.has((item as {name:string}).name)))throw new SummaryError("setup_isolation");
      await connection.extMethod("_goose/unstable/tools/permissions/set",{toolPermissions:[{toolName:"platform__manage_schedule",permission:"never_allow"}]});
      markAgentTraceSession(traceId,session.sessionId);
      const previous=digest(input.workspace);message="";lastStatus=null;const beforeTools=toolEvents;
      if(input.signal.aborted)throw new SummaryError("interrupted");
      let inactivityTimer:ReturnType<typeof setTimeout>|undefined,totalTimer:ReturnType<typeof setTimeout>|undefined;const stopped=new Promise<never>((_,reject)=>{touchProgress=()=>{if(inactivityTimer)clearTimeout(inactivityTimer);inactivityTimer=setTimeout(()=>reject(new SummaryError("timeout","feature_build_inactivity_budget")),inactivityBudget);};touchProgress();totalTimer=setTimeout(()=>reject(new SummaryError("timeout","feature_build_final_cap")),totalBudget);});let result;try{result=await Promise.race([connection.prompt({sessionId:session.sessionId,prompt:[{type:"text",text:input.prompt}]}),stopped]);}finally{touchProgress=()=>{};if(inactivityTimer)clearTimeout(inactivityTimer);if(totalTimer)clearTimeout(totalTimer);}await gateway.waitForTurns();
      publishStatus();progress.providerAttempts=providerAttempts;progress.usage.inputTokens=result.usage?.inputTokens??0;progress.usage.outputTokens=result.usage?.outputTokens??0;progress.usage.cost=cost;const changed=digest(input.workspace)!==previous;const handoff=parseWorkspaceHandoff(message);const meaningful=toolEvents>beforeTools||Boolean(message.trim())||changed||Boolean(handoff);progress.changedFiles=files(input.workspace);if(meaningful){progress.meaningfulTurns=1;progress.lastProgressAt=Date.now();}else progress.emptyAttempts=1;progress.phase=handoff?"testing":changed?"editing":"repairing";input.onProgress(progress);
      if(!handoff)throw new SummaryError("invalid_output","feature_build_handoff_missing");
      completeAgentTrace(traceId,{outputBytes:Buffer.byteLength(message),inputTokens:progress.usage.inputTokens,outputTokens:progress.usage.outputTokens,cost:progress.usage.cost,outputPreview:handoff,rawOutput:message});return{handoff,progress};
    }catch(error){const classified=reasoningStalled?new SummaryError("retry_limit","feature_build_reasoning_stall"):error instanceof SummaryError?error:new SummaryError("provider_error",failureMessage(error));failAgentTrace(traceId,classified.code,classified.correction);throw classified;}finally{await gateway.waitForTurns();providerAbort.abort();gateway.stop();child?.kill("SIGKILL");}
  }
}

export class WorkspaceBuildAdapter implements BuildAdapter {
  readonly simulated=false;private readonly templateRoot:string;private readonly workspaceRoot:string;private readonly snapshotRoot:string;private readonly releaseRoot:string;
  constructor(private readonly options:WorkspaceBuildOptions){this.templateRoot=resolve(options.templateRoot??"public/templates");this.workspaceRoot=resolve(options.workspaceRoot??process.env.LEVELUP_WORKSPACES_PATH?.trim()??"runtime-data/workspaces");this.snapshotRoot=resolve(options.snapshotRoot??process.env.LEVELUP_SNAPSHOTS_PATH?.trim()??"runtime-data/source-snapshots");this.releaseRoot=resolve(options.releaseRoot??process.env.LEVELUP_RELEASES_PATH?.trim()??"runtime-data/releases");}
  async validate(input:BuildAdapterInput):Promise<BuildAdapterResult>{
    const project=safeSegment(input.projectId,"project_id"),proposal=input.activeProposal??input.brief.committed,runId=input.featureExecution?.runId??randomUUID();
    const workspace=ensureInside(this.workspaceRoot,input.featureExecution?join(this.workspaceRoot,input.featureExecution.workspaceRef):join(this.workspaceRoot,project,runId));
    const baseVersion=versionFromUrl(input.previousStableUrl),snapshot=baseVersion?join(this.snapshotRoot,project,`v${baseVersion}`):null;mkdirSync(workspace,{recursive:true});
    if(snapshot&&existsSync(snapshot))copyContents(snapshot,workspace);else bootstrapPackage(join(this.templateRoot,templateId(input.templatePreviewUrl)),workspace,input);
    const baseDigest=digest(workspace);let lastProgress:WorkspaceAgentProgress|null=null;activityLog("build.workspace.started",{projectId:project,roundNumber:input.roundNumber,proposalId:proposal.id,runId,baseVersion});
    try{
      const signal=input.featureExecution?.signal??new AbortController().signal;
      const report=(p:WorkspaceAgentProgress)=>{lastProgress=p;input.featureExecution?.onProgress(p);activityLog("build.workspace.progress",{projectId:project,proposalId:proposal.id,runId,phase:p.phase,meaningfulTurns:p.meaningfulTurns,providerAttempts:p.providerAttempts,emptyAttempts:p.emptyAttempts});};
      const primary=await this.options.agent.run({workspace,prompt:featurePrompt(input,proposal),signal,inactivityBudgetMs:DEFAULT_INACTIVITY_BUDGET_MS,totalBudgetMs:IMPLEMENTATION_TOTAL_BUDGET_MS,traceFields:{projectId:project,roundNumber:input.roundNumber,proposalId:proposal.id,runId},onProgress:report});
      if(primary.handoff.status!=="complete"&&primary.handoff.status!=="no_change")throw new Error("implementation_handoff_invalid");
      await runPackageCheck(workspace);
      const primaryCandidate=ensureInside(this.workspaceRoot,`${workspace}-primary`);cpSync(workspace,primaryCandidate,{recursive:true});
      let selected=primaryCandidate,selectedCandidate:"primary"|"corrected"="primary",review:"approved"|"changes_required"|"failed"="failed",correction:"not_required"|"checked"|"failed"="not_required";
      let reviewFindings:string[]=[],reviewFailure:string|null=null,correctionFailure:string|null=null;
      let reviewRun:Awaited<ReturnType<WorkspaceCodingAgent["run"]>>|null=null,correctionRun:Awaited<ReturnType<WorkspaceCodingAgent["run"]>>|null=null;
      const reviewWorkspace=ensureInside(this.workspaceRoot,`${workspace}-review`);cpSync(primaryCandidate,reviewWorkspace,{recursive:true});
      try{reviewRun=await this.options.agent.run({workspace:reviewWorkspace,prompt:featureReviewPrompt(proposal),signal,inactivityBudgetMs:DEFAULT_INACTIVITY_BUDGET_MS,totalBudgetMs:REVIEW_TOTAL_BUDGET_MS,traceFields:{projectId:project,roundNumber:input.roundNumber,proposalId:proposal.id,runId},onProgress:p=>report({...p,phase:"testing"})});if(reviewRun.handoff.status!=="approved"&&reviewRun.handoff.status!=="changes_required")throw new Error("review_verdict_invalid");review=reviewRun.handoff.status;reviewFindings=reviewRun.handoff.evidence;if(review==="changes_required"&&!reviewFindings.length)throw new Error("review_findings_missing");}catch(error){review="failed";reviewFailure=failureMessage(error);activityLog("build.workspace.review_failed",{projectId:project,proposalId:proposal.id,runId,error:reviewFailure});}
      if(review==="changes_required"){
        const correctionWorkspace=ensureInside(this.workspaceRoot,`${workspace}-correction`);cpSync(primaryCandidate,correctionWorkspace,{recursive:true});
        try{correctionRun=await this.options.agent.run({workspace:correctionWorkspace,prompt:featureCorrectionPrompt(proposal,reviewFindings),signal,inactivityBudgetMs:DEFAULT_INACTIVITY_BUDGET_MS,totalBudgetMs:IMPLEMENTATION_TOTAL_BUDGET_MS,traceFields:{projectId:project,roundNumber:input.roundNumber,proposalId:proposal.id,runId},onProgress:p=>report({...p,phase:"repairing"})});if(correctionRun.handoff.status!=="complete"&&correctionRun.handoff.status!=="no_change")throw new Error("correction_handoff_invalid");await runPackageCheck(correctionWorkspace);selected=correctionWorkspace;selectedCandidate="corrected";correction="checked";}catch(error){correction="failed";correctionFailure=failureMessage(error);activityLog("build.workspace.correction_failed",{projectId:project,proposalId:proposal.id,runId,error:correctionFailure});}
      }
      const delivery:FeatureDeliveryOutcome={implementation:"checked",review,correction,selectedCandidate,reviewFindings,reviewFailure,correctionFailure};
      const selectedDigest=digest(selected),finalStatus=selectedDigest===baseDigest&&primary.handoff.status==="no_change"?"no_change":"complete";if(selectedDigest===baseDigest&&finalStatus!=="no_change")throw new Error("feature_source_unchanged");
      const handoff:WorkspaceHandoff={status:finalStatus,notes:[primary.handoff.notes,reviewRun?.handoff.notes,correctionRun?.handoff.notes].filter(Boolean).join(" ").slice(0,1000),evidence:[...primary.handoff.evidence,...(reviewRun?.handoff.evidence??[]),...(correctionRun?.handoff.evidence??[])].slice(0,20)};
      const parts=[primary.progress,reviewRun?.progress,correctionRun?.progress].filter((p):p is WorkspaceAgentProgress=>Boolean(p));const progress:WorkspaceAgentProgress={...parts.at(-1)!,providerAttempts:parts.reduce((n,p)=>n+p.providerAttempts,0),meaningfulTurns:parts.reduce((n,p)=>n+p.meaningfulTurns,0),emptyAttempts:parts.reduce((n,p)=>n+p.emptyAttempts,0),usage:{inputTokens:parts.reduce((n,p)=>n+p.usage.inputTokens,0),outputTokens:parts.reduce((n,p)=>n+p.usage.outputTokens,0),cost:parts.every(p=>p.usage.cost===null)?null:parts.reduce((n,p)=>n+(p.usage.cost??0),0)}};
      if(!existsSync(join(selected,"dist","index.html")))throw new Error("workspace_build_missing");if(handoff.status==="no_change"&&!handoff.evidence.length)throw new Error("no_change_not_proven");if(signal.aborted)throw new SummaryError("interrupted");
      const verification={packageCheckPassed:true,humanReviewRequired:true,review:delivery};const existingVersions=existsSync(join(this.releaseRoot,project))?readdirSync(join(this.releaseRoot,project)).map(x=>/^v(\d+)$/.exec(x)?.[1]).filter(Boolean).map(Number):[];const next=Math.max(2,(existingVersions.length?Math.max(...existingVersions):1)+1),version=`v${next}`,sourceTarget=ensureInside(this.snapshotRoot,join(this.snapshotRoot,project,version)),releaseTarget=ensureInside(this.releaseRoot,join(this.releaseRoot,project,version));if(existsSync(sourceTarget)||existsSync(releaseTarget))throw new Error("immutable_version_exists");
      mkdirSync(dirname(sourceTarget),{recursive:true});cpSync(selected,sourceTarget,{recursive:true,filter:path=>!path.includes(`${join(selected,"dist")}`)&&!path.includes("node_modules")&&!path.includes(".config")&&!path.includes(".data")});if(signal.aborted)throw new SummaryError("interrupted");cpSync(join(selected,"dist"),releaseTarget,{recursive:true});writeFileSync(join(sourceTarget,"checkpoint.json"),json({schemaVersion:2,projectId:project,version,proposalId:proposal.id,baseVersion:baseVersion?`v${baseVersion}`:null,sourceChecksum:checksum(sourceTarget),handoff,validation:verification,progress,createdAt:new Date().toISOString()}));writeFileSync(join(releaseTarget,"manifest.json"),json({schemaVersion:4,projectId:project,version,proposalId:proposal.id,baseVersion:baseVersion?`v${baseVersion}`:null,sourceSnapshot:sourceTarget,sourceChecksum:checksum(sourceTarget),releaseChecksum:checksum(releaseTarget),validation:verification,handoff,createdAt:new Date().toISOString()}));
      const releaseUrl=`/projects/${project}/versions/${version}/`;activityLog("build.workspace.published",{projectId:project,proposalId:proposal.id,version,releaseUrl,meaningfulTurns:progress.meaningfulTurns,reviewOutcome:review,correctionOutcome:correction,selectedCandidate});return{validated:true,includedProposalIds:[proposal.id],deferredProposalIds:[],releaseUrl,failure:null,featureResults:[{proposalId:proposal.id,status:handoff.status==="no_change"?"no_change":"succeeded",releaseUrl,failure:null,delivery}]};
    }catch(error){const failedProgress=lastProgress as WorkspaceAgentProgress|null;const failure=playerSafeWorkspaceFailure(error);activityLog("build.workspace.failed",{projectId:project,proposalId:proposal.id,runId,error:failure,meaningfulTurns:failedProgress?.meaningfulTurns??0});return{validated:false,includedProposalIds:[],deferredProposalIds:[],releaseUrl:null,failure,featureResults:[{proposalId:proposal.id,status:"failed",releaseUrl:null,failure}]};}
  }
}
