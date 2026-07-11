// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { existsSync, realpathSync } from "node:fs";
import type { WorkspaceLease } from "@keelson/shared";
import {
  createWorktree,
  type EnsureWorktreeDepsResult,
  ensureWorktreeDeps,
  isGitRepo,
  listWorktrees,
  type RemoveWorktreeOptions,
  type RemoveWorktreeResult,
  removeWorktree,
  repoPathFromWorktree,
  resolveBranchTemplate,
  resolveDefaultBranch,
  worktreePathForRepoLocal,
} from "@keelson/workflows";
import type { ProjectsStore } from "./projects-store.ts";
import type { WorkspaceLeaseRecord, WorkspaceLeaseStore } from "./workspace-lease-store.ts";

const DEFAULT_LEASE_BRANCH_TEMPLATE = "keelson/lease/{workflow}/{run_id_short}";

export class WorkspaceProjectNotFoundError extends Error {
  constructor(public readonly projectId: string) {
    super(`project not found: ${projectId}`);
    this.name = "WorkspaceProjectNotFoundError";
  }
}

export class WorkspaceProjectNotGitRepoError extends Error {
  constructor(
    public readonly projectId: string,
    public readonly rootPath: string,
  ) {
    super(`project ${projectId} is not a git repository: ${rootPath}`);
    this.name = "WorkspaceProjectNotGitRepoError";
  }
}

export class WorkspaceLeaseReleaseError extends Error {
  constructor(
    public readonly leaseId: string,
    message: string,
  ) {
    super(`workspace lease ${leaseId} release failed: ${message}`);
    this.name = "WorkspaceLeaseReleaseError";
  }
}

export interface PrepareWorktreeRequest {
  repoPath: string;
  branch: string;
  dest: string;
  base?: string | null;
  abortSignal?: AbortSignal;
}

export interface PreparedWorktree {
  worktreePath: string;
  adopted: boolean;
  branchCreated: boolean;
  deps: EnsureWorktreeDepsResult;
  depsError: string | null;
}

export interface AcquireWorkspaceManagerRequest {
  projectId: string;
  purpose: string;
  branch?: string;
  owner: string;
  abortSignal?: AbortSignal;
}

export type WorkspaceLeaseSummary = WorkspaceLeaseRecord;

export interface WorkspaceManager {
  prepareDeps(opts: {
    worktreePath: string;
    abortSignal?: AbortSignal;
  }): Promise<EnsureWorktreeDepsResult>;
  prepareWorktree(req: PrepareWorktreeRequest): Promise<PreparedWorktree>;
  removeWorktree(opts: RemoveWorktreeOptions): Promise<RemoveWorktreeResult>;
  acquire(req: AcquireWorkspaceManagerRequest): Promise<WorkspaceLease>;
  release(id: string): Promise<void>;
  list(): WorkspaceLeaseSummary[];
  reconcile(): Promise<void>;
}

function sameWorktreePath(a: string, b: string): boolean {
  try {
    const left = realpathSync.native(a);
    const right = realpathSync.native(b);
    return process.platform === "win32"
      ? left.toLowerCase() === right.toLowerCase()
      : left === right;
  } catch {
    return a === b;
  }
}

export function createWorkspaceManager({
  store,
  projectsStore,
}: {
  store: WorkspaceLeaseStore;
  projectsStore: ProjectsStore;
}): WorkspaceManager {
  const resolveRepoPath = (record: WorkspaceLeaseRecord): string | null => {
    if (record.projectId !== null) {
      const project = projectsStore.get(record.projectId);
      if (project) return project.rootPath;
    }
    return repoPathFromWorktree(record.worktreePath);
  };

  const manager: WorkspaceManager = {
    async prepareDeps(opts) {
      return ensureWorktreeDeps(opts);
    },
    async prepareWorktree(req) {
      const created = await createWorktree({
        repoPath: req.repoPath,
        branch: req.branch,
        dest: req.dest,
        ...(req.base ? { base: req.base } : {}),
      });
      const deps = await manager.prepareDeps({
        worktreePath: created.worktreePath,
        ...(req.abortSignal ? { abortSignal: req.abortSignal } : {}),
      });
      return {
        worktreePath: created.worktreePath,
        adopted: created.adopted,
        branchCreated: created.branchCreated,
        deps,
        depsError: deps.error,
      };
    },
    removeWorktree(opts) {
      return removeWorktree(opts);
    },
    async acquire(req) {
      const project = projectsStore.get(req.projectId);
      if (!project) throw new WorkspaceProjectNotFoundError(req.projectId);
      if (!(await isGitRepo(project.rootPath))) {
        throw new WorkspaceProjectNotGitRepoError(req.projectId, project.rootPath);
      }

      const id = crypto.randomUUID();
      const branch =
        req.branch ??
        resolveBranchTemplate(DEFAULT_LEASE_BRANCH_TEMPLATE, {
          workflow: req.purpose,
          runId: id,
        });
      const dest = worktreePathForRepoLocal({
        projectRootPath: project.rootPath,
        branch,
      });
      const base = await resolveDefaultBranch(project.rootPath);
      const prepared = await manager.prepareWorktree({
        repoPath: project.rootPath,
        branch,
        dest,
        base,
        ...(req.abortSignal ? { abortSignal: req.abortSignal } : {}),
      });

      try {
        store.insert({
          id,
          projectId: project.id,
          purpose: req.purpose,
          owner: req.owner,
          branch,
          worktreePath: prepared.worktreePath,
          createdAt: new Date().toISOString(),
        });
      } catch (err) {
        if (!prepared.adopted) {
          const out = await manager.removeWorktree({
            repoPath: project.rootPath,
            dest: prepared.worktreePath,
            force: true,
          });
          if (out.warning !== null) {
            console.warn(
              `[workspace] failed to clean up unrecorded lease worktree: ${out.warning}`,
            );
          }
        }
        throw err;
      }

      return {
        id,
        path: prepared.worktreePath,
        branch,
        release: () => manager.release(id),
      };
    },
    async release(id) {
      const record = store.get(id);
      if (!record) return;
      if (existsSync(record.worktreePath)) {
        const repoPath = resolveRepoPath(record);
        if (repoPath === null) {
          throw new WorkspaceLeaseReleaseError(
            id,
            `could not resolve source repo for ${record.worktreePath}`,
          );
        }
        const out = await manager.removeWorktree({
          repoPath,
          dest: record.worktreePath,
          force: true,
        });
        if (out.warning !== null) {
          throw new WorkspaceLeaseReleaseError(id, out.warning);
        }
      }
      store.delete(id);
    },
    list() {
      return store.list();
    },
    async reconcile() {
      for (const record of store.list()) {
        try {
          if (!existsSync(record.worktreePath)) {
            store.delete(record.id);
            continue;
          }
          const repoPath = resolveRepoPath(record);
          if (repoPath === null) {
            store.delete(record.id);
            continue;
          }
          const registered = (await listWorktrees(repoPath)).some((worktree) => {
            if (worktree.branch !== null && worktree.branch !== record.branch) return false;
            return sameWorktreePath(worktree.path, record.worktreePath);
          });
          if (!registered) {
            store.delete(record.id);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[workspace] failed to reconcile lease ${record.id}: ${msg}`);
        }
      }
    },
  };

  return manager;
}
