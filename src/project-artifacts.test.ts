import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeProjectArtifacts } from "./project-artifacts";

test("removes only the selected project's workspace, snapshots, and releases",()=>{
  const root=mkdtempSync(join(tmpdir(),"level-up-artifacts-"));const project="project-12345",other="project-67890";const env={} as NodeJS.ProcessEnv;
  for(const [key,name] of [["LEVELUP_WORKSPACES_PATH","workspaces"],["LEVELUP_SNAPSHOTS_PATH","snapshots"],["LEVELUP_RELEASES_PATH","releases"]] as const){const directory=join(root,name);env[key]=directory;for(const id of [project,other]){mkdirSync(join(directory,id),{recursive:true});writeFileSync(join(directory,id,"marker"),id);}}
  removeProjectArtifacts(project,env);for(const directory of [env.LEVELUP_WORKSPACES_PATH!,env.LEVELUP_SNAPSHOTS_PATH!,env.LEVELUP_RELEASES_PATH!]){expect(existsSync(join(directory,project))).toBe(false);expect(existsSync(join(directory,other,"marker"))).toBe(true);}rmSync(root,{recursive:true,force:true});
});
