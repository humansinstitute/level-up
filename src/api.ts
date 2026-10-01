import { AuthError, AuthService, configuredAllowedNpubs, configuredOwnerNpub, requestOrigin, type SessionRecord } from "./auth";
import { buildInviteUrl } from "./invites";
import { RepositoryError, SqliteTeamRepository, type Account, type RoundEvent, type TeamRepository } from "./storage";
import { SummaryError, agentErrorMessage } from "./feedback-summary";
import { LoopError } from "./loop";
import { releaseFile } from "./local-build-adapter";
import { GooseBrainstormSuggestionGenerator, GooseProposalGenerator, proposalAgentConfig } from "./proposal-agent";
import { GooseWorkspaceCodingAgent, WorkspaceBuildAdapter } from "./game-workspace-builder";
import { agentPromptRecords, resetAgentPrompt, saveAgentPrompt, saveAgentPromptModel } from "./admin-prompts";
import { adminSettings, saveAdminSettings } from "./admin-settings";
import { configureAgentTraceStore } from "./agent-trace";
import { removeProjectArtifacts } from "./project-artifacts";

export interface AppOptions {
  auth?: AuthService;
  repository?: TeamRepository;
  staticRoot?: string;
  onRoundEvent?: (projectId: string, event: RoundEvent, round: ReturnType<TeamRepository["round"]>) => void;
  onRoundSnapshot?: (projectId: string, reason: "proposal_generation_started" | "proposal_generation_failed") => void;
  onAdminSettingsChanged?: () => void;
  onProjectsDeleting?: (projectIds: string[]) => void | Promise<void>;
  teamCreatorNpub?: string;
  ownerNpub?: string;
}

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...securityHeaders(), ...headers },
  });
}

function securityHeaders(): Record<string, string> {
  return {
    "Content-Security-Policy": "default-src 'self'; base-uri 'none'; connect-src 'self' wss://relay.primal.net wss://nos.lol wss://purplepag.es; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data: https:; object-src 'none'; script-src 'self'; style-src 'self'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}

function staticHeaders(pathname: string): Record<string, string> {
  const cacheHeaders = pathname.startsWith("/assets/")
    ? { "Cache-Control": "public, max-age=31536000, immutable" }
    : { "Cache-Control": "no-cache" };
  if (!pathname.startsWith("/templates/")) return { ...securityHeaders(), ...cacheHeaders };
  return {
    ...securityHeaders(),
    ...cacheHeaders,
    "Content-Security-Policy": "default-src 'none'; base-uri 'none'; connect-src 'none'; form-action 'none'; frame-ancestors 'self'; img-src 'self' data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
  };
}

async function bodyJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const serialized = await request.text();
    if (serialized.length > 64 * 1024) {
      throw new AuthError("request_too_large", "The request body is too large.", 413);
    }
    const body: unknown = JSON.parse(serialized);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError("invalid_request", "A valid JSON request body is required.", 400);
  }
}

function isSecureRequest(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  return forwarded === "https" || new URL(request.url).protocol === "https:";
}

function methodNotAllowed(allowed: string): Response {
  return json({ ok: false, error: "method_not_allowed" }, 405, { Allow: allowed });
}

function configuredAccessMode(value: string | undefined): "open" | "restricted" {
  return value?.trim().toLowerCase() === "restricted" ? "restricted" : "open";
}

function requireSession(auth: AuthService, request: Request): SessionRecord {
  const session = auth.readSession(request.headers.get("cookie"));
  if (!session) throw new AuthError("unauthenticated", "Sign in with Nostr to continue.", 401);
  return session;
}

function accountForSession(repository: TeamRepository, session: SessionRecord): Account {
  return repository.accountForNostr(session.pubkey, session.npub);
}

function requireAdminSession(auth: AuthService, request: Request, ownerNpub: string): SessionRecord {
  const session = requireSession(auth, request);
  if (session.npub !== ownerNpub) throw new AuthError("forbidden", "Admin mode is only available to the Level Up owner.", 403);
  return session;
}

export function createApplication(options: AppOptions = {}) {
  const ownerNpub = options.ownerNpub?.trim() || options.teamCreatorNpub?.trim() || configuredOwnerNpub();
  const repository = options.repository ?? new SqliteTeamRepository(
    process.env.LEVELUP_DATABASE_PATH?.trim() || "runtime-data/levelup.sqlite",
    { ownerNpub, selectionDurationSeconds: Number(process.env.TEMPLATE_SELECTION_SECONDS) || undefined, brainstormDurationSeconds: Number(process.env.ROUND_BRAINSTORM_SECONDS) || undefined, votingDurationSeconds: Number(process.env.ROUND_VOTING_SECONDS) || undefined, proposalGenerator: new GooseProposalGenerator(proposalAgentConfig()), brainstormSuggestionGenerator: new GooseBrainstormSuggestionGenerator(proposalAgentConfig()), brainstormSuggestionIntervalMs: () => adminSettings().brainstormSuggestionIntervalMs, buildAdapter: new WorkspaceBuildAdapter({ agent: new GooseWorkspaceCodingAgent(proposalAgentConfig()) }) },
  );
  const auth = options.auth ?? new AuthService({
    challengeTtlSeconds: Number(process.env.LOGIN_CHALLENGE_TTL_SECONDS) || 90,
    sessionTtlSeconds: Number(process.env.SESSION_TTL_SECONDS) || 8 * 60 * 60,
    accessMode: configuredAccessMode(process.env.WAPP_ACCESS_MODE),
    allowedNpubs: configuredAllowedNpubs(),
    sessionStore: repository,
  });
  if (!options.repository) configureAgentTraceStore(repository);
  const staticRoot = options.staticRoot ?? new URL("../dist", import.meta.url).pathname;

  const fetchApp = async function fetchApp(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/health") {
        if (request.method !== "GET") return methodNotAllowed("GET");
        return json({ ok: true, app: "level-up", status: "ready" });
      }
      if (url.pathname === "/api/auth/challenge") {
        if (request.method !== "POST") return methodNotAllowed("POST");
        const body = await bodyJson(request);
        return json(auth.issueChallenge(String(body.pubkey ?? ""), requestOrigin(request)));
      }
      if (url.pathname === "/api/auth/login") {
        if (request.method !== "POST") return methodNotAllowed("POST");
        const body = await bodyJson(request);
        const { sessionId, session } = auth.login(body, requestOrigin(request));
        const account = accountForSession(repository, session);
        return json(
          { ok: true, user: { npub: account.npub }, team: repository.currentTeam(account.id) },
          200,
          { "Set-Cookie": auth.sessionCookie(sessionId, isSecureRequest(request)) },
        );
      }
      if (url.pathname === "/api/me") {
        if (request.method !== "GET") return methodNotAllowed("GET");
        const session = requireSession(auth, request);
        const account = accountForSession(repository, session);
        return json({ ok: true, user: { npub: account.npub }, team: repository.currentTeam(account.id) });
      }
      if (url.pathname === "/api/admin/agent-prompts") {
        requireAdminSession(auth, request, ownerNpub);
        if (request.method === "GET") {
          const settings = adminSettings();
          return json({ ok: true, prompts: agentPromptRecords().map((prompt) => ({ ...prompt, effectiveModel: prompt.model ?? settings.defaultModel })) });
        }
        if (request.method !== "PUT") return methodNotAllowed("GET, PUT");
        const body = await bodyJson(request);
        if (typeof body.stageId !== "string") return json({ ok: false, error: "invalid_request", message: "Choose a prompt stage to update." }, 400);
        try {
          const prompt = body.modelMode !== undefined
            ? saveAgentPromptModel(body.stageId, body.modelMode === "default" ? null : typeof body.model === "string" ? body.model : "", adminSettings().allowedModels)
            : body.reset === true
            ? resetAgentPrompt(body.stageId)
            : saveAgentPrompt(body.stageId, typeof body.template === "string" ? body.template : "");
          return json({ ok: true, prompt: { ...prompt, effectiveModel: prompt.model ?? adminSettings().defaultModel } });
        } catch (error) {
          const code = error instanceof Error ? error.message : "invalid_prompt_template";
          const message = code === "unknown_prompt_stage"
            ? "That prompt stage is not recognised."
            : code === "model_not_allowed" ? "Choose the default model or one model from the current allowlist."
            : "Prompt templates must be 120 to 12,000 characters and include {{inputJson}}.";
          return json({ ok: false, error: code, message }, 400);
        }
      }
      if (url.pathname === "/api/admin/settings") {
        requireAdminSession(auth, request, ownerNpub);
        if (request.method === "GET") return json({ ok: true, settings: adminSettings() });
        if (request.method !== "PUT") return methodNotAllowed("GET, PUT");
        const body = await bodyJson(request);
        try {
          const settings = saveAdminSettings({ brainstormSuggestionIntervalSeconds: body.brainstormSuggestionIntervalSeconds, agentMaxTurns: body.agentMaxTurns, proposalVoteAllowance: body.proposalVoteAllowance, allowedModels: body.allowedModels, defaultModel: body.defaultModel });
          options.onAdminSettingsChanged?.();
          return json({ ok: true, settings });
        } catch (error) {
          const code = error instanceof Error ? error.message : "invalid_settings";
          return json({
            ok: false,
            error: code,
            message: code === "assigned_model_not_allowed" ? "A prompt stage still uses a model you are trying to remove. Change that stage to the default or another allowed model first." : "Choose 5 to 600 seconds, 1 to 5 Goose turns, 1 to 20 proposal vote tokens, and 1 to 24 unique OpenRouter provider/model IDs with one allowed default.",
          }, 400);
        }
      }
      if (url.pathname === "/api/admin/projects") {
        requireAdminSession(auth, request, ownerNpub);
        if (request.method !== "GET") return methodNotAllowed("GET");
        return json({ ok: true, projects: repository.adminProjects() });
      }
      if (url.pathname === "/api/admin/teams") {
        requireAdminSession(auth, request, ownerNpub);
        if (request.method !== "GET") return methodNotAllowed("GET");
        return json({ ok: true, teams: repository.adminTeams() });
      }
      const adminProjectDeleteMatch = url.pathname.match(/^\/api\/admin\/projects\/([^/]+)$/);
      if (adminProjectDeleteMatch) {
        if (request.method !== "DELETE") return methodNotAllowed("DELETE");
        const session = requireAdminSession(auth, request, ownerNpub);
        const account = accountForSession(repository, session);
        const projectId = decodeURIComponent(adminProjectDeleteMatch[1]!);
        await options.onProjectsDeleting?.([projectId]);
        await repository.cancelProjectWork(projectId);
        const result = repository.adminDeleteProject(projectId, account.id);
        removeProjectArtifacts(projectId);
        return json({ ok: true, ...result });
      }
      const adminTeamDeleteMatch = url.pathname.match(/^\/api\/admin\/teams\/([^/]+)$/);
      if (adminTeamDeleteMatch) {
        if (request.method !== "DELETE") return methodNotAllowed("DELETE");
        const session = requireAdminSession(auth, request, ownerNpub);
        const account = accountForSession(repository, session);
        const teamId = decodeURIComponent(adminTeamDeleteMatch[1]!);
        const projectIds = repository.adminTeamProjectIds(teamId, account.id);
        await options.onProjectsDeleting?.(projectIds);
        await Promise.all(projectIds.map((projectId) => repository.cancelProjectWork(projectId)));
        const result = repository.adminDeleteTeam(teamId, account.id);
        for (const projectId of result.deletedProjectIds) removeProjectArtifacts(projectId);
        return json({ ok: true, ...result });
      }
      if (url.pathname === "/api/admin/group-run") {
        const session=requireAdminSession(auth,request,ownerNpub);const account=accountForSession(repository,session);
        if(request.method==="GET")return json({ok:true,run:repository.groupRun()});
        if(request.method!=="PUT")return methodNotAllowed("GET, PUT");
        const body=await bodyJson(request);const projectIds=Array.isArray(body.projectIds)?body.projectIds.filter((value):value is string=>typeof value==="string"):[];
        return json({ok:true,run:repository.saveGroupRun(account.id,{name:typeof body.name==="string"?body.name:"",projectIds})});
      }
      if (url.pathname === "/api/admin/group-run/commands") {
        const session=requireAdminSession(auth,request,ownerNpub);const account=accountForSession(repository,session);if(request.method!=="POST")return methodNotAllowed("POST");const body=await bodyJson(request);
        const commands=new Set(["open_play","start_voting","extend_voting","close_voting","start_first_brainstorm","pause","resume"]);
        if(typeof body.command!=="string"||!commands.has(body.command)||typeof body.requestId!=="string")return json({ok:false,error:"invalid_group_command",message:"Choose a valid Group Mode action."},400);
        return json({ok:true,...repository.runGroupCommand(account.id,body.command as import("./storage").GroupCommand,body.requestId)});
      }
      if (url.pathname === "/api/admin/agent-runs") {
        requireAdminSession(auth, request, ownerNpub);
        if (request.method !== "GET") return methodNotAllowed("GET");
        const projectId = url.searchParams.get("projectId");
        const runs = repository.listAgentTraces(projectId);
        return json({ ok: true, runs });
      }
      if (url.pathname === "/api/auth/logout") {
        if (request.method !== "POST") return methodNotAllowed("POST");
        auth.logout(request.headers.get("cookie"));
        return json(
          { ok: true },
          200,
          { "Set-Cookie": auth.clearSessionCookie(isSecureRequest(request)) },
        );
      }
      if (url.pathname === "/api/teams") {
        const session = requireSession(auth, request);
        const account = accountForSession(repository, session);
        if (request.method === "GET") {
          return json({ ok: true, teams: repository.teamsForAccount(account.id) });
        }
        if (request.method !== "POST") return methodNotAllowed("GET, POST");
        if (session.npub !== ownerNpub) {
          throw new AuthError("forbidden", "New team creation is currently limited to Pete.", 403);
        }
        const body = await bodyJson(request);
        const created = repository.createTeam(account.id, typeof body.name === "string" ? body.name : "");
        return json({
          ok: true,
          team: created.team,
          invite: { ...created.invite, url: buildInviteUrl(requestOrigin(request), created.invite.secret) },
        }, 201);
      }
      if (url.pathname === "/api/profiles") {
        const session = requireSession(auth, request);
        const account = accountForSession(repository, session);
        if (request.method === "GET") {
          const pubkeys = url.searchParams.getAll("pubkey");
          return json({ ok: true, profiles: repository.profilesForAccount(account.id, pubkeys) });
        }
        if (request.method !== "PUT") return methodNotAllowed("GET, PUT");
        const body = await bodyJson(request);
        const events = Array.isArray(body.events) ? body.events : body.event ? [body.event] : [];
        return json({ ok: true, profiles: repository.cacheProfiles(account.id, events) });
      }
      if (url.pathname === "/api/team-invites/redeem") {
        if (request.method !== "POST") return methodNotAllowed("POST");
        const session = requireSession(auth, request);
        const account = accountForSession(repository, session);
        const body = await bodyJson(request);
        const joined = repository.redeemInvite(account.id, typeof body.secret === "string" ? body.secret.trim() : "");
        return json({ ok: true, team: joined.team, alreadyMember: joined.alreadyMember });
      }

      const lobbyMatch = url.pathname.match(/^\/api\/teams\/([^/]+)\/lobby$/);
      if (lobbyMatch) {
        if (request.method !== "GET") return methodNotAllowed("GET");
        const session = requireSession(auth, request);
        const account = accountForSession(repository, session);
        const team = repository.lobby(decodeURIComponent(lobbyMatch[1]!), account.id);
        if (!team) throw new RepositoryError("forbidden", "You are not a member of that team.", 403);
        const invite = repository.activeInvite(team.id, account.id);
        return json({ ok: true, team, invite: { ...invite, url: buildInviteUrl(requestOrigin(request), invite.secret) } });
      }

      const rotateMatch = url.pathname.match(/^\/api\/teams\/([^/]+)\/invites\/rotate$/);
      if (rotateMatch) {
        if (request.method !== "POST") return methodNotAllowed("POST");
        const session = requireSession(auth, request);
        const account = accountForSession(repository, session);
        const invite = repository.rotateInvite(decodeURIComponent(rotateMatch[1]!), account.id);
        return json({ ok: true, invite: { ...invite, url: buildInviteUrl(requestOrigin(request), invite.secret) } }, 201);
      }

      const createProjectMatch = url.pathname.match(/^\/api\/teams\/([^/]+)\/projects$/);
      if (createProjectMatch) {
        if (request.method !== "POST") return methodNotAllowed("POST");
        const session = requireSession(auth, request);
        const account = accountForSession(repository, session);
        const body = await bodyJson(request);
        const project = repository.createProject(
          decodeURIComponent(createProjectMatch[1]!),
          account.id,
          typeof body.name === "string" ? body.name : "",
          request.headers.get("idempotency-key") ?? "",
        );
        return json({ ok: true, project }, 201);
      }

      const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
      if (projectMatch) {
        if (request.method !== "GET" && request.method !== "DELETE") return methodNotAllowed("GET, DELETE");
        const session = requireSession(auth, request);
        const account = accountForSession(repository, session);
        const projectId = decodeURIComponent(projectMatch[1]!);
        if (request.method === "DELETE") {
          await options.onProjectsDeleting?.([projectId]);
          await repository.cancelProjectWork(projectId);
          const result=repository.deleteProject(projectId, account.id);
          removeProjectArtifacts(projectId);
          return json({ ok: true, ...result });
        }
        return json({ ok: true, project: repository.project(projectId, account.id) });
      }

      const selectionsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/template-selections$/);
      if (selectionsMatch) {
        if (request.method !== "PUT") return methodNotAllowed("PUT");
        const session = requireSession(auth, request);
        const account = accountForSession(repository, session);
        const body = await bodyJson(request);
        const templateIds = Array.isArray(body.templateIds) && body.templateIds.every((value) => typeof value === "string") ? body.templateIds : [];
        return json({ ok: true, project: repository.replaceTemplateSelections(decodeURIComponent(selectionsMatch[1]!), account.id, templateIds as string[]) });
      }

      const startSelectionMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/template-selection\/start$/);
      if (startSelectionMatch) {
        if (request.method !== "POST") return methodNotAllowed("POST");
        const session = requireSession(auth, request);
        const account = accountForSession(repository, session);
        return json({ ok: true, project: repository.startTemplateSelection(decodeURIComponent(startSelectionMatch[1]!), account.id) });
      }

      const closeSelectionMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/template-selection\/close$/);
      if (closeSelectionMatch) {
        if (request.method !== "POST") return methodNotAllowed("POST");
        const session = requireSession(auth, request);
        const account = accountForSession(repository, session);
        return json({ ok: true, project: repository.closeTemplateSelection(decodeURIComponent(closeSelectionMatch[1]!), account.id) });
      }

      const resolveTieMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/template-selection\/resolve$/);
      if (resolveTieMatch) {
        if (request.method !== "POST") return methodNotAllowed("POST");
        const session = requireSession(auth, request);
        const account = accountForSession(repository, session);
        const body = await bodyJson(request);
        return json({ ok: true, project: repository.resolveTemplateTie(decodeURIComponent(resolveTieMatch[1]!), account.id, typeof body.templateId === "string" ? body.templateId : "") });
      }

      const roundMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/rounds\/(\d+)$/);
      if (roundMatch) {
        if (request.method !== "GET") return methodNotAllowed("GET");
        const session = requireSession(auth, request);
        const account = accountForSession(repository, session);
        return json({ ok: true, round: repository.round(decodeURIComponent(roundMatch[1]!), account.id, Number(roundMatch[2])) });
      }

      const eventsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/rounds\/(\d+)\/events$/);
      if (eventsMatch) {
        if (request.method !== "GET") return methodNotAllowed("GET");
        const session = requireSession(auth, request);
        const account = accountForSession(repository, session);
        const after = Number(url.searchParams.get("after") ?? "0");
        return json({ ok: true, ...repository.roundEvents(decodeURIComponent(eventsMatch[1]!), account.id, Number.isSafeInteger(after) ? after : 0, Number(eventsMatch[2])) });
      }

      const contributionMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/rounds\/(\d+)\/contributions$/);
      if (contributionMatch) {
        if (request.method !== "POST") return methodNotAllowed("POST");
        const session = requireSession(auth, request);
        const account = accountForSession(repository, session);
        const body = await bodyJson(request);
        const projectId = decodeURIComponent(contributionMatch[1]!);
        const result = repository.submitContribution(projectId, account.id, typeof body.clientEventId === "string" ? body.clientEventId : "", typeof body.body === "string" ? body.body : "", Number(contributionMatch[2]), Array.isArray(body.attachments) ? body.attachments : []);
        if (!result.duplicate && result.event) options.onRoundEvent?.(projectId, result.event, result.round);
        return json({ ok: true, ...result }, result.duplicate ? 200 : 201);
      }

      const closeBrainstormMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/rounds\/(\d+)\/brainstorm\/close$/) ?? url.pathname.match(/^\/api\/projects\/([^/]+)\/rounds\/(\d+)\/close$/);
      if (closeBrainstormMatch) {
        if (request.method !== "POST") return methodNotAllowed("POST");
        const session = requireSession(auth, request);
        const account = accountForSession(repository, session);
        const projectId = decodeURIComponent(closeBrainstormMatch[1]!);
        const result = repository.closeBrainstorm(projectId, account.id, Number(closeBrainstormMatch[2]));
        if (result instanceof Promise) {
          options.onRoundSnapshot?.(projectId, "proposal_generation_started");
          void result.then((completed) => {
            if (completed.event) options.onRoundEvent?.(projectId, completed.event, completed.round);
          }).catch(() => { options.onRoundSnapshot?.(projectId, "proposal_generation_failed"); });
          return json({ ok: true, accepted: true, duplicate: false, event: null, round: repository.round(projectId, account.id, Number(closeBrainstormMatch[2])) }, 202);
        }
        if (result.event) options.onRoundEvent?.(projectId, result.event, result.round);
        return json({ ok: true, ...result });
      }

      const proposalVotesMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/rounds\/(\d+)\/proposal-votes$/);
      if (proposalVotesMatch) {
        if (request.method !== "PUT") return methodNotAllowed("PUT");
        const session=requireSession(auth,request); const account=accountForSession(repository,session); const body=await bodyJson(request); const projectId=decodeURIComponent(proposalVotesMatch[1]!);
        const ids=Array.isArray(body.proposalIds)&&body.proposalIds.every((x)=>typeof x==="string")?body.proposalIds as string[]:[];
        const result=repository.replaceProposalVotes(projectId,account.id,ids,Number(proposalVotesMatch[2]));
        return json({ok:true,...result});
      }
      const closeProposalMatch=url.pathname.match(/^\/api\/projects\/([^/]+)\/rounds\/(\d+)\/voting\/close$/);
      if(closeProposalMatch){ if(request.method!=="POST")return methodNotAllowed("POST"); const session=requireSession(auth,request);const account=accountForSession(repository,session);const projectId=decodeURIComponent(closeProposalMatch[1]!);const result=repository.closeProposalVoting(projectId,account.id,Number(closeProposalMatch[2]));if(result.event)options.onRoundEvent?.(projectId,result.event,result.round);return json({ok:true,...result}); }
      const beginVotingMatch=url.pathname.match(/^\/api\/projects\/([^/]+)\/rounds\/(\d+)\/voting$/);
      if(beginVotingMatch){if(request.method!=="POST")return methodNotAllowed("POST");const session=requireSession(auth,request);const account=accountForSession(repository,session);const projectId=decodeURIComponent(beginVotingMatch[1]!);const result=repository.beginProposalVoting(projectId,account.id,Number(beginVotingMatch[2]));if(result.event)options.onRoundEvent?.(projectId,result.event,result.round);return json({ok:true,...result});}
      const startBuildMatch=url.pathname.match(/^\/api\/projects\/([^/]+)\/rounds\/(\d+)\/build$/);
      if(startBuildMatch){if(request.method!=="POST")return methodNotAllowed("POST");const session=requireSession(auth,request);const account=accountForSession(repository,session);const projectId=decodeURIComponent(startBuildMatch[1]!);const result=repository.startBuild(projectId,account.id,Number(startBuildMatch[2]));if(result.event)options.onRoundEvent?.(projectId,result.event,result.round);return json({ok:true,...result});}
      const reportBuildMatch=url.pathname.match(/^\/api\/projects\/([^/]+)\/rounds\/(\d+)\/build\/report$/);
      if(reportBuildMatch){if(request.method!=="POST")return methodNotAllowed("POST");const session=requireSession(auth,request);const account=accountForSession(repository,session);const body=await bodyJson(request);const projectId=decodeURIComponent(reportBuildMatch[1]!);const result=repository.reportBuildProblem(projectId,account.id,typeof body.note==="string"?body.note:"",Number(reportBuildMatch[2]));if(result.event)options.onRoundEvent?.(projectId,result.event,result.round);return json({ok:true,...result},202);}
      const deferBuildMatch=url.pathname.match(/^\/api\/projects\/([^/]+)\/rounds\/(\d+)\/build\/defer$/);
      if(deferBuildMatch){if(request.method!=="POST")return methodNotAllowed("POST");const session=requireSession(auth,request);const account=accountForSession(repository,session);const projectId=decodeURIComponent(deferBuildMatch[1]!);const result=repository.deferInterruptedFeature(projectId,account.id,Number(deferBuildMatch[2]));if(result.event)options.onRoundEvent?.(projectId,result.event,result.round);return json({ok:true,...result},202);}
      const brainstormMoreMatch=url.pathname.match(/^\/api\/projects\/([^/]+)\/rounds\/(\d+)\/brainstorm-more$/);
      if(brainstormMoreMatch){if(request.method!=="POST")return methodNotAllowed("POST");const session=requireSession(auth,request);const account=accountForSession(repository,session);const projectId=decodeURIComponent(brainstormMoreMatch[1]!);const result=repository.startSuccessorBrainstorm(projectId,account.id,Number(brainstormMoreMatch[2]));if(result.event)options.onRoundEvent?.(projectId,result.event,result.round);return json({ok:true,...result},result.duplicate?200:202);}

      if (url.pathname.startsWith("/api/")) {
        return json({ ok: false, error: "not_found" }, 404);
      }

      const playMatch = url.pathname.match(/^\/projects\/([a-zA-Z0-9_-]{8,80})\/play\/?$/);
      const stablePlayUrl = playMatch ? repository.stablePlayUrl(playMatch[1]!) : null;
      const playableRelease = releaseFile(url.pathname, undefined, stablePlayUrl ?? undefined);
      if (playableRelease) {
        const file = Bun.file(playableRelease);
        if (await file.exists()) return new Response(file, { headers: staticHeaders("/templates/generated/index.html") });
      }

      const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
      const decodedPath = decodeURIComponent(requestedPath);
      if (decodedPath.includes("\0") || decodedPath.split("/").includes("..")) {
        return new Response("Not found", { status: 404 });
      }
      const file = Bun.file(`${staticRoot}${decodedPath}`);
      if (await file.exists()) return new Response(file, { headers: staticHeaders(decodedPath) });
      if (!decodedPath.includes(".")) {
        const index = Bun.file(`${staticRoot}/index.html`);
        if (await index.exists()) return new Response(index, { headers: securityHeaders() });
      }
      return new Response("Not found", { status: 404 });
    } catch (error) {
      if (error instanceof SummaryError) return json({ok:false,error:error.code,message:agentErrorMessage(error.code),correction:error.correction},409);
      if (error instanceof AuthError || error instanceof RepositoryError || error instanceof LoopError) {
        return json({ ok: false, error: error.code, message: error.message }, error.status);
      }
      console.error("Level Up request failed", error instanceof Error ? error.message : "unknown error");
      return json({ ok: false, error: "internal_error" }, 500);
    }
  };
  return { auth, repository, fetch: fetchApp };
}

export function createApp(options: AppOptions = {}) {
  return createApplication(options).fetch;
}
