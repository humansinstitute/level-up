import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import type { GameEditAgent } from "./build-agent";
import type { BuildAdapter, BuildAdapterFeatureResult, BuildAdapterInput, BuildAdapterResult, RankedProposal } from "./loop";
import { launchPlayableReleaseBrowser, validatePlayableReleaseHtml, type PlayableReleaseEvidence } from "./playable-release-validator";
import type { Browser } from "playwright";
import { activityLog } from "./activity-log";

type PlayableHtmlValidator = (input: { sourceHtml: string; gameHtml: string; releaseHtml: string; proposal: RankedProposal }) => Promise<PlayableReleaseEvidence>;

export interface LocalPlayableBuildOptions {
  templateRoot?: string;
  releaseRoot?: string;
  gameEditAgent?: GameEditAgent;
  buildBudgetMs?: number;
  playableValidator?: PlayableHtmlValidator;
}

const DEFAULT_TEMPLATE_ROOT = "public/templates";
const DEFAULT_RELEASE_ROOT = "runtime-data/releases";
const DEFAULT_BUILD_BUDGET_MS = 5 * 60 * 1000;

function htmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function jsString(value: string): string {
  return JSON.stringify(value);
}

function templateIdFromPreviewUrl(previewUrl: string): string {
  const match = previewUrl.match(/^\/templates\/([^/]+)\/index\.html$/);
  if (!match) throw new Error("unsupported_template");
  return match[1]!;
}

function safeProjectId(projectId: string): string {
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(projectId)) throw new Error("invalid_project_id");
  return projectId;
}

function injectBrief(html: string, input: BuildAdapterInput, implemented: RankedProposal, version: string): string {
  const stretch = input.brief.stretch;
  const title = `${input.projectName} - ${implemented.title}`;
  const panel = `<section class="levelup-round-brief" aria-label="Level Up round update"><strong>${htmlEscape(version.toUpperCase())}: ${htmlEscape(implemented.title)}</strong><p>${htmlEscape(implemented.playerChange)}</p><small>Round ${input.roundNumber} build. Next ideas: ${htmlEscape(stretch.filter((item) => item.id !== implemented.id).map((item) => item.title).join(" + ") || "ready for playtest feedback")}</small></section>`;
  const styles = `<style id="levelup-build-style">.levelup-round-brief{max-width:min(92vw,520px);margin:10px auto;padding:10px 12px;border:3px solid #d7f64a;background:#fffdf3;color:#171713;text-align:left;font:700 14px/1.35 system-ui}.levelup-round-brief strong{display:block;color:#566300}.levelup-round-brief p{margin:6px 0;color:#171713}.levelup-round-brief small{display:block;color:#5d5b52}</style>`;
  const script = `<script id="levelup-build-script">(()=>{const title=${jsString(title)};document.title=title;const h=document.querySelector('h1');if(h)h.textContent=title.toUpperCase();const status=document.getElementById('s');if(status&&!status.dataset.levelupBase){status.dataset.levelupBase=status.textContent||'';status.textContent=${jsString(`${implemented.title}: ${implemented.playerChange}`)};}})();</script>`;
  let output = html.replace(/<title>.*?<\/title>/i, `<title>${htmlEscape(title)}</title>`);
  output = output.replace(/<style id="levelup-build-style">[\s\S]*?<\/style>/, "");
  output = output.replace(/<script id="levelup-build-script">[\s\S]*?<\/script>/, "");
  output = output.replace(/<section class="levelup-round-brief"[\s\S]*?<\/section>/, "");
  output = output.includes("</style>") ? output.replace("</style>", `</style>${styles}`) : output.replace("</head>", `${styles}</head>`);
  output = output.includes("</main>") ? output.replace("</main>", `${panel}</main>`) : output.replace("</body>", `${panel}</body>`);
  return output.includes("</body>") ? output.replace("</body>", `${script}</body>`) : output.replace("</html>", `${script}</html>`);
}

function copyTemplateAssets(sourceDir: string, targetDir: string): void {
  mkdirSync(targetDir, { recursive: true });
  for (const name of ["index.html"]) copyFileSync(join(sourceDir, name), join(targetDir, name));
}

function stableSourceHtml(input: BuildAdapterInput, releaseRoot: string): { html: string; sourceLabel: string; baseReleaseUrl: string | null } | null {
  if (!input.previousStableUrl) return null;
  const file = releaseFile(input.previousStableUrl, releaseRoot, input.previousStableUrl);
  if (!file || !existsSync(file)) return null;
  return { html: readFileSync(file, "utf8"), sourceLabel: input.previousStableUrl, baseReleaseUrl: input.previousStableUrl };
}

export class LocalPlayableBuildAdapter implements BuildAdapter {
  readonly simulated = false;
  readonly templateRoot: string;
  readonly releaseRoot: string;
  private readonly gameEditAgent: GameEditAgent | null;
  private readonly buildBudgetMs: number;
  private readonly playableValidator: PlayableHtmlValidator | null;

  constructor(options: LocalPlayableBuildOptions = {}) {
    this.templateRoot = options.templateRoot ?? DEFAULT_TEMPLATE_ROOT;
    this.releaseRoot = options.releaseRoot ?? process.env.LEVELUP_RELEASES_PATH?.trim() ?? DEFAULT_RELEASE_ROOT;
    this.gameEditAgent = options.gameEditAgent ?? null;
    this.buildBudgetMs = options.buildBudgetMs ?? DEFAULT_BUILD_BUDGET_MS;
    this.playableValidator = options.playableValidator ?? null;
  }

  async validate(input: BuildAdapterInput): Promise<BuildAdapterResult> {
    const projectId = safeProjectId(input.projectId);
    const templateId = templateIdFromPreviewUrl(input.templatePreviewUrl);
    const sourceDir = normalize(join(this.templateRoot, templateId));
    const sourceHtml = join(sourceDir, "index.html");
    activityLog("build.local.start", { projectId, roundNumber: input.roundNumber, templateId, committedProposalId: input.brief.committed.id, stretchProposalIds: input.brief.stretch.map((item) => item.id).join(",") });
    if (!existsSync(sourceHtml)) {
      activityLog("build.local.failed", { projectId, roundNumber: input.roundNumber, templateId, error: "template_missing" });
      return { validated: false, includedProposalIds: [], deferredProposalIds: input.brief.stretch.map((item) => item.id), releaseUrl: null, failure: "Selected template source is missing." };
    }

    const stableSource = stableSourceHtml(input, this.releaseRoot);
    const html = stableSource?.html ?? readFileSync(sourceHtml, "utf8");
    const sourceLabel = stableSource?.sourceLabel ?? `/templates/${templateId}/index.html`;
    activityLog("build.local.base", { projectId, roundNumber: input.roundNumber, templateId, source: stableSource ? "stable_release" : "template", sourceLabel });
    if (!this.gameEditAgent) {
      activityLog("build.local.failed", { projectId, roundNumber: input.roundNumber, templateId, error: "game_edit_agent_missing" });
      return {
        validated: false,
        includedProposalIds: [],
        deferredProposalIds: input.brief.selected.map((item) => item.id),
        releaseUrl: null,
        failure: "Game edit agent is not configured, so no player-visible coding change was produced.",
      };
    }

    const startedAt = Date.now();
    let versionNumber = Math.max(2, this.nextVersionNumber(projectId));
    let workingHtml = html;
    let releaseUrl: string | null = null;
    const included: RankedProposal[] = [...(input.priorImplemented ?? [])];
    const deferred = input.activeProposal ? [] : [...input.brief.stretch];
    const featureResults: BuildAdapterFeatureResult[] = [];
    const candidates = input.activeProposal ? [input.activeProposal] : [input.brief.committed, input.brief.stretch[0]].filter(Boolean) as RankedProposal[];

    const browser = this.playableValidator ? null : await launchPlayableReleaseBrowser();
    try {
      for (const proposal of candidates) {
        if (!input.activeProposal && included.length > 0 && Date.now() - startedAt >= this.buildBudgetMs) break;
        const version = `v${versionNumber}`;
        try {
          activityLog("build.edit.start", { projectId, roundNumber: input.roundNumber, version, proposalId: proposal.id, rank: proposal.rank });
          const sourceBeforeEdit = workingHtml;
          const edit = await this.gameEditAgent.edit({
            projectId: input.projectId,
            projectName: input.projectName,
            templateTitle: input.templateTitle,
            version,
            sourceHtml: workingHtml,
            proposal,
            priorImplemented: included,
          });
          const result = await this.writeRelease(input, projectId, templateId, sourceDir, sourceBeforeEdit, edit.indexHtml, proposal, version, [...included, proposal], deferred.filter((item) => item.id !== proposal.id), browser, sourceLabel, stableSource?.baseReleaseUrl ?? null);
          workingHtml = result.publishedHtml;
          activityLog("build.edit.complete", { projectId, roundNumber: input.roundNumber, version, proposalId: proposal.id, outcome: result.status, releaseUrl: result.releaseUrl, durationMs: Date.now() - startedAt });
          releaseUrl = result.releaseUrl;
          included.push(proposal);
          featureResults.push({ proposalId: proposal.id, status: result.status, releaseUrl: result.releaseUrl, failure: null });
          const deferredIndex = deferred.findIndex((item) => item.id === proposal.id);
          if (deferredIndex >= 0) deferred.splice(deferredIndex, 1);
          versionNumber += 1;
        } catch (error) {
          activityLog("build.edit.failed", { projectId, roundNumber: input.roundNumber, version, proposalId: proposal.id, error: error instanceof Error ? error.message : "unknown error", committedAlready: included.length > 0 });
          if (!included.length) throw error;
          break;
        }
      }
    } finally {
      await browser?.close().catch(() => undefined);
    }

    if (!releaseUrl || !included.length) {
      activityLog("build.local.failed", { projectId, roundNumber: input.roundNumber, templateId, error: "no_playable_release" });
      return { validated: false, includedProposalIds: [], deferredProposalIds: input.brief.selected.map((item) => item.id), releaseUrl: null, failure: "Game edit agent did not produce a playable release." };
    }
    activityLog("build.local.complete", { projectId, roundNumber: input.roundNumber, templateId, includedProposalIds: included.map((item) => item.id).join(","), deferredProposalIds: deferred.map((item) => item.id).join(","), releaseUrl, durationMs: Date.now() - startedAt });
    const newlyIncluded = input.activeProposal ? [input.activeProposal.id] : included.map((item) => item.id);
    return { validated: true, includedProposalIds: newlyIncluded, deferredProposalIds: deferred.map((item) => item.id), releaseUrl, failure: null, featureResults: [...featureResults, ...deferred.map((proposal) => ({ proposalId: proposal.id, status: "deferred" as const, releaseUrl: null, failure: null }))] };
  }

  private nextVersionNumber(projectId: string): number {
    const projectRoot = normalize(join(this.releaseRoot, projectId));
    if (!existsSync(projectRoot)) return 2;
    const entries = readdirSync(projectRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && /^v\d+$/.test(entry.name)).map((entry) => Number(entry.name.slice(1)));
    const max = entries.reduce((value, entry) => Math.max(value, entry), 0);
    return max + 1;
  }

  private async writeRelease(input: BuildAdapterInput, projectId: string, templateId: string, sourceDir: string, sourceHtml: string, html: string, implemented: RankedProposal, version: string, included: RankedProposal[], deferred: RankedProposal[], browser: Browser | null, sourceLabel: string, baseReleaseUrl: string | null): Promise<{ releaseUrl: string; status: "succeeded" | "no_change"; publishedHtml: string }> {
    const targetDir = normalize(join(this.releaseRoot, projectId, version));
    if (relative(normalize(this.releaseRoot), targetDir).startsWith("..")) throw new Error("invalid_release_path");
    const candidateHtml = injectBrief(html, input, implemented, version);
    const payload = { sourceHtml, gameHtml: html, releaseHtml: candidateHtml, proposal: implemented };
    activityLog("build.validation.start", { projectId, roundNumber: input.roundNumber, version, proposalId: implemented.id });
    const evidence = this.playableValidator ? await this.playableValidator(payload) : await validatePlayableReleaseHtml(payload, browser!);
    const status = evidence.materialChanged === false ? "no_change" : "succeeded";
    const publishedHtml = status === "no_change" ? injectBrief(sourceHtml, input, implemented, version) : candidateHtml;
    activityLog("build.validation.complete", { projectId, roundNumber: input.roundNumber, version, proposalId: implemented.id, outcome: status, renderedPixels: evidence.renderedPixels, changedPixels: evidence.changedPixels, visibleTextChanged: evidence.visibleTextChanged, visibleControls: evidence.visibleControls, startupHooksPresent: evidence.startupHooksPresent });
    rmSync(targetDir, { recursive: true, force: true });
    copyTemplateAssets(sourceDir, targetDir);
    writeFileSync(join(targetDir, "index.html"), publishedHtml);
    mkdirSync(dirname(join(targetDir, "manifest.json")), { recursive: true });
    writeFileSync(join(targetDir, "manifest.json"), JSON.stringify({ schemaVersion: 2, projectId, roundNumber: input.roundNumber, version, status, statusReason: status === "no_change" ? "The feature was already present or produced no material change." : null, templateId, sourceLabel, baseReleaseUrl, implemented, included, deferred, committed: input.brief.committed, stretch: input.brief.stretch, queue: input.brief.selected, validation: evidence, builtAt: new Date().toISOString() }, null, 2));
    activityLog("build.release.written", { projectId, roundNumber: input.roundNumber, version, proposalId: implemented.id, target: targetDir, releaseUrl: `/projects/${projectId}/versions/${version}/` });
    return { releaseUrl: `/projects/${projectId}/versions/${version}/`, status, publishedHtml };
  }
}

export function releaseFile(pathname: string, releaseRoot = process.env.LEVELUP_RELEASES_PATH?.trim() || DEFAULT_RELEASE_ROOT, stablePlayUrl?: string): string | null {
  const versionMatch = pathname.match(/^\/projects\/([a-zA-Z0-9_-]{8,80})\/versions\/v(\d+)\/?$/);
  const playMatch = pathname.match(/^\/projects\/([a-zA-Z0-9_-]{8,80})\/play\/?$/);
  const projectId = versionMatch?.[1] ?? playMatch?.[1];
  if (!projectId) return null;
  const projectRoot = normalize(join(releaseRoot, projectId));
  let version = versionMatch ? `v${versionMatch[2]}` : null;
  if (!version) {
    const stableMatch = stablePlayUrl?.match(/^\/projects\/([a-zA-Z0-9_-]{8,80})\/versions\/v(\d+)\/?$/);
    if (stableMatch?.[1] === projectId) version = `v${stableMatch[2]}`;
  }
  if (!version) {
    if (!existsSync(projectRoot)) return null;
    const entries = readdirSync(projectRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && /^v\d+$/.test(entry.name)).map((entry) => entry.name);
    version = entries.sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)))[0] ?? null;
  }
  if (!version) return null;
  const file = normalize(join(projectRoot, version, "index.html"));
  return relative(projectRoot, file).startsWith("..") ? null : file;
}
