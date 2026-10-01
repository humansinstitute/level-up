import { AuthError, type AuthService } from "./auth";
import { RepositoryError, type RoundEvent, type RoundSnapshot, type TeamRepository } from "./storage";
import { LoopError } from "./loop";
import { SummaryError, agentErrorMessage } from "./feedback-summary";

export interface RoundSocketData {
  projectId: string;
  accountId: string;
  roundNumber: number;
  afterSequence: number;
}

export type ActivityLogger = (event: string, fields?: Record<string, string | number | boolean | null>) => void;
type SuggestionIntervalProvider = () => number;

type RoundClientMessage =
  | { type: "contribution.submit"; clientEventId: string; body: string; attachments?: unknown[] }
  | { type: "brainstorm.close" };

export class RoundRealtimeHub {
  private readonly summaryVersions = new Map<string,string>();
  private readonly sockets = new Map<string, Set<Bun.ServerWebSocket<RoundSocketData>>>();
  private readonly deadlineTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly buildTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly activeBuilds = new Set<string>();
  private readonly suggestionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private recoveryTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly auth: AuthService,
    private readonly repository: TeamRepository,
    private readonly activityLog?: ActivityLogger,
    private readonly suggestionIntervalMs: SuggestionIntervalProvider = () => 30_000,
  ) {}

  startDeadlineRecovery(intervalMs=1_000):void { if(this.recoveryTimer)return;const scan=()=>{for(const projectId of this.repository.deadlineProjectIds())void this.runDeadline(projectId);for(const projectId of this.repository.builderProjectIds())this.scheduleBuild(projectId);};this.recoveryTimer=setInterval(scan,intervalMs);scan(); }
  stopDeadlineRecovery():void { if(this.recoveryTimer)clearInterval(this.recoveryTimer);this.recoveryTimer=null; }

  upgrade(request: Request, server: Bun.Server<RoundSocketData>): Response | undefined | null {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/round-stream$/);
    if (!match) return null;
    if (request.method !== "GET") return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405, headers: { Allow: "GET" } });
    try {
      const session = this.auth.readSession(request.headers.get("cookie"));
      if (!session) throw new AuthError("unauthenticated", "Sign in with Nostr to continue.", 401);
      const account = this.repository.accountForNostr(session.pubkey, session.npub);
      const projectId = decodeURIComponent(match[1]!);
      const round = this.repository.round(projectId, account.id);
      const requestedAfter = Number(url.searchParams.get("after") ?? "0");
      const afterSequence = Number.isSafeInteger(requestedAfter) && requestedAfter >= 0 ? requestedAfter : 0;
      if (!server.upgrade(request, { data: { projectId, accountId: account.id, roundNumber: round.number, afterSequence } })) {
        return Response.json({ ok: false, error: "upgrade_failed" }, { status: 400 });
      }
      this.activityLog?.("ws.upgrade", { projectId, roundNumber: round.number, afterSequence });
      return undefined;
    } catch (error) {
      if (error instanceof AuthError || error instanceof RepositoryError) {
        return Response.json({ ok: false, error: error.code, message: error.message }, { status: error.status });
      }
      return Response.json({ ok: false, error: "internal_error" }, { status: 500 });
    }
  }

  open(socket: Bun.ServerWebSocket<RoundSocketData>): void {
    const { projectId, accountId, roundNumber, afterSequence } = socket.data;
    const group = this.sockets.get(projectId) ?? new Set();
    group.add(socket);
    this.sockets.set(projectId, group);
    try {
      const sync = this.repository.roundEvents(projectId, accountId, afterSequence, roundNumber);
      socket.send(JSON.stringify({ type: "round.sync", ...sync }));
      this.activityLog?.("ws.open", { projectId, roundNumber, afterSequence, events: sync.events.length, phase: sync.round.phase });
      this.scheduleDeadline(projectId, sync.round);
      if (sync.round.phase === "brainstorm") this.scheduleBrainstormSuggestion(projectId);
      if (sync.round.phase === "building" || sync.round.activeBuild?.build.status === "running") this.scheduleBuild(projectId);
    } catch (error) {
      socket.send(JSON.stringify({ type: "round.error", message: this.errorMessage(error) }));
      socket.close(1008, "Round access denied");
    }
  }

  message(socket: Bun.ServerWebSocket<RoundSocketData>, raw: string | Buffer): void {
    void this.handleMessage(socket, raw);
  }

  private async handleMessage(socket: Bun.ServerWebSocket<RoundSocketData>, raw: string | Buffer): Promise<void> {
    let message: RoundClientMessage;
    try {
      const parsed: unknown = JSON.parse(typeof raw === "string" ? raw : raw.toString());
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      const candidate=parsed as {type?:unknown;clientEventId?:unknown;body?:unknown;attachments?:unknown};
      if(candidate.type==="contribution.submit"&&typeof candidate.clientEventId==="string"&&typeof candidate.body==="string")message={type:candidate.type,clientEventId:candidate.clientEventId,body:candidate.body,attachments:Array.isArray(candidate.attachments)?candidate.attachments:undefined};
      else if(candidate.type==="brainstorm.close")message={type:candidate.type};
      else throw new Error();
    } catch {
      socket.send(JSON.stringify({ type: "round.error", message: "Invalid realtime message." }));
      return;
    }
    try {
      if (message.type === "contribution.submit") {
        const result = this.repository.submitContribution(socket.data.projectId, socket.data.accountId, String(message.clientEventId ?? ""), String(message.body ?? ""), socket.data.roundNumber, message.attachments);
        socket.send(JSON.stringify({ type: "contribution.ack", clientEventId: message.clientEventId, status: "sent", roundNumber: socket.data.roundNumber, sequence: result.event?.sequence ?? null }));
        this.activityLog?.("round.contribution", { projectId: socket.data.projectId, roundNumber: socket.data.roundNumber, duplicate: result.duplicate, sequence: result.event?.sequence ?? null });
        if (!result.duplicate && result.event) this.publish(socket.data.projectId, result.event, result.round);
        return;
      }
      if (message.type === "brainstorm.close") {
        const resultOrPromise = this.repository.closeBrainstorm(socket.data.projectId, socket.data.accountId);
        if (resultOrPromise instanceof Promise) this.publishSnapshot(socket.data.projectId, "proposal_generation_started");
        const result = resultOrPromise instanceof Promise ? await resultOrPromise.catch((error) => {
          this.publishSnapshot(socket.data.projectId, "proposal_generation_failed");
          throw error;
        }) : resultOrPromise;
        socket.send(JSON.stringify({ type: "brainstorm.ack", status: "sent", sequence: result.event?.sequence ?? result.round.lastSequence }));
        this.activityLog?.("round.brainstorm_close", { projectId: socket.data.projectId, roundNumber: socket.data.roundNumber, sequence: result.event?.sequence ?? result.round.lastSequence, phase: result.round.phase });
        if (result.event) this.publish(socket.data.projectId, result.event, result.round);
        return;
      }
      throw new RepositoryError("invalid_realtime_message", "That realtime command is not supported.", 400);
    } catch (error) {
      const clientEventId = message.type === "contribution.submit" ? message.clientEventId : undefined;
      socket.send(JSON.stringify({ type: message.type === "contribution.submit" ? "contribution.ack" : "round.error", clientEventId, status: "failed", message: this.errorMessage(error) }));
      this.activityLog?.("ws.command_failed", { projectId: socket.data.projectId, roundNumber: socket.data.roundNumber, command: message.type, error: this.errorMessage(error) });
    }
  }

  close(socket: Bun.ServerWebSocket<RoundSocketData>): void {
    const group = this.sockets.get(socket.data.projectId);
    group?.delete(socket);
    this.activityLog?.("ws.close", { projectId: socket.data.projectId, roundNumber: socket.data.roundNumber, remaining: group?.size ?? 0 });
    if (!group?.size) {
      this.sockets.delete(socket.data.projectId);
      this.summaryVersions.delete(socket.data.projectId);
      const timer = this.deadlineTimers.get(socket.data.projectId);
      if (timer) clearTimeout(timer);
      this.deadlineTimers.delete(socket.data.projectId);
      const buildTimer = this.buildTimers.get(socket.data.projectId);
      if (buildTimer) clearTimeout(buildTimer);
      this.buildTimers.delete(socket.data.projectId);
      const suggestionTimer = this.suggestionTimers.get(socket.data.projectId);
      if (suggestionTimer) clearTimeout(suggestionTimer);
      this.suggestionTimers.delete(socket.data.projectId);
    }
  }

  publish(projectId: string, event: RoundEvent, round?: RoundSnapshot): void {
    const authoritativeRound = round ?? this.roundForConnectedMember(projectId);
    if (!authoritativeRound) return;
    this.activityLog?.("round.publish", { projectId, roundNumber: authoritativeRound.number, phase: authoritativeRound.phase, eventType: event.type, sequence: event.sequence, sockets: this.sockets.get(projectId)?.size ?? 0 });
    for (const socket of this.sockets.get(projectId) ?? []) {
      try {
        const personalisedRound = this.repository.round(projectId, socket.data.accountId);
        socket.send(JSON.stringify({ type: "round.event", event, round: personalisedRound }));
      } catch (error) {
        socket.send(JSON.stringify({ type: "round.error", message: this.errorMessage(error) }));
      }
    }
    const priorDeadlineTimer=this.deadlineTimers.get(projectId);
    if(priorDeadlineTimer){clearTimeout(priorDeadlineTimer);this.deadlineTimers.delete(projectId);}
    if (authoritativeRound.phase === "brainstorm" || authoritativeRound.phase === "voting") this.scheduleDeadline(projectId, authoritativeRound);
    if (authoritativeRound.phase === "brainstorm" && (this.sockets.get(projectId)?.size ?? 0) > 0) this.scheduleBrainstormSuggestion(projectId);
    else {
      const timer=this.suggestionTimers.get(projectId);
      if(timer)clearTimeout(timer);
      this.suggestionTimers.delete(projectId);
    }
    if (authoritativeRound.phase === "building" || authoritativeRound.activeBuild?.build.status === "running") this.scheduleBuild(projectId);
  }

  publishSnapshot(projectId: string, reason: "proposal_generation_started" | "proposal_generation_failed"): void {
    const authoritativeRound = this.roundForConnectedMember(projectId);
    if (!authoritativeRound) return;
    this.activityLog?.("round.snapshot_publish", { projectId, roundNumber: authoritativeRound.number, phase: authoritativeRound.phase, reason, sockets: this.sockets.get(projectId)?.size ?? 0 });
    for (const socket of this.sockets.get(projectId) ?? []) {
      try {
        socket.send(JSON.stringify({ type: "round.sync", round: this.repository.round(projectId, socket.data.accountId), events: [] }));
      } catch (error) {
        socket.send(JSON.stringify({ type: "round.error", message: this.errorMessage(error) }));
      }
    }
  }

  refreshSummaryChanges(): void {
    for (const projectId of this.sockets.keys()) {
      const round = this.roundForConnectedMember(projectId); if (!round) continue;
      const version = `${round.id}:${round.lastSequence}`;
      if (this.summaryVersions.get(projectId) === version) continue;
      this.summaryVersions.set(projectId,version);
      const socket = this.sockets.get(projectId)!.values().next().value!;
      const sync = this.repository.roundEvents(projectId,socket.data.accountId,Math.max(0,round.lastSequence-1),round.number);
      const event = sync.events.at(-1); if(event)this.publish(projectId,event,round);
    }
  }

  rescheduleBrainstormSuggestions(): void {
    for (const projectId of this.sockets.keys()) {
      const timer = this.suggestionTimers.get(projectId);
      if (timer) clearTimeout(timer);
      this.suggestionTimers.delete(projectId);
      try {
        const round = this.roundForConnectedMember(projectId);
        if (round?.phase === "brainstorm") this.scheduleBrainstormSuggestion(projectId, this.currentSuggestionIntervalMs());
      } catch (error) {
        this.activityLog?.("round.suggestion_reschedule_failed", { projectId, error: this.errorMessage(error) });
      }
    }
  }

  stopProjects(projectIds: string[]): void {
    for (const projectId of projectIds) {
      for (const timer of [this.deadlineTimers.get(projectId), this.buildTimers.get(projectId), this.suggestionTimers.get(projectId)]) if (timer) clearTimeout(timer);
      this.deadlineTimers.delete(projectId); this.buildTimers.delete(projectId); this.suggestionTimers.delete(projectId); this.summaryVersions.delete(projectId);
      for (const socket of this.sockets.get(projectId) ?? []) socket.close(1001, "Project deleted");
      this.sockets.delete(projectId);
    }
  }

  private roundForConnectedMember(projectId: string): RoundSnapshot | null {
    const socket = this.sockets.get(projectId)?.values().next().value as Bun.ServerWebSocket<RoundSocketData> | undefined;
    return socket ? this.repository.round(projectId, socket.data.accountId) : null;
  }

  private scheduleDeadline(projectId: string, round: RoundSnapshot): void {
    if ((round.phase !== "brainstorm" && round.phase !== "voting") || this.deadlineTimers.has(projectId)) return;
    const deadline = round.phase === "brainstorm" ? round.deadlineAt : round.votingDeadlineAt;
    if (deadline === null) return;
    const delay = Math.max(0, Math.min(2_147_483_647, deadline - Date.now()));
    const timer = setTimeout(() => {
      void (async () => {
        this.deadlineTimers.delete(projectId);
        await this.runDeadline(projectId,round);
      })();
    }, delay);
    this.deadlineTimers.set(projectId, timer);
  }

  private async runDeadline(projectId:string,knownRound?:RoundSnapshot):Promise<void>{try{const pending=this.repository.closeExpiredBrainstorm(projectId);if(pending instanceof Promise)this.publishSnapshot(projectId,"proposal_generation_started");const result=pending instanceof Promise?await pending:pending;if(result?.event)this.publish(projectId,result.event,result.round);else if(result&&(result.round.phase==="brainstorm"||result.round.phase==="voting")&&this.sockets.has(projectId))this.scheduleDeadline(projectId,result.round);}catch(error){this.publishSnapshot(projectId,"proposal_generation_failed");this.activityLog?.("round.deadline_failed",{projectId,roundNumber:knownRound?.number??0,phase:knownRound?.phase??"brainstorm",error:this.errorMessage(error)});}}

  private scheduleBuild(projectId: string): void {
    if (this.buildTimers.has(projectId) || this.activeBuilds.has(projectId)) return;
    const timer=setTimeout(()=>{void (async()=>{let progressTimer:ReturnType<typeof setInterval>|null=null;try{this.buildTimers.delete(projectId);this.activeBuilds.add(projectId);const maybe=this.repository.advanceBuild(projectId);if(maybe instanceof Promise)progressTimer=setInterval(()=>this.publishBuildProgress(projectId),1_000);const result=maybe instanceof Promise?await maybe:maybe;if(result?.event)this.publish(projectId,result.event,result.round);}catch(error){this.activityLog?.("round.build_failed",{projectId,error:this.errorMessage(error)});}finally{if(progressTimer)clearInterval(progressTimer);this.activeBuilds.delete(projectId);if(this.repository.builderProjectIds().includes(projectId))this.scheduleBuild(projectId);}})();},250);
    this.buildTimers.set(projectId,timer);
  }

  private publishBuildProgress(projectId:string):void {
    for(const socket of this.sockets.get(projectId)??[]){try{socket.send(JSON.stringify({type:"round.sync",round:this.repository.round(projectId,socket.data.accountId),events:[]}));}catch(error){socket.send(JSON.stringify({type:"round.error",message:this.errorMessage(error)}));}}
  }

  private currentSuggestionIntervalMs(): number {
    const value = this.suggestionIntervalMs();
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 30_000;
  }

  private scheduleBrainstormSuggestion(projectId: string, delayMs = this.currentSuggestionIntervalMs()): void {
    if (this.suggestionTimers.has(projectId) || !this.sockets.has(projectId)) return;
    const timer = setTimeout(() => {
      void (async () => {
        this.suggestionTimers.delete(projectId);
        if (!this.sockets.has(projectId)) return;
        try {
          const result = await this.repository.suggestBrainstorm(projectId);
          if (result?.event) this.publish(projectId, result.event, result.round);
          const round = result?.round ?? this.roundForConnectedMember(projectId);
          if (round?.phase === "brainstorm") this.scheduleBrainstormSuggestion(projectId, result?.event ? this.currentSuggestionIntervalMs() : 10_000);
        } catch (error) {
          const message = this.errorMessage(error);
          this.activityLog?.("round.suggestion_failed", { projectId, error: message });
          for (const socket of this.sockets.get(projectId) ?? []) {
            socket.send(JSON.stringify({ type: "round.error", message }));
            try { socket.send(JSON.stringify({type:"round.sync",round:this.repository.round(projectId,socket.data.accountId),events:[]})); } catch { /* The socket will recover normally. */ }
          }
          let round:RoundSnapshot|null=null;
          try { round=this.roundForConnectedMember(projectId); } catch { return; }
          if(round?.phase==="brainstorm"&&!round.contributions.length)this.scheduleBrainstormSuggestion(projectId,10_000);
          return;
        }
      })();
    }, delayMs);
    this.suggestionTimers.set(projectId, timer);
  }

  private errorMessage(error: unknown): string {
    if (error instanceof SummaryError) return agentErrorMessage(error.code);
    return error instanceof AuthError || error instanceof RepositoryError || error instanceof LoopError || error instanceof Error ? error.message : "Level Up could not complete that realtime command.";
  }
}
