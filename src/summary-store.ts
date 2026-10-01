import { createHash, randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { normalizeSummaryMessages, validateSummary, SummaryError, SUMMARY_ERRORS, type FeedbackSummary, type SummaryErrorCode, type SummaryMessage, type SummaryRunView, type SummaryStatus } from './feedback-summary';
import type { BuildRun, FrozenBrief, MemberFeedback, RoundEvent } from './loop';

export interface SummaryInput {
  schemaVersion: 1; promptVersion: 1; project: { id: string; name: string; templateTitle: string; templateDescription: string };
  sourceRound: { id: string; number: number }; release: BuildRun | null; brief: FrozenBrief | null; feedback: MemberFeedback[];
}
export interface SummaryAttempt { runId: string; token: string; attemptNumber: number; projectId: string; roundId: string; input: SummaryInput; model: string }
type RunRow = { id: string; project_id: string; round_id: string; status: SummaryStatus; attempt_number: number; input_json: string; input_hash: string; model: string; token: string | null; lease_expires_at: number | null; error_code: SummaryErrorCode | null };
function runRow(value: unknown): RunRow | null {
  if(value===null)return null;
  if(!value||typeof value!=="object"||Array.isArray(value))throw new SummaryError('invalid_input');
  const r=value as Record<string,unknown>;
  for(const key of ['id','project_id','round_id','input_json','input_hash','model'])if(typeof r[key]!=="string")throw new SummaryError('invalid_input');
  if(!r.id||!r.project_id||!r.round_id||!['queued','running','failed','succeeded','skipped'].includes(String(r.status))||!Number.isSafeInteger(r.attempt_number)||Number(r.attempt_number)<0)throw new SummaryError('invalid_input');
  if(r.token!==null&&typeof r.token!=="string")throw new SummaryError('invalid_input');
  if(r.lease_expires_at!==null&&(typeof r.lease_expires_at!=="number"||!Number.isFinite(r.lease_expires_at)))throw new SummaryError('invalid_input');
  return {id:String(r.id),project_id:String(r.project_id),round_id:String(r.round_id),input_json:String(r.input_json),input_hash:String(r.input_hash),model:String(r.model),status:r.status as SummaryStatus,attempt_number:Number(r.attempt_number),token:r.token as string|null,lease_expires_at:r.lease_expires_at as number|null,error_code:SUMMARY_ERRORS.includes(r.error_code as SummaryErrorCode)?r.error_code as SummaryErrorCode:null};
}
export interface SummaryCompletion { output: unknown; sessionId: string | null; usage: { inputTokens: number | null; outputTokens: number | null; cost: number | null } | null }

/** All callbacks execute synchronously inside the same SQLite transaction. */
export class SummaryStore {
  constructor(private db: Database, private now: () => number, private emit: (roundId: string, type: RoundEvent['type']) => void, private successor: (input: SummaryInput, content: FeedbackSummary | null) => string) {
    const columns = db.query('PRAGMA table_info(collaboration_rounds)').all() as {name: string}[];
    // Additive phase overlay preserves the old CHECK constraint and all referencing tables.
    if (!columns.some(c => c.name === 'feedback_closed')) db.exec('ALTER TABLE collaboration_rounds ADD COLUMN feedback_closed INTEGER NOT NULL DEFAULT 0');
    db.exec(`CREATE TABLE IF NOT EXISTS ai_runs (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), round_id TEXT NOT NULL REFERENCES collaboration_rounds(id), kind TEXT NOT NULL,
      input_version INTEGER NOT NULL, prompt_version INTEGER NOT NULL, schema_version INTEGER NOT NULL, input_json TEXT NOT NULL, input_hash TEXT NOT NULL,
      provider TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, attempt_number INTEGER NOT NULL DEFAULT 0,
      token TEXT, lease_owner TEXT, lease_expires_at INTEGER, goose_session_id TEXT, created_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER,
      error_code TEXT, output_json TEXT, usage_json TEXT, UNIQUE(round_id,kind));
      CREATE TABLE IF NOT EXISTS ai_run_attempts (run_id TEXT NOT NULL REFERENCES ai_runs(id), attempt_number INTEGER NOT NULL, token TEXT NOT NULL UNIQUE,
        lease_owner TEXT NOT NULL, lease_expires_at INTEGER NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL, completed_at INTEGER,
        goose_session_id TEXT, error_code TEXT, output_json TEXT, usage_json TEXT, PRIMARY KEY(run_id,attempt_number));
      CREATE TABLE IF NOT EXISTS bot_messages (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES ai_runs(id), purpose TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id), source_round_id TEXT NOT NULL REFERENCES collaboration_rounds(id), successor_round_id TEXT NOT NULL REFERENCES collaboration_rounds(id),
        schema_version INTEGER NOT NULL, author_kind TEXT NOT NULL, content_json TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(run_id,purpose));`);
  }
  get(roundId: string): RunRow | null { return runRow(this.db.query("SELECT * FROM ai_runs WHERE round_id=? AND kind='feedback_summary'").get(roundId)); }
  view(roundId: string, organiser: boolean): SummaryRunView | null {
    const r = this.get(roundId); if (!r) return null;
    return { id: r.id, status: r.status, attemptNumber: r.attempt_number, errorCode: SUMMARY_ERRORS.includes(r.error_code as SummaryErrorCode) ? r.error_code : null, canRetry: organiser && r.status === 'failed' && r.attempt_number < 3, canSkip: organiser && ['queued', 'running', 'failed'].includes(r.status) };
  }
  messages(projectId: string, feedbackIds: Set<string>): SummaryMessage[] {
    const rows = this.db.query('SELECT content_json FROM bot_messages WHERE project_id=? ORDER BY created_at,id').all(projectId) as {content_json: string}[];
    try { return normalizeSummaryMessages(rows.map(r => JSON.parse(r.content_json) as unknown), feedbackIds); }
    catch { throw new SummaryError('invalid_output'); }
  }
  queue(input: SummaryInput, model: string, maxInputBytes: number): boolean {
    if (this.get(input.sourceRound.id)) return false;
    const serialized = JSON.stringify(input); const oversize = Buffer.byteLength(serialized) > maxInputBytes;
    this.db.query(`INSERT INTO ai_runs (id,project_id,round_id,kind,input_version,prompt_version,schema_version,input_json,input_hash,provider,model,status,created_at,error_code)
      VALUES (?,?,?,'feedback_summary',1,1,1,?,?,'openrouter',?,?,?,?)`).run(randomUUID(), input.project.id, input.sourceRound.id, serialized, hash(serialized), model, oversize ? 'failed' : 'queued', this.now(), oversize ? 'input_too_large' : null);
    this.db.query('UPDATE collaboration_rounds SET feedback_closed=1 WHERE id=?').run(input.sourceRound.id);
    this.emit(input.sourceRound.id, oversize ? 'summary_failed' : 'summary_queued');
    return true;
  }
  retry(roundId: string, expectedAttemptNumber?: number): boolean {
    const r = this.get(roundId); if (!r || r.status !== 'failed' || (expectedAttemptNumber !== undefined && r.attempt_number !== expectedAttemptNumber)) return false;
    if (r.attempt_number >= 3) throw new SummaryError('retry_limit');
    this.db.query("UPDATE ai_runs SET status='queued', token=NULL, lease_owner=NULL, lease_expires_at=NULL, error_code=NULL WHERE id=?").run(r.id);
    this.emit(roundId, 'summary_queued'); return true;
  }
  claim(owner: string, leaseMs: number, model: string): SummaryAttempt | null {
    return this.db.transaction(() => {
      const r = runRow(this.db.query("SELECT * FROM ai_runs WHERE kind='feedback_summary' AND status='queued' ORDER BY created_at,id LIMIT 1").get());
      if (!r) return null;
      const token = randomUUID(), at = this.now(), number = r.attempt_number + 1;
      this.db.query("UPDATE ai_runs SET status='running',attempt_number=?,token=?,lease_owner=?,lease_expires_at=?,started_at=?,model=? WHERE id=? AND status='queued'").run(number, token, owner, at + leaseMs, at, model, r.id);
      this.db.query("INSERT INTO ai_run_attempts (run_id,attempt_number,token,lease_owner,lease_expires_at,status,started_at) VALUES (?,?,?,?,?,'running',?)").run(r.id, number, token, owner, at + leaseMs, at);
      this.emit(r.round_id, 'summary_running');
      try { return { runId: r.id, token, attemptNumber: number, projectId: r.project_id, roundId: r.round_id, input: this.input(r), model }; }
      catch { this.failToken(token, 'invalid_input'); return null; }
    })();
  }
  private input(r: RunRow): SummaryInput {
    if (hash(r.input_json) !== r.input_hash) throw new SummaryError('invalid_input');
    const v: unknown = JSON.parse(r.input_json);
    if (!v || typeof v !== 'object') throw new SummaryError('invalid_input');
    const i = v as SummaryInput;
    if (i.schemaVersion !== 1 || i.promptVersion !== 1 || i.project?.id !== r.project_id || i.sourceRound?.id !== r.round_id || !Number.isSafeInteger(i.sourceRound.number) || !Array.isArray(i.feedback) || !i.feedback.length) throw new SummaryError('invalid_input');
    for (const f of i.feedback) if (!f || ['id','authorAccountId','authorNpub','worked','improve','nextIdea','clientEventId'].some(k => typeof (f as unknown as Record<string, unknown>)[k] !== 'string')) throw new SummaryError('invalid_input');
    return i;
  }
  active(token: string): boolean { return Boolean(this.db.query("SELECT 1 FROM ai_runs WHERE token=? AND status='running' AND lease_expires_at>?").get(token, this.now())); }
  recordSession(token: string, sessionId: string): void {
    if (!this.active(token)) return;
    this.db.transaction(() => { this.db.query('UPDATE ai_runs SET goose_session_id=? WHERE token=?').run(sessionId, token); this.db.query('UPDATE ai_run_attempts SET goose_session_id=? WHERE token=?').run(sessionId, token); })();
  }
  failToken(token: string, code: SummaryErrorCode): void {
    this.db.transaction(() => {
      const r = runRow(this.db.query("SELECT * FROM ai_runs WHERE token=? AND status='running'").get(token)); if (!r) return;
      const safeCode = SUMMARY_ERRORS.includes(code) ? code : 'provider_error';
      this.db.query("UPDATE ai_runs SET status='failed',token=NULL,completed_at=?,error_code=? WHERE id=?").run(this.now(), safeCode, r.id);
      this.db.query("UPDATE ai_run_attempts SET status='failed',completed_at=?,error_code=? WHERE token=?").run(this.now(), safeCode, token);
      this.emit(r.round_id, 'summary_failed');
    })();
  }
  recoverExpired(): void {
    const rows = this.db.query("SELECT token FROM ai_runs WHERE status='running' AND lease_expires_at<=?").all(this.now()) as {token: string}[];
    for (const r of rows) this.failToken(r.token, 'interrupted');
  }
  complete(token: string, result: SummaryCompletion): boolean {
    return this.db.transaction(() => {
      if (!this.active(token)) return false;
      const r = runRow(this.db.query('SELECT * FROM ai_runs WHERE token=?').get(token))!;
      if (!this.frozen(r.round_id)) return false;
      const input = this.input(r); const output = validateSummary(result.output, new Set(input.feedback.map(f => f.id)));
      const at = this.now(); const usage = safeUsage(result.usage);
      this.db.query("UPDATE ai_runs SET status='succeeded',token=NULL,completed_at=?,goose_session_id=?,output_json=?,usage_json=? WHERE id=?").run(at, result.sessionId, JSON.stringify(output), JSON.stringify(usage), r.id);
      this.db.query("UPDATE ai_run_attempts SET status='succeeded',completed_at=?,goose_session_id=?,output_json=?,usage_json=? WHERE token=?").run(at, result.sessionId, JSON.stringify(output), JSON.stringify(usage), token);
      this.publish(r, input, output); return true;
    })();
  }
  skip(roundId: string): boolean {
    const r = this.get(roundId); if (!r || ['succeeded', 'skipped'].includes(r.status)) return false;
    if (!this.frozen(roundId)) return false;
    this.db.query("UPDATE ai_run_attempts SET status='cancelled',completed_at=? WHERE run_id=? AND status='running'").run(this.now(), r.id);
    this.db.query("UPDATE ai_runs SET status='skipped',token=NULL,completed_at=? WHERE id=?").run(this.now(), r.id);
    this.publish(r, this.input(r), null); return true;
  }
  private frozen(roundId: string): boolean { return Boolean(this.db.query('SELECT 1 FROM collaboration_rounds WHERE id=? AND feedback_closed=1').get(roundId)); }
  private publish(r: RunRow, input: SummaryInput, content: SummaryMessage['content']): void {
    this.emit(r.round_id, content ? 'summary_completed' : 'summary_skipped');
    const successorRoundId = this.successor(input, content);
    const message: SummaryMessage = { schemaVersion: 1, id: randomUUID(), runId: r.id, projectId: r.project_id, sourceRoundId: r.round_id, sourceRoundNumber: input.sourceRound.number, successorRoundId, createdAt: this.now(), author: content ? { kind: 'bot', id: 'lvl_up', displayName: 'lvl_up' } : { kind: 'system', id: 'level-up', displayName: 'Level Up' }, content };
    this.db.query("INSERT INTO bot_messages VALUES (?,?,'feedback_summary',?,?,?,1,?,?,?)").run(message.id, r.id, r.project_id, r.round_id, successorRoundId, message.author.kind, JSON.stringify(message), message.createdAt);
  }
}
function hash(input: string): string { return createHash('sha256').update(input).digest('hex'); }
function safeUsage(value: unknown): SummaryCompletion['usage'] {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>; const n = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null;
  return { inputTokens: n(v.inputTokens), outputTokens: n(v.outputTokens), cost: n(v.cost) };
}
