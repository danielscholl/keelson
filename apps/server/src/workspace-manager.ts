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
  listWorktreesWithStatus,
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
  rejectAdopted?: boolean;
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

function slugPurposeForBranch(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "workspace";
}

export function createWorkspaceManager({
  store,
  projectsStore,
}: {
  store: WorkspaceLeaseStore;
  projectsStore: ProjectsStore;
}): WorkspaceManager {
  const pendingAcquisitions = new Set<string>();
  const releasesInFlight = new Map<string, Promise<void>>();
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
      // Adoption must be rejected before prepareDeps: bun install runs
      // lifecycle scripts, which must never execute inside another owner's
      // checkout (an active workflow worktree).
      if (req.rejectAdopted === true && created.adopted) {
        throw new Error(
          `workspace destination already exists at ${req.dest} — refusing to adopt another owner's checkout`,
        );
      }
      try {
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
      } catch (err) {
        if (!created.adopted) {
          await removeWorktree({
            repoPath: req.repoPath,
            dest: created.worktreePath,
            force: true,
          });
        }
        throw err;
      }
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
          workflow: slugPurposeForBranch(req.purpose),
          runId: id,
        });
      const dest = worktreePathForRepoLocal({
        projectRootPath: project.rootPath,
        branch,
      });
      const createdAt = new Date().toISOString();

      pendingAcquisitions.add(id);
      try {
        store.insert({
          id,
          projectId: project.id,
          purpose: req.purpose,
          owner: req.owner,
          branch,
          worktreePath: dest,
          createdAt,
          status: "pending",
        });

        let prepared: PreparedWorktree | null = null;

        try {
          const base = await resolveDefaultBranch(project.rootPath);
          prepared = await manager.prepareWorktree({
            repoPath: project.rootPath,
            branch,
            dest,
            base,
            rejectAdopted: true,
            ...(req.abortSignal ? { abortSignal: req.abortSignal } : {}),
          });
          if (prepared.depsError !== null) {
            throw new Error(`workspace dependency install failed: ${prepared.depsError}`);
          }
          if (prepared.deps.skipped === "aborted") {
            throw new Error("workspace acquisition aborted during dependency preparation");
          }
        } catch (err) {
          // Remove the checkout before the row: a row without a checkout is a
          // reconcilable no-op, but a checkout without a row is untracked and
          // unreleasable — so on cleanup failure the row stays for a retry.
          let cleanupOk = true;
          if (prepared !== null && !prepared.adopted) {
            const out = await manager.removeWorktree({
              repoPath: project.rootPath,
              dest: prepared.worktreePath,
              force: true,
            });
            if (out.warning !== null) {
              cleanupOk = false;
              console.warn(
                `[workspace] failed to clean up lease worktree ${id}; keeping its row for release retry: ${out.warning}`,
              );
            }
          }
          if (cleanupOk) {
            try {
              store.delete(id);
            } catch (cleanupErr) {
              console.warn(
                `[workspace] failed to delete lease row ${id} after acquisition failure: ${
                  cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
                }`,
              );
            }
          }
          throw err;
        }

        store.markActive(id);
        return {
          id,
          path: prepared.worktreePath,
          branch,
          release: () => manager.release(id),
        };
      } finally {
        pendingAcquisitions.delete(id);
      }
    },
    async release(id) {
      if (pendingAcquisitions.has(id)) {
        throw new WorkspaceLeaseReleaseError(id, "acquisition still in progress");
      }
      const inFlight = releasesInFlight.get(id);
      if (inFlight) return inFlight;
      const run = (async () => {
        try {
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
        } finally {
          releasesInFlight.delete(id);
        }
      })();
      releasesInFlight.set(id, run);
      return run;
    },
    list() {
      return store.list();
    },
    async reconcile() {
      for (const record of store.list()) {
        try {
          // A pending row is a crashed acquisition: the caller never received
          // the lease, so remove whatever half-prepared checkout exists.
          if (record.status === "pending") {
            if (existsSync(record.worktreePath)) {
              const repoPath = resolveRepoPath(record);
              if (repoPath === null) {
                console.warn(
                  `[workspace] cannot resolve repo for pending lease ${record.id}; keeping its row`,
                );
                continue;
              }
              const out = await manager.removeWorktree({
                repoPath,
                dest: record.worktreePath,
                force: true,
              });
              if (out.warning !== null) {
                console.warn(
                  `[workspace] failed to remove pending lease worktree ${record.id}; keeping its row: ${out.warning}`,
                );
                continue;
              }
            }
            store.delete(record.id);
            continue;
          }
          if (!existsSync(record.worktreePath)) {
            store.delete(record.id);
            continue;
          }
          const repoPath = resolveRepoPath(record);
          if (repoPath === null) {
            store.delete(record.id);
            continue;
          }
          const listed = await listWorktreesWithStatus(repoPath);
          if (listed.error !== null) {
            throw new Error(`could not determine worktree registration: ${listed.error}`);
          }
          // Match on path alone: the holder may validly switch branches inside
          // its checkout, so a branch mismatch refreshes the row, never drops it.
          const registered = listed.worktrees.find((worktree) =>
            sameWorktreePath(worktree.path, record.worktreePath),
          );
          if (registered === undefined) {
            store.delete(record.id);
          } else if (registered.branch !== null && registered.branch !== record.branch) {
            store.updateBranch(record.id, registered.branch);
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
