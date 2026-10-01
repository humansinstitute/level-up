import { existsSync, rmSync } from "node:fs";
import { join, normalize, resolve } from "node:path";

function projectSegment(projectId: string): string {
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(projectId)) throw new Error("invalid_project_id");
  return projectId;
}

export function removeProjectArtifacts(projectId: string, env: NodeJS.ProcessEnv = process.env): void {
  const segment = projectSegment(projectId);
  const roots = [
    env.LEVELUP_WORKSPACES_PATH?.trim() || "runtime-data/workspaces",
    env.LEVELUP_SNAPSHOTS_PATH?.trim() || "runtime-data/source-snapshots",
    env.LEVELUP_RELEASES_PATH?.trim() || "runtime-data/releases",
  ];
  for (const configuredRoot of roots) {
    const root = resolve(configuredRoot);
    const target = normalize(join(root, segment));
    if (!target.startsWith(`${root}/`)) throw new Error("artifact_path_escape");
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  }
}
