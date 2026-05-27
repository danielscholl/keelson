// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { existsSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  defaultWorktreeRoot,
  isGitRepo,
  listWorktrees,
  removeWorktree,
  repoPathFromWorktree,
} from "@keelson/workflows";
import { EXIT_FAIL, EXIT_OK } from "../exit.ts";
import { listProjects } from "../http/projects-client.ts";
import { isServerDownError } from "../http/workflow-client.ts";
import { emit } from "../output.ts";
import { DEFAULT_SERVER_BASE_URL } from "../server-probe.ts";

export interface WorktreePruneOptions {
  json: boolean;
  baseUrl?: string;
  dryRun: boolean;
  force: boolean;
}

interface PruneCandidate {
  path: string;
  projectName: string;
  branch: string | null;
  repoPath: string | null;
  reason: "tracked" | "orphan-no-repo" | "orphan-stale-record";
}

interface PruneResult {
  removed: string[];
  failed: { path: string; error: string }[];
  inspected: number;
}

// Walk ~/.keelson/worktrees/ and collect every worktree directory we can
// see, paired with its project's source repo (resolved via the server's
// /api/projects listing — needed to call `git worktree remove` against the
// right repo).
async function collectCandidates(baseUrl: string): Promise<PruneCandidate[]> {
  const root = defaultWorktreeRoot();
  if (!existsSync(root)) return [];
  const candidates: PruneCandidate[] = [];

  // Resolve project name → repo path. Without the server, we can still
  // remove orphan directories but `git worktree remove` won't run.
  let projects: { name: string; rootPath: string }[];
  try {
    projects = await listProjects(baseUrl);
  } catch (err) {
    if (isServerDownError(err)) {
      projects = [];
    } else {
      throw err;
    }
  }
  const repoByProject = new Map(projects.map((p) => [p.name, p.rootPath]));

  for (const projectName of readdirSync(root)) {
    const projectDir = join(root, projectName);
    try {
      if (!statSync(projectDir).isDirectory()) continue;
    } catch {
      continue;
    }
    const repoPath = repoByProject.get(projectName) ?? null;
    // If the project still exists, ask git which worktrees it considers live.
    const liveByPath = new Map<string, string | null>();
    if (repoPath !== null && (await isGitRepo(repoPath))) {
      for (const entry of await listWorktrees(repoPath)) {
        let resolved = entry.path;
        try {
          resolved = realpathSync(entry.path);
        } catch {
          // path may not exist; keep as-is
        }
        liveByPath.set(resolved, entry.branch);
      }
    }
    for (const leaf of readdirSync(projectDir)) {
      const path = join(projectDir, leaf);
      try {
        if (!statSync(path).isDirectory()) continue;
      } catch {
        continue;
      }
      let resolvedPath = path;
      try {
        resolvedPath = realpathSync(path);
      } catch {
        // path may not exist yet; keep as-is
      }
      // Recover the source repo from the worktree's .git pointer when the
      // projects catalog can't tell us. This catches two cases: (1) the
      // worktree was created from a raw `workingDir` so it never had a
      // project entry, and (2) the project was deleted between run and
      // prune. Without this, `prune --force` would `rmSync` the directory
      // but leave the source repo's `.git/worktrees/<leaf>` record behind.
      const effectiveRepoPath = repoPath ?? repoPathFromWorktree(path);
      // Re-check the live-tracked map against the recovered repo path; the
      // initial scan only filled it when we had a project-supplied repo.
      let branch = liveByPath.get(resolvedPath);
      let trackedKnown = branch !== undefined;
      if (
        effectiveRepoPath !== null &&
        effectiveRepoPath !== repoPath &&
        (await isGitRepo(effectiveRepoPath))
      ) {
        for (const entry of await listWorktrees(effectiveRepoPath)) {
          let resolvedEntry = entry.path;
          try {
            resolvedEntry = realpathSync(entry.path);
          } catch {
            // keep as-is
          }
          if (resolvedEntry === resolvedPath) {
            branch = entry.branch;
            trackedKnown = true;
            break;
          }
        }
      }
      candidates.push({
        path,
        projectName,
        branch: branch ?? null,
        repoPath: effectiveRepoPath,
        reason:
          effectiveRepoPath === null
            ? "orphan-no-repo"
            : trackedKnown
              ? "tracked"
              : "orphan-stale-record",
      });
    }
  }
  return candidates;
}

export async function runWorktreePrune(opts: WorktreePruneOptions): Promise<never> {
  const baseUrl = opts.baseUrl ?? DEFAULT_SERVER_BASE_URL;
  let candidates: PruneCandidate[];
  try {
    candidates = await collectCandidates(baseUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit({ error: `prune scan failed: ${message}`, code: "PRUNE_FAILED" }, { json: opts.json });
    process.exit(EXIT_FAIL);
  }

  if (opts.dryRun) {
    emit({ data: { candidates } }, { json: opts.json });
    process.exit(EXIT_OK);
  }

  const result: PruneResult = { removed: [], failed: [], inspected: candidates.length };
  for (const c of candidates) {
    // Worktrees on `keelson/...` branches are ones the executor created. They
    // can be safely removed even when git still tracks them — failed/cancelled
    // runs intentionally keep their entry registered for inspection, and the
    // operator pointing prune at them is the documented cleanup path.
    // Worktrees on non-`keelson/` branches are user-managed; never auto-remove
    // those even with --force, since the operator may have intentionally
    // co-located a worktree under ~/.keelson/worktrees/.
    const isManaged = c.branch === null || c.branch.startsWith("keelson/");
    if (c.reason === "tracked" && !isManaged) {
      continue;
    }
    if (c.reason === "tracked" && !opts.force) {
      // Default behavior: don't touch tracked entries — `--force` is the
      // operator saying "yes, even live worktrees" (a live run's worktree
      // would still be a tracked managed entry until the run terminates).
      continue;
    }
    if (c.reason === "tracked" && c.repoPath !== null) {
      const out = await removeWorktree({
        repoPath: c.repoPath,
        dest: c.path,
        // Tracked managed entries need --force at the git layer too: the
        // executor left the branch's worktree intact, and `git worktree
        // remove` refuses on tracked entries unless forced.
        force: true,
      });
      if (out.removed) {
        result.removed.push(c.path);
        continue;
      }
      if (out.warning !== null) {
        result.failed.push({ path: c.path, error: out.warning });
      }
      // Fall through: if `git worktree remove` failed but force is on,
      // try a plain rm so a corrupted record doesn't leave the dir forever.
      if (!opts.force) continue;
    }
    // Orphan entries (orphan-stale-record / orphan-no-repo) and tracked
    // entries that failed git removal with --force: git has no record of
    // the path, so `git worktree remove` would always fail. Use rmSync
    // directly. Orphan removal is safe without --force; tracked fall-through
    // already requires --force (checked above).
    try {
      rmSync(c.path, { recursive: true, force: true });
      result.removed.push(c.path);
    } catch (err) {
      result.failed.push({
        path: c.path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  emit({ data: result }, { json: opts.json });
  process.exit(result.failed.length === 0 ? EXIT_OK : EXIT_FAIL);
}
