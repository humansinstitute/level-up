import type { ActivityLogFields } from "./activity-log";

export type AgentRunStatus = "running" | "succeeded" | "failed";
export interface BoundedTraceValue { value: unknown; bytes: number; truncated: boolean }
export interface AgentModelTurn extends BoundedTraceValue { number: number; observedAt: number; source: "provider" | "acp" }

export interface AgentRunTrace {
  id: string; stage: string; clientName: string; model: string | null; maxTurns: number; status: AgentRunStatus;
  startedAt: number; completedAt: number | null; durationMs: number | null; promptBytes: number; maxOutputBytes: number;
  outputBytes: number | null; inputTokens: number | null; outputTokens: number | null; cost: number | null;
  gooseSessionId: string | null; errorCode: string | null; errorDetail: string | null; outputPreview: unknown;
  compiledInput: BoundedTraceValue | null; turns: AgentModelTurn[]; finalPayload: BoundedTraceValue | null;
  transcriptTruncated: boolean; fields: Record<string, string | number | boolean | null>;
}

export const MAX_TRACE_ITEM_BYTES = 48_000;
export const MAX_TRACE_TOTAL_BYTES = 160_000;
export interface AgentTraceStore {
  getAgentTrace(id: string): AgentRunTrace | null;
  saveAgentTrace(trace: AgentRunTrace): void;
  listAgentTraces(projectId?: string | null): AgentRunTrace[];
  clearAgentTraces(): void;
}
const memoryTraces = new Map<string, AgentRunTrace>();
const memoryStore: AgentTraceStore = {
  getAgentTrace: (id) => memoryTraces.get(id) ?? null,
  saveAgentTrace: (trace) => { memoryTraces.set(trace.id, trace); },
  listAgentTraces: (projectId) => [...memoryTraces.values()].filter((trace) => !projectId || trace.fields.projectId === projectId).sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id)),
  clearAgentTraces: () => memoryTraces.clear(),
};
let store: AgentTraceStore = memoryStore;
const SECRET_KEY = /(?:authorization|cookie|set-cookie|password|passphrase|secret|private.?key|api.?key|callback.?token|access.?token|refresh.?token|credential|nsec|signed.?event|runtime.?env|environment)/i;
const SECRET_TEXT = /(?:\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}|\bnsec1[023456789acdefghjklmnpqrstuvwxyz]{20,}|\bsk-[A-Za-z0-9_-]{12,}|(?:api[_-]?key|authorization|cookie|callback[_-]?token|private[_-]?key)\s*[:=]\s*[^\r\n,;}]+)/gi;

function redactText(value: string): string { return value.replace(SECRET_TEXT, "[redacted]"); }
export function sanitizeAgentTraceValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value ?? null;
  if (typeof value === "string") return redactText(value);
  if (typeof value !== "object") return redactText(String(value));
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeAgentTraceValue(item, seen));
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) result[key] = SECRET_KEY.test(key) ? "[redacted]" : sanitizeAgentTraceValue(nested, seen);
  return result;
}

function bytes(value: unknown): number { return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value)); }
function bounded(value: unknown, limit = MAX_TRACE_ITEM_BYTES): BoundedTraceValue {
  const safe = sanitizeAgentTraceValue(value); const size = bytes(safe);
  if (size <= limit) return { value: safe, bytes: size, truncated: false };
  const serialized = typeof safe === "string" ? safe : JSON.stringify(safe, null, 2);
  return { value: `${serialized.slice(0, Math.max(0, limit - 24))}\n[trace truncated]`, bytes: size, truncated: true };
}
function safeFieldValue(key: string, value: unknown): string | number | boolean | null {
  if (value === undefined || value === null) return null;
  if (SECRET_KEY.test(key)) return "[redacted]";
  if (typeof value === "number" || typeof value === "boolean") return value;
  return redactText(typeof value === "string" ? value : String(value)).slice(0, 240);
}
function retainedBytes(trace: AgentRunTrace): number {
  return (trace.compiledInput ? Math.min(trace.compiledInput.bytes, MAX_TRACE_ITEM_BYTES) : 0) + trace.turns.reduce((total, turn) => total + Math.min(turn.bytes, MAX_TRACE_ITEM_BYTES), 0) + (trace.finalPayload ? Math.min(trace.finalPayload.bytes, MAX_TRACE_ITEM_BYTES) : 0);
}

export function beginAgentTrace(input: { stage: string; clientName: string; model: string | null; maxTurns: number; prompt: string; maxOutputBytes: number; fields?: ActivityLogFields }): string {
  const id = crypto.randomUUID(); const fields: AgentRunTrace["fields"] = {};
  for (const [key, value] of Object.entries(input.fields ?? {})) fields[key] = safeFieldValue(key, value);
  const compiledInput = bounded(input.prompt);
  store.saveAgentTrace({ id, stage: input.stage, clientName: input.clientName, model: input.model, maxTurns: input.maxTurns, status: "running", startedAt: Date.now(), completedAt: null, durationMs: null, promptBytes: Buffer.byteLength(input.prompt), maxOutputBytes: input.maxOutputBytes, outputBytes: null, inputTokens: null, outputTokens: null, cost: null, gooseSessionId: null, errorCode: null, errorDetail: null, outputPreview: null, compiledInput, turns: [], finalPayload: null, transcriptTruncated: compiledInput.truncated, fields });
  return id;
}
export function markAgentTraceSession(id: string, gooseSessionId: string): void { const trace = store.getAgentTrace(id); if (trace) { trace.gooseSessionId = redactText(gooseSessionId).slice(0, 240); store.saveAgentTrace(trace); } }
export function appendAgentTraceTurn(id: string, value: unknown, source: AgentModelTurn["source"] = "provider"): void {
  const trace = store.getAgentTrace(id); if (!trace) return;
  const remaining = MAX_TRACE_TOTAL_BYTES - retainedBytes(trace); if (remaining <= 0) { trace.transcriptTruncated = true; store.saveAgentTrace(trace); return; }
  const item = bounded(value, Math.min(MAX_TRACE_ITEM_BYTES, remaining)); trace.turns.push({ ...item, number: trace.turns.length + 1, observedAt: Date.now(), source }); trace.transcriptTruncated ||= item.truncated; store.saveAgentTrace(trace);
}
export function appendAgentTraceTurnIfEmpty(id: string, value: unknown, source: AgentModelTurn["source"] = "acp"): void { const trace = store.getAgentTrace(id); if (trace && !trace.turns.length) appendAgentTraceTurn(id, value, source); }
export function completeAgentTrace(id: string, input: { outputBytes: number; inputTokens: number | null; outputTokens: number | null; cost: number | null; outputPreview: unknown; rawOutput?: string }): void {
  let trace = store.getAgentTrace(id); if (!trace) return;
  if (input.rawOutput !== undefined) appendAgentTraceTurnIfEmpty(id, input.rawOutput, "acp");
  trace = store.getAgentTrace(id); if (!trace) return;
  trace.status = "succeeded"; trace.completedAt = Date.now(); trace.durationMs = trace.completedAt - trace.startedAt; trace.outputBytes = input.outputBytes; trace.inputTokens = input.inputTokens; trace.outputTokens = input.outputTokens; trace.cost = input.cost;
  trace.finalPayload = bounded(input.outputPreview, Math.min(MAX_TRACE_ITEM_BYTES, Math.max(0, MAX_TRACE_TOTAL_BYTES - retainedBytes(trace)))); trace.transcriptTruncated ||= trace.finalPayload.truncated; trace.outputPreview = trace.finalPayload.value; store.saveAgentTrace(trace);
}
export function failAgentTrace(id: string, errorCode: string, errorDetail: string | null = null): void { const trace = store.getAgentTrace(id); if (!trace) return; trace.status = "failed"; trace.completedAt = Date.now(); trace.durationMs = trace.completedAt - trace.startedAt; trace.errorCode = redactText(errorCode).slice(0, 120); trace.errorDetail = errorDetail ? redactText(errorDetail).slice(0, 500) : null; store.saveAgentTrace(trace); }
function serialize(trace: AgentRunTrace): AgentRunTrace { return sanitizeAgentTraceValue(JSON.parse(JSON.stringify(trace))) as AgentRunTrace; }
export function configureAgentTraceStore(next: AgentTraceStore): void {
  if (store === memoryStore) for (const trace of memoryStore.listAgentTraces()) next.saveAgentTrace(trace);
  memoryStore.clearAgentTraces();
  store = next;
}
export function releaseAgentTraceStore(current: AgentTraceStore): void { if (store === current) store = memoryStore; }
export function agentTraces(projectId?: string | null): AgentRunTrace[] { return store.listAgentTraces(projectId).map(serialize); }
export function clearAgentTracesForTests(): void {
  const previous = store;
  store = memoryStore;
  memoryStore.clearAgentTraces();
  try { previous.clearAgentTraces(); } catch { /* A test may already have closed its SQLite repository. */ }
}
