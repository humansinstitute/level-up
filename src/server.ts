import { FeedbackWorker, GooseFeedbackAgent, agentConfig } from "./feedback-agent";
import { SqliteTeamRepository } from "./storage";
import { SummaryError } from "./feedback-summary";
import { createApplication } from "./api";
import { RoundRealtimeHub, type RoundSocketData } from "./realtime";
import { adminSettings } from "./admin-settings";
import { activityLog } from "./activity-log";

const port = Number(process.env.PORT || 3000);
let hub: RoundRealtimeHub;
const application = createApplication({
  onRoundEvent: (projectId, event, round) => hub.publish(projectId, event, round),
  onRoundSnapshot: (projectId, reason) => hub.publishSnapshot(projectId, reason),
  onAdminSettingsChanged: () => hub?.rescheduleBrainstormSuggestions(),
  onProjectsDeleting: (projectIds) => hub?.stopProjects(projectIds),
});
hub = new RoundRealtimeHub(application.auth, application.repository, activityLog, () => adminSettings().brainstormSuggestionIntervalMs);
hub.startDeadlineRecovery();
const server = Bun.serve<RoundSocketData>({
  port,
  async fetch(request, bunServer) {
    const startedAt = performance.now();
    const url = new URL(request.url);
    const upgraded = hub.upgrade(request, bunServer);
    if (upgraded !== null) return upgraded;
    const response = await application.fetch(request);
    if (url.pathname.startsWith("/api/")) {
      activityLog("http.request", {
        method: request.method,
        path: url.pathname,
        status: response.status,
        durationMs: Math.round(performance.now() - startedAt),
      });
    }
    return response;
  },
  websocket: {
    open: (socket) => hub.open(socket),
    message: (socket, message) => hub.message(socket, message),
    close: (socket) => hub.close(socket),
  },
});

console.log(`Level Up listening on ${server.url}`);

if (application.repository instanceof SqliteTeamRepository) {
  let config; let configError: SummaryError | null = null;
  try { config = agentConfig(); } catch { config = agentConfig({ env: {} }); configError = new SummaryError('setup_config'); }
  const adapter = configError ? { run: async () => { throw configError; } } : new GooseFeedbackAgent(config);
  const worker = new FeedbackWorker(application.repository.loop.summaries,adapter,config,()=>hub.refreshSummaryChanges());
  worker.start();
  process.on('SIGTERM',()=>{worker.stop();hub.stopDeadlineRecovery();server.stop();});
}
