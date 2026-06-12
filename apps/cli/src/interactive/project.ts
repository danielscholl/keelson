// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { basename, isAbsolute, relative, sep } from "node:path";
import { DEFAULT_PROJECT_NAME, type Project } from "@keelson/shared";
import { HttpError } from "../http/workflow-client.ts";

// Mirrors the server's isPathInside (apps/server/src/projects-store.ts) so
// CLI-side binding picks the same project the server would resolve for a path.
export function pathContains(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function trimSlash(p: string): string {
  if (p === "/") return p;
  return p.replace(/[/\\]+$/, "");
}

export interface ProjectBinding {
  // Undefined binds to the server's default workspace project.
  projectId?: string;
  name: string;
  rootPath?: string;
  autoRegistered: boolean;
  // Set when resolution fell back (e.g. repo basename already taken).
  note?: string;
}

export interface ProjectBindingDeps {
  cwd: string;
  detectGitRoot: (cwd: string) => string | null;
  listProjects: () => Promise<Project[]>;
  createProject: (input: { name: string; rootPath: string }) => Promise<Project>;
}

// Binding rule: cwd inside a registered project (longest root wins) → that
// project; otherwise cwd inside a git repo → auto-register the repo root as a
// project named after its basename; otherwise the default workspace project.
// The binding matters because the conversation's project root becomes the
// agent's cwd on the server.
export async function resolveProjectBinding(deps: ProjectBindingDeps): Promise<ProjectBinding> {
  const projects = await deps.listProjects();
  let best: Project | undefined;
  let bestLen = -1;
  for (const project of projects) {
    if (!pathContains(project.rootPath, deps.cwd)) continue;
    const len = trimSlash(project.rootPath).length;
    if (len > bestLen) {
      best = project;
      bestLen = len;
    }
  }
  if (best) {
    return {
      projectId: best.id,
      name: best.name,
      rootPath: best.rootPath,
      autoRegistered: false,
    };
  }

  const gitRoot = deps.detectGitRoot(deps.cwd);
  if (gitRoot === null) {
    return { name: DEFAULT_PROJECT_NAME, autoRegistered: false };
  }

  const name = basename(trimSlash(gitRoot));
  try {
    const created = await deps.createProject({ name, rootPath: gitRoot });
    return {
      projectId: created.id,
      name: created.name,
      rootPath: created.rootPath,
      autoRegistered: true,
    };
  } catch (err) {
    if (err instanceof HttpError && err.status === 409) {
      return {
        name: DEFAULT_PROJECT_NAME,
        autoRegistered: false,
        note: `project name '${name}' is taken by another root; using the default workspace (rename via \`keelson project add\`)`,
      };
    }
    throw err;
  }
}

export function detectGitRoot(cwd: string): string | null {
  const res = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
    cwd,
    stdout: "pipe",
    stderr: "ignore",
  });
  if (res.exitCode !== 0) return null;
  const root = res.stdout.toString().trim();
  return root.length > 0 ? root : null;
}

export function detectGitBranch(cwd: string): string | null {
  const res = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
    cwd,
    stdout: "pipe",
    stderr: "ignore",
  });
  if (res.exitCode !== 0) return null;
  const branch = res.stdout.toString().trim();
  return branch.length > 0 ? branch : null;
}
