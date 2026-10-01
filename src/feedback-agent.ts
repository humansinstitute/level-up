import { summaryProviderGateway } from "./summary-provider-gateway";
import { agentPromptRecords, renderAgentPrompt, type AgentPromptStageId } from "./admin-prompts";
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION, type Client } from '@agentclientprotocol/sdk';
import { MAX_SUMMARY_BYTES, SummaryError, validateSummary } from './feedback-summary';
import type { SummaryAttempt, SummaryCompletion, SummaryInput, SummaryStore } from './summary-store';
import { activityLog, type ActivityLogFields } from './activity-log';
import { adminSettings } from './admin-settings';
import { appendAgentTraceTurn, appendAgentTraceTurnIfEmpty, beginAgentTrace, completeAgentTrace, failAgentTrace, markAgentTraceSession } from './agent-trace';

export const GOOSE_VERSION = '1.43.0';
export interface AgentConfig { key: string; model: string; binary: string; timeoutMs: number; totalTimeoutMs: number; maxOutputTokens: number; maxInputBytes: number; concurrency: number; maxTurns: number; modelResolution: "admin" | "environment" }
export interface AgentConfigOptions {
  env?: Record<string, string | undefined>;
  modelResolution?: "admin" | "environment";
}
export function agentConfig(options: AgentConfigOptions = {}): AgentConfig {
  const env = options.env ?? process.env;
  const n = (key: string, fallback: number, max: number) => { const v = env[key] === undefined ? fallback : Number(env[key]); if (!Number.isSafeInteger(v) || v < 1 || v > max) throw new SummaryError('setup_config'); return v; };
  const timeoutMs=n('LEVELUP_AGENT_TIMEOUT_SECONDS',120,600)*1000;
  const totalTimeoutMs=n('LEVELUP_AGENT_TOTAL_TIMEOUT_SECONDS',Math.min(3600,Math.max(120,Math.ceil(timeoutMs/1000)*3)),3600)*1000;
  if(totalTimeoutMs<timeoutMs)throw new SummaryError('setup_config');
  return { key: env.OPENROUTER_API_KEY?.trim() || '', model: env.LEVELUP_AGENT_MODEL?.trim() || '', binary: env.LEVELUP_GOOSE_BIN?.trim() || join(homedir(), '.local', 'bin', 'goose'), timeoutMs, totalTimeoutMs, maxOutputTokens: n('LEVELUP_AGENT_MAX_OUTPUT_TOKENS',2000,8000), maxInputBytes: n('LEVELUP_AGENT_MAX_INPUT_BYTES',65536,262144), concurrency: n('LEVELUP_AGENT_CONCURRENCY',1,4), maxTurns: n('LEVELUP_AGENT_MAX_TURNS',3,5), modelResolution: options.modelResolution ?? (options.env ? "environment" : "admin") };
}
export function invocationAgentConfig(config: AgentConfig, stage: string): AgentConfig {
  if (config.modelResolution !== "admin") return { ...config };
  try {
    const settings = adminSettings();
    const promptRecord = agentPromptRecords().find((item) => item.id === stage as AgentPromptStageId);
    return { ...config, model: (promptRecord?.model ?? settings.defaultModel) || config.model };
  } catch { return { ...config }; }
}
export interface FeedbackAgent { run(attempt: SummaryAttempt, signal: AbortSignal, onSession: (id: string) => void): Promise<SummaryCompletion> }
export function summaryPrompt(input: SummaryInput): string {
  return renderAgentPrompt("feedback_summary", input);
}
export function deniedClient(onText: (text: string) => void, onDenied: () => void, onCost: (cost: number) => void = () => undefined): Client {
  const deny = async (): Promise<never> => { onDenied(); throw new SummaryError('permission_denied'); };
  return {
    requestPermission: async () => { onDenied(); return { outcome: { outcome: 'cancelled' } }; },
    readTextFile: deny, writeTextFile: deny, createTerminal: deny, terminalOutput: deny, releaseTerminal: deny, waitForTerminalExit: deny, killTerminal: deny,
    extMethod: deny,
    sessionUpdate: async ({ update }) => {
      if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') onText(update.content.text);
      if (update.sessionUpdate === 'tool_call') onDenied();
      if (update.sessionUpdate === 'usage_update' && update.cost?.currency === 'USD' && Number.isFinite(update.cost.amount) && update.cost.amount >= 0) onCost(update.cost.amount);
    },
  };
}

function parseJsonOutput(output: string): unknown {
  const trimmed = output.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    try { return JSON.parse(fenced[1]); } catch { throw new SummaryError('invalid_output', 'response: return one valid JSON object; the fenced JSON could not be parsed'); }
  }
  try { return JSON.parse(trimmed); } catch {
    const start = trimmed.search(/[\[{]/);
    if (start < 0) throw new SummaryError('invalid_output', 'response: return one JSON object matching the requested schema');
    const opener = trimmed[start]!;
    const closer = opener === "{" ? "}" : "]";
    let depth = 0, inString = false, escaped = false;
    for (let index = start; index < trimmed.length; index += 1) {
      const char = trimmed[index]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === "\"") inString = false;
        continue;
      }
      if (char === "\"") inString = true;
      else if (char === opener) depth += 1;
      else if (char === closer) {
        depth -= 1;
        if (depth === 0) {
          try { return JSON.parse(trimmed.slice(start, index + 1)); } catch { throw new SummaryError('invalid_output', 'response: correct the malformed JSON and return the complete object'); }
        }
      }
    }
    throw new SummaryError('invalid_output', 'response: close every JSON object or array and return the complete payload');
  }
}

function repairPrompt(error: SummaryError, attempt: number, maxTurns: number): string {
  const correction = error.correction ?? (error.code === "output_too_large"
    ? "response: shorten the payload to the requested limits without dropping required fields"
    : "response: return one corrected JSON payload matching the requested schema");
  return `Level Up rejected attempt ${attempt}. Correct it in this same session. ${correction}. Return only the complete corrected JSON payload. Do not explain the error or repeat invalid values. You have ${maxTurns - attempt} corrective turn(s) remaining.`;
}

function truncatedJsonCandidate(output:string):string|null {
  const trimmed=output.trim();const fenced=trimmed.match(/```(?:json)?\s*([\s\S]*)/i);const candidate=(fenced?.[1]??trimmed.slice(Math.max(0,trimmed.search(/[\[{]/)))).trim();
  if(!candidate||!/[\[{]/.test(candidate[0]!))return null;
  let stack:string[]=[],inString=false,escaped=false;
  for(const char of candidate){if(inString){if(escaped)escaped=false;else if(char==="\\")escaped=true;else if(char==='"')inString=false;continue;}if(char==='"')inString=true;else if(char==='{'||char==='[')stack.push(char);else if(char==='}'||char===']'){const expected=char==='}'?'{':'[';if(stack.pop()!==expected)return null;}}
  return stack.length||inString?candidate:null;
}

function continuationPrompt(attempt:number,maxTurns:number):string{return `Level Up retained the valid prefix from attempt ${attempt}, but the outer JSON was truncated. Continue in this same session from the exact next character and return only the missing JSON suffix. Do not repeat or regenerate the retained prefix. You have ${maxTurns-attempt} corrective turn(s) remaining.`;}

/** Pinned Goose only; extensions absent, platform tools denied, provider tool choice disabled. */
export async function runGooseJson<T>(
  config: AgentConfig,
  prompt: string,
  signal: AbortSignal,
  onSession: (id: string) => void,
  validate: (value: unknown) => T,
  options: { localPreflightHost?: string; maxOutputBytes?: number; clientName?: string; stage?: string; fields?: ActivityLogFields } = {},
): Promise<{ output: T; sessionId: string; usage: SummaryCompletion["usage"] }> {
  const stage = options.stage ?? options.clientName ?? "agent";
  const c = invocationAgentConfig(config, stage);
  const limit = options.maxOutputBytes ?? MAX_SUMMARY_BYTES;
  const clientName = options.clientName ?? "level-up-agent";
  let maxTurns = c.maxTurns;
  try { maxTurns = adminSettings().agentMaxTurns; } catch { /* fall back to boot config */ }
  const baseFields = { stage, clientName, model: c.model || null, maxTurns, inactivityTimeoutMs:c.timeoutMs, totalTimeoutMs:c.totalTimeoutMs, ...options.fields };
  const startedAt = performance.now();
  const promptBytes = Buffer.byteLength(prompt);
  const traceId = beginAgentTrace({ stage, clientName, model: c.model || null, maxTurns, prompt, maxOutputBytes: limit, fields: options.fields });
  activityLog("agent.run.start", { ...baseFields, promptBytes, maxOutputBytes: limit });
  try {
    if (!c.key) throw new SummaryError('setup_missing_key');
    if (!c.model) throw new SummaryError('setup_missing_model');
    if (!isAbsolute(c.binary)) throw new SummaryError('setup_binary');
    try { await access(c.binary, constants.X_OK); } catch { throw new SummaryError('setup_binary'); }
    if (promptBytes > c.maxInputBytes) throw new SummaryError('input_too_large');
    if (signal.aborted) throw new SummaryError('interrupted');
  } catch (e) {
    const error = e instanceof SummaryError ? e : new SummaryError('setup_config');
    failAgentTrace(traceId, error.code);
    throw error;
  }
  const root = await mkdtemp(join(tmpdir(), 'levelup-acp-'));
  let child: ReturnType<typeof spawn> | undefined;
  const providerAbort=new AbortController();
  const gateway=summaryProviderGateway({ ...c, maxTurns },AbortSignal.any([signal,providerAbort.signal]),options.localPreflightHost, turn => appendAgentTraceTurn(traceId, turn));
  let halted=false;
  let inactivityTimeout: ReturnType<typeof setTimeout> | undefined;
  let totalTimeout: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: ((e: Error) => void) | undefined;
  let observedAcpOutput = "", sawAcpOutput = false;
  const abort = () => { halted=true;child?.kill('SIGKILL'); rejectAbort?.(new SummaryError('interrupted')); };
  const environment: Record<string, string> = {
    PATH: '/usr/bin:/bin', GOOSE_PATH_ROOT: root, XDG_CONFIG_HOME: join(root,'config'), XDG_DATA_HOME: join(root,'data'),
    GOOSE_PROVIDER: 'openrouter', GOOSE_MODEL: c.model, OPENROUTER_API_KEY: c.key,
    GOOSE_MAX_TOKENS: String(c.maxOutputTokens), GOOSE_MAX_TURNS: String(maxTurns), GOOSE_DISABLE_SESSION_NAMING: 'true',
    GOOSE_MODE: 'chat', OPENROUTER_PARAMETERS: JSON.stringify({tools:[],tool_choice:'none'}), GOOSE_AUTO_COMPACT_THRESHOLD: '0', CONTEXT_FILE_NAMES: '[]', RUST_LOG: 'off',
    OPENROUTER_HOST:gateway.origin,
  };
  try {
    await mkdir(join(root,'config')); await mkdir(join(root,'work'));
    await writeFile(join(root,'config','config.yaml'), 'extensions: {}\nGOOSE_DISABLE_SESSION_NAMING: true\n', {mode:0o600});
    const operation = async (): Promise<{ output: T; sessionId: string; usage: SummaryCompletion["usage"] }> => {
      if(halted||signal.aborted)throw new SummaryError('interrupted');
      let version: string;
      const { OPENROUTER_API_KEY: _credential, ...versionEnvironment } = environment;
      try { child = spawn(c.binary, ['--version'], { cwd: join(root,'work'), env: versionEnvironment, stdio: ['ignore','pipe','ignore'] });
      child.on('error', () => rejectAbort?.(new SummaryError('setup_binary')));
      version = await new Response(Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>).text();
      } catch { throw new SummaryError('setup_binary'); }
      if (version.trim() !== GOOSE_VERSION) throw new SummaryError('setup_binary');
      if(halted||signal.aborted)throw new SummaryError('interrupted');
      child = spawn(c.binary, ['acp'], { cwd: join(root,'work'), env: environment, stdio: ['pipe','pipe','ignore'] });
      child.on('error', () => rejectAbort?.(new SummaryError('setup_binary')));
      let output = '', denied = false; let reportedCost: number | null = null;
      const refreshInactivity=()=>{if(inactivityTimeout)clearTimeout(inactivityTimeout);inactivityTimeout=setTimeout(()=>{halted=true;child?.kill('SIGKILL');rejectAbort?.(new SummaryError('timeout','inactivity budget exhausted'));},c.timeoutMs);};
      const client = deniedClient(chunk => {
        refreshInactivity();
        output += chunk;
        observedAcpOutput += chunk; sawAcpOutput = true;
        if (Buffer.byteLength(output) > limit) { child?.kill('SIGKILL'); rejectAbort?.(new SummaryError('output_too_large')); }
      }, () => { denied = true; child?.kill('SIGKILL'); rejectAbort?.(new SummaryError('permission_denied')); }, cost=>{reportedCost=cost;});
      const connection = new ClientSideConnection(() => client, ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>));
      const init = await connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientInfo: { name:options.clientName ?? 'level-up-agent',version:'1' }, clientCapabilities: { fs: { readTextFile:false,writeTextFile:false }, terminal:false } });
      if (init.protocolVersion !== PROTOCOL_VERSION || init.agentInfo?.version !== GOOSE_VERSION) throw new SummaryError('setup_isolation');
      const session = await connection.newSession({ cwd:join(root,'work'),mcpServers:[],_meta:{enabledExtensions:[]} });
      if(session.modes?.currentModeId !== "chat") throw new SummaryError("setup_isolation");
      onSession(session.sessionId);
      markAgentTraceSession(traceId, session.sessionId);
      activityLog("agent.run.session", { ...baseFields, gooseSessionId: session.sessionId });
      const extensions = await connection.extMethod('_goose/unstable/session/extensions/list',{sessionId:session.sessionId});
      const inventory = await connection.extMethod('_goose/unstable/tools/list',{sessionId:session.sessionId});
      if (!Array.isArray(extensions.extensions) || extensions.extensions.length || !Array.isArray(inventory.tools)) throw new SummaryError('setup_isolation');
      if (inventory.tools.some(t => !t || typeof t !== 'object' || (t as {name?:unknown}).name !== 'platform__manage_schedule')) throw new SummaryError('setup_isolation');
      await connection.extMethod('_goose/unstable/tools/permissions/set',{toolPermissions:inventory.tools.map(()=>({toolName:'platform__manage_schedule',permission:'never_allow'}))});
      const locked = await connection.extMethod('_goose/unstable/tools/list',{sessionId:session.sessionId});
      if (!Array.isArray(locked.tools) || locked.tools.some(t=>!t || typeof t !== 'object' || (t as {permission?:unknown}).permission !== 'never_allow')) throw new SummaryError('setup_isolation');
      if(halted||signal.aborted)throw new SummaryError('interrupted');
      let validated: T | undefined;
      let finalOutput = "";
      let aggregateInputTokens = 0, aggregateOutputTokens = 0, sawUsage = false;
      let nextPrompt = prompt;
      let retainedPrefix: string | null = null;
      for (let attempt = 1; attempt <= maxTurns; attempt += 1) {
        output = "";
        refreshInactivity();
        const result = await connection.prompt({ sessionId:session.sessionId,prompt:[{type:'text',text:nextPrompt}] });
        finalOutput = output;
        if (result.usage) { sawUsage = true; aggregateInputTokens += result.usage.inputTokens; aggregateOutputTokens += result.usage.outputTokens; }
        if (denied) throw new SummaryError('permission_denied');
        try {
          if (result.stopReason !== 'end_turn') throw new SummaryError('invalid_output', `response: finish the JSON response; stop reason was ${result.stopReason}`);
          if (output.includes(c.key)) throw new SummaryError('invalid_output', 'response: remove credentials or secret values from the payload');
          let parsed:unknown;
          if(retainedPrefix){try{parsed=parseJsonOutput(retainedPrefix+output);retainedPrefix=null;}catch{parsed=parseJsonOutput(output);retainedPrefix=null;}}
          else parsed=parseJsonOutput(output);
          validated = validate(parsed);
          break;
        } catch (error) {
          const invalid = error instanceof SummaryError ? error : new SummaryError('invalid_output', 'response: return a payload matching the requested schema');
          if ((invalid.code !== 'invalid_output' && invalid.code !== 'output_too_large') || attempt >= maxTurns) throw invalid;
          const truncated=invalid.code==='invalid_output'?truncatedJsonCandidate(output):null;
          retainedPrefix=truncated;
          const correction=truncated?"continue only the missing JSON suffix from the retained prefix":invalid.correction;
          activityLog("agent.run.repair", { ...baseFields, gooseSessionId: session.sessionId, attempt, error: invalid.code, correction, repairMode:truncated?"suffix_continuation":"full_correction" });
          nextPrompt = truncated?continuationPrompt(attempt,maxTurns):repairPrompt(invalid, attempt, maxTurns);
        }
      }
      if (validated === undefined) throw new SummaryError('retry_limit', 'response: no valid payload was produced within the configured turn limit');
      await gateway.waitForTurns();
      const usage = sawUsage ? {inputTokens:aggregateInputTokens,outputTokens:aggregateOutputTokens,cost:reportedCost} : reportedCost===null?null:{inputTokens:null,outputTokens:null,cost:reportedCost};
      completeAgentTrace(traceId, { outputBytes: Buffer.byteLength(finalOutput), inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null, cost: usage?.cost ?? null, outputPreview: validated, rawOutput: finalOutput });
      activityLog("agent.run.complete", { ...baseFields, gooseSessionId: session.sessionId, outputBytes: Buffer.byteLength(finalOutput), inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null, cost: usage?.cost ?? null, durationMs: Math.round(performance.now() - startedAt) });
      return { output:validated,sessionId:session.sessionId,usage };
    };
    const stopped = new Promise<never>((_, reject) => {
      rejectAbort = reject;
      inactivityTimeout = setTimeout(() => { halted=true;child?.kill('SIGKILL'); reject(new SummaryError('timeout','inactivity budget exhausted')); },c.timeoutMs);
      totalTimeout = setTimeout(() => { halted=true;child?.kill('SIGKILL'); reject(new SummaryError('timeout','total run budget exhausted')); },c.totalTimeoutMs);
      signal.addEventListener('abort',abort,{once:true});
      if(signal.aborted)abort();
    });
    return await Promise.race([operation(),stopped]);
  } catch (e) { await gateway.waitForTurns(); if (sawAcpOutput) appendAgentTraceTurnIfEmpty(traceId, observedAcpOutput); const error = e instanceof SummaryError ? e : new SummaryError('provider_error'); failAgentTrace(traceId, error.code, error.correction); activityLog("agent.run.failed", { ...baseFields, error: error.code, correction: error.correction, durationMs: Math.round(performance.now() - startedAt) }); throw error; }
  finally { providerAbort.abort();gateway.stop();if(inactivityTimeout)clearTimeout(inactivityTimeout);if(totalTimeout)clearTimeout(totalTimeout); signal.removeEventListener('abort',abort); child?.kill('SIGKILL'); await rm(root,{recursive:true,force:true}); }
}

export class GooseFeedbackAgent implements FeedbackAgent {
  constructor(readonly config: AgentConfig, private readonly localPreflightHost?: string) {
    if (localPreflightHost && !/^http:\/\/127\.0\.0\.1:\d+$/.test(localPreflightHost)) throw new SummaryError('setup_config');
  }
  async run(attempt: SummaryAttempt, signal: AbortSignal, onSession: (id: string) => void): Promise<SummaryCompletion> {
    return runGooseJson(this.config, summaryPrompt(attempt.input), signal, onSession, value => validateSummary(value,new Set(attempt.input.feedback.map(f=>f.id))), { localPreflightHost:this.localPreflightHost, clientName:'level-up-feedback', stage:'feedback_summary', fields:{ projectId: attempt.input.project.id, roundNumber: attempt.input.sourceRound.number } });
  }
}

/** Polling is deliberate: committed queued work survives a crash before notification. */
export class FeedbackWorker {
  private active = new Map<string, AbortController>();
  private timer: ReturnType<typeof setInterval> | null = null;
  readonly owner = crypto.randomUUID();
  constructor(private store: SummaryStore, private agent: FeedbackAgent, private config: Pick<AgentConfig,'model'|'timeoutMs'|'concurrency'>, private changed: () => void = () => undefined) {}
  private notify(): void { try { this.changed(); } catch { /* Durable snapshots/replay recover a failed notification. */ } }
  start(): void { if (this.timer) return; this.timer = setInterval(()=>this.scan(),250); this.scan(); }
  scan(): void {
    this.store.recoverExpired();
    for(const [token, controller] of this.active) if(!this.store.active(token)) controller.abort();
    while(this.active.size < this.config.concurrency) {
      const attempt = this.store.claim(this.owner,this.config.timeoutMs+5000,this.config.model); if(!attempt)break;
      const controller = new AbortController(); this.active.set(attempt.token,controller); this.notify();
      void this.agent.run(attempt,controller.signal,id=>this.store.recordSession(attempt.token,id))
        .then(result=>this.store.complete(attempt.token,result))
        .catch(e=>this.store.failToken(attempt.token,e instanceof SummaryError?e.code:'provider_error'))
        .finally(()=>{this.active.delete(attempt.token);this.notify();});
    }
    this.notify();
  }
  stop(): void { if(this.timer)clearInterval(this.timer);this.timer=null;for(const [token,c] of this.active){c.abort();this.store.failToken(token,'interrupted');} }
}
