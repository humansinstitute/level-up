/** Browser-safe, versioned summary contract. Provider/process code lives elsewhere. */
export const SUMMARY_SCHEMA_VERSION = 1;
export const SUMMARY_PROMPT_VERSION = 1;
export const MAX_SUMMARY_BYTES = 24_000;
export type SummaryStatus = 'queued' | 'running' | 'failed' | 'succeeded' | 'skipped';
export type SummaryAuthor = { kind: 'bot'; id: 'lvl_up'; displayName: 'lvl_up' } | { kind: 'system'; id: 'level-up'; displayName: 'Level Up' };
export interface SummaryPoint { text: string; feedbackIds: string[] }
export interface FeedbackSummary {
  schemaVersion: 1; overview: string; worked: SummaryPoint[]; needsAttention: SummaryPoint[];
  suggestedUpdates: { title: string; reason: string; origin: 'player_request' | 'agent_suggestion'; feedbackIds: string[] }[];
  questions: SummaryPoint[];
}
export interface SummaryRunView { id: string; status: SummaryStatus; attemptNumber: number; errorCode: string | null; canRetry: boolean; canSkip: boolean }
export interface SummaryMessage {
  schemaVersion: 1; id: string; runId: string; projectId: string; sourceRoundId: string; sourceRoundNumber: number;
  successorRoundId: string; author: SummaryAuthor; content: FeedbackSummary | null; createdAt: number;
}
export const SUMMARY_ERRORS = ['setup_disabled', 'setup_missing_key', 'setup_missing_model', 'setup_binary', 'setup_isolation', 'setup_config', 'input_too_large', 'invalid_input', 'provider_error', 'timeout', 'invalid_output', 'output_too_large', 'permission_denied', 'interrupted', 'retry_limit'] as const;
export type SummaryErrorCode = typeof SUMMARY_ERRORS[number];
export class SummaryError extends Error {
  constructor(public readonly code: SummaryErrorCode, public readonly correction: string | null = null) { super(code); }
}
export function invalidAgentOutput(path: string, correction: string): never {
  throw new SummaryError('invalid_output', `${path}: ${correction}`);
}
export function agentErrorMessage(code: SummaryErrorCode): string {
  if (code === "setup_disabled") return "The AI agent was disabled by an older Level Up runtime. Restart with the current build so configured agent credentials are used automatically.";
  if (code === "setup_missing_key") return "The AI agent is missing OPENROUTER_API_KEY in the Level Up runtime configuration.";
  if (code === "setup_missing_model") return "The AI agent is missing LEVELUP_AGENT_MODEL in the Level Up runtime configuration.";
  if (code === "setup_binary") return "LvlUP is not available because its build runtime is missing or unsupported.";
  if (code === "setup_config" || code === "setup_isolation") return "LvlUP is not configured correctly. Ask the Level Up owner to check the agent setup before trying again.";
  if (code === "timeout") return "The AI agent timed out before it could finish that update. Try again, or check the provider connection.";
  if (code === "provider_error") return "The AI provider failed before Level Up received a valid update. Check the provider configuration and try again.";
  if (code === "invalid_output") return "The AI agent replied, but Level Up could not safely read the required update. The last playable release is unchanged; try this feature again.";
  if (code === "output_too_large") return "The AI agent's update was too large for Level Up to validate safely. The last playable release is unchanged; try this feature again.";
  if (code === "input_too_large") return "The brainstorm is too large for the configured AI agent input budget.";
  if (code === "permission_denied") return "The AI agent requested a tool or permission Level Up does not allow.";
  if (code === "interrupted") return "The AI agent run was interrupted before it could finish.";
  return "The AI agent could not finish that update. Check the agent configuration, refresh, and try again.";
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidAgentOutput('response', 'provide a JSON object');
  return value as Record<string, unknown>;
}
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  const o = object(value);
  if (Object.keys(o).length !== keys.length || keys.some(k => !(k in o))) invalidAgentOutput('response fields', `provide exactly: ${keys.join(', ')}`);
  return o;
}
function text(value: unknown, limit = 1200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) invalidAgentOutput('text field', `provide non-empty text no longer than ${limit} characters`);
  return value;
}
function list<T>(value: unknown, parse: (v: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > 12) invalidAgentOutput('list field', 'provide a JSON array with at most 12 items');
  return value.map(parse);
}
export function validateSummary(value: unknown, allowedIds: Set<string>): FeedbackSummary {
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_SUMMARY_BYTES) throw new SummaryError('output_too_large');
  const o = exact(value, ['schemaVersion', 'overview', 'worked', 'needsAttention', 'suggestedUpdates', 'questions']);
  if (o.schemaVersion !== 1) invalidAgentOutput('schemaVersion', 'use 1');
  const ids = (v: unknown): string[] => {
    if (!Array.isArray(v) || !v.length || v.length > allowedIds.size || v.some(id => typeof id !== 'string' || !allowedIds.has(id)) || new Set(v).size !== v.length) invalidAgentOutput('feedbackIds', `use one or more unique allowed feedback IDs: ${[...allowedIds].join(', ')}`);
    return v;
  };
  const point = (v: unknown): SummaryPoint => { const p = exact(v, ['text', 'feedbackIds']); return { text: text(p.text), feedbackIds: ids(p.feedbackIds) }; };
  return { schemaVersion: 1, overview: text(o.overview), worked: list(o.worked, point), needsAttention: list(o.needsAttention, point), questions: list(o.questions, point), suggestedUpdates: list(o.suggestedUpdates, v => {
    const p = exact(v, ['title', 'reason', 'origin', 'feedbackIds']);
    if (p.origin !== 'player_request' && p.origin !== 'agent_suggestion') throw new SummaryError('invalid_output');
    return { title: text(p.title, 160), reason: text(p.reason), origin: p.origin, feedbackIds: ids(p.feedbackIds) };
  }) };
}
export function normalizeSummaryRun(value: unknown): SummaryRunView | null {
  if (value == null) return null;
  const v = object(value);
  if (typeof v.id !== 'string' || !v.id || !['queued', 'running', 'failed', 'succeeded', 'skipped'].includes(String(v.status)) || !Number.isSafeInteger(v.attemptNumber)) throw new SummaryError('invalid_output');
  return { id: v.id, status: v.status as SummaryStatus, attemptNumber: Number(v.attemptNumber), errorCode: SUMMARY_ERRORS.includes(v.errorCode as SummaryErrorCode) ? String(v.errorCode) : null, canRetry: v.canRetry === true, canSkip: v.canSkip === true };
}
export function normalizeSummaryMessages(value: unknown, allowedIds: Set<string>): SummaryMessage[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new SummaryError('invalid_output');
  return value.map(item => {
    const v = object(item); const a = object(v.author);
    for (const key of ['id', 'runId', 'projectId', 'sourceRoundId', 'successorRoundId']) if (typeof v[key] !== 'string' || !v[key]) throw new SummaryError('invalid_output');
    if (v.schemaVersion !== 1 || !Number.isSafeInteger(v.sourceRoundNumber) || Number(v.sourceRoundNumber) < 1 || typeof v.createdAt !== 'number' || !Number.isFinite(v.createdAt)) throw new SummaryError('invalid_output');
    let author: SummaryAuthor;
    if (a.kind === 'bot' && a.id === 'lvl_up' && a.displayName === 'lvl_up') author = { kind: 'bot', id: 'lvl_up', displayName: 'lvl_up' };
    else if (a.kind === 'system' && a.id === 'level-up' && a.displayName === 'Level Up') author = { kind: 'system', id: 'level-up', displayName: 'Level Up' };
    else throw new SummaryError('invalid_output');
    return { schemaVersion: 1, id: String(v.id), runId: String(v.runId), projectId: String(v.projectId), sourceRoundId: String(v.sourceRoundId), successorRoundId: String(v.successorRoundId), sourceRoundNumber: Number(v.sourceRoundNumber), createdAt: v.createdAt, author, content: author.kind === 'bot' ? validateSummary(v.content, allowedIds) : null };
  });
}

/** Curated player copy, never provider stderr or internal reasoning. */
export function summaryFailureText(code: string | null | undefined): string {
  if(code==='input_too_large')return "The team's feedback exceeds the summary size limit. All original notes are safe; start discussion with them.";
  if(code?.startsWith('setup_'))return "Feedback summaries need organiser setup. All original notes are safe.";
  if(code==='timeout')return "The feedback summary timed out. Your original notes are safe.";
  if(code==='invalid_output'||code==='output_too_large')return "I couldn't verify the feedback summary. Your original notes are safe.";
  return "I couldn't finish the feedback summary. Your original notes are safe.";
}
