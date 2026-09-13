// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { existsSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { type Project, TERMINAL_RUN_STATUSES } from "@keelson/shared";
import {
  deleteBranch,
  isGitRepo,
  listWorktrees,
  removeWorktree,
  repoPathFromWorktree,
} from "@keelson/workflows";
import { EXIT_FAIL, EXIT_OK } from "../exit.ts";
import { listProjects } from "../http/projects-client.ts";
import { isServerDownError, listPersistedWorktrees } from "../http/workflow-client.ts";
import { emit } from "../output.ts";
import { defaultServerBaseUrl } from "../server-probe.ts";

// Canonical form for path comparison only (never display): realpath resolves
// symlinks, then we normalize separators and (Windows only) case. Without it, a
// worktree git lists and the same dir we walk can compare unequal on Windows
// (slash direction, drive-letter case), mis-classifying tracked worktrees as
// orphans that prune would rm.
function canonicalForCompare(p: string): string {
  let resolved = p;
  try {
    resolved = realpathSync(p);
  } catch {
    // path may not exist; canonicalize the raw form
  }
  const slashed = resolved.replaceAll("\\", "/");
  return process.platform === "win32" ? slashed.toLowerCase() : slashed;
}

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
  // Status of the run that owns this worktree, from the server's run table.
  // null when the server is down or no run recorded the path.
  runStatus: string | null;
}

interface PruneResult {
  removed: string[];
  branchesDeleted: string[];
  failed: { path: string; error: string }[];
  inspected: number;
}

function isFinishedRun(status: string | null): boolean {
  return status !== null && (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

async function buildLiveByPath(repoPath: string): Promise<Map<string, string | null>> {
  const liveByPath = new Map<string, string | null>();
  if (!(await isGitRepo(repoPath))) return liveByPath;
  for (const entry of await listWorktrees(repoPath)) {
    liveByPath.set(canonicalForCompare(entry.path), entry.branch);
  }
  return liveByPath;
}

async function classifyWorktreeDir(args: {
  path: string;
  projectName: string;
  projectRepoPath: string | null;
  liveByPath: Map<string, string | null>;
  runStatus: string | null;
}): Promise<PruneCandidate | null> {
  const { path, projectName, projectRepoPath, liveByPath, runStatus } = args;
  try {
    if (!statSync(path).isDirectory()) return null;
  } catch {
    return null;
  }
  const resolvedPath = canonicalForCompare(path);
  // The `.git` pointer is authoritative: it reflects which repo actually
  // owns this worktree, which matters when a repo-local placement under a
  // project rootPath was created from a nested repo. Fall back to the
  // project's repo only when the pointer can't be resolved (e.g. dir was
  // hand-deleted but the registration lingers).
  const effectiveRepoPath = repoPathFromWorktree(path) ?? projectRepoPath;
  let branch = liveByPath.get(resolvedPath);
  let trackedKnown = branch !== undefined;
  if (
    effectiveRepoPath !== null &&
    effectiveRepoPath !== projectRepoPath &&
    (await isGitRepo(effectiveRepoPath))
  ) {
    for (const entry of await listWorktrees(effectiveRepoPath)) {
      if (canonicalForCompare(entry.path) === resolvedPath) {
        branch = entry.branch;
        trackedKnown = true;
        break;
      }
    }
  }
  return {
    path,
    projectName,
    branch: branch ?? null,
    repoPath: effectiveRepoPath,
    runStatus,
    reason:
      effectiveRepoPath === null
        ? "orphan-no-repo"
        : trackedKnown
          ? "tracked"
          : "orphan-stale-record",
  };
}

// Walks each project's repo-local `.worktrees` dir to collect every worktree
// directory we can see, paired with its project's source repo (needed to call
// `git worktree remove` against the right repo).
async function collectCandidates(baseUrl: string): Promise<PruneCandidate[]> {
  const candidates: PruneCandidate[] = [];

  let projects: Project[];
  try {
    projects = await listProjects(baseUrl);
  } catch (err) {
    if (isServerDownError(err)) {
      projects = [];
    } else {
      throw err;
    }
  }
  const seenPaths = new Set<string>();
  const recordPath = (p: string): boolean => {
    const canonical = canonicalForCompare(p);
    if (seenPaths.has(canonical)) return false;
    seenPaths.add(canonical);
    return true;
  };

  // Persisted worktree paths from workflow_runs, with each run's status. The
  // status is what lets prune sweep a finished run's leftover without --force
  // while leaving a live run's working directory alone. The path list also
  // catches worktrees whose project row has been deleted (FK NULLed, path
  // retained) — those dirs are otherwise invisible to the project-scoped
  // scans below.
  let persistedPaths: string[] = [];
  const statusByPath = new Map<string, string>();
  try {
    const persisted = await listPersistedWorktrees(baseUrl);
    persistedPaths = persisted.paths;
    for (const [path, status] of persisted.statusByPath) {
      statusByPath.set(canonicalForCompare(path), status);
    }
  } catch (err) {
    if (!isServerDownError(err)) throw err;
  }
  const runStatusFor = (path: string): string | null =>
    statusByPath.get(canonicalForCompare(path)) ?? null;

  // Repo-local placement is `<project.rootPath>/.worktrees/<leaf>/`. This
  // directory lives *inside the user's repo*, so we must not enqueue plain
  // user directories the operator dropped there. Only consider entries that
  // are genuine worktrees: either git lists them as live, or their `.git`
  // pointer resolves to a repo. Anything else is left alone.
  for (const project of projects) {
    const repoLocalRoot = join(project.rootPath, ".worktrees");
    if (!existsSync(repoLocalRoot)) continue;
    const liveByPath = await buildLiveByPath(project.rootPath);
    for (const leaf of readdirSync(repoLocalRoot)) {
      const path = join(repoLocalRoot, leaf);
      if (!recordPath(path)) continue;
      const isLive = liveByPath.has(canonicalForCompare(path));
      const recovered = repoPathFromWorktree(path);
      if (!isLive && recovered === null) continue;
      const c = await classifyWorktreeDir({
        path,
        projectName: project.name,
        projectRepoPath: project.rootPath,
        liveByPath,
        runStatus: runStatusFor(path),
      });
      if (c !== null) candidates.push(c);
    }
  }

  for (const path of persistedPaths) {
    if (!existsSync(path)) continue;
    if (!recordPath(path)) continue;
    const c = await classifyWorktreeDir({
      path,
      projectName: basename(dirname(path)),
      projectRepoPath: null,
      liveByPath: new Map(),
      runStatus: runStatusFor(path),
    });
    if (c !== null) candidates.push(c);
  }

  return candidates;
}

export async function runWorktreePrune(opts: WorktreePruneOptions): Promise<never> {
  const baseUrl = opts.baseUrl ?? defaultServerBaseUrl();
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

  const result: PruneResult = {
    removed: [],
    branchesDeleted: [],
    failed: [],
    inspected: candidates.length,
  };
  for (const c of candidates) {
    // Worktrees on `keelson/...` branches are ones the executor created. They
    // can be safely removed even when git still tracks them — failed/cancelled
    // runs intentionally keep their entry registered for inspection, and the
    // operator pointing prune at them is the documented cleanup path.
    // Worktrees on non-`keelson/` branches are user-managed; never auto-remove
    // those even with --force, since the operator may have intentionally
    // co-located a worktree under the project's `.worktrees/`.
    const isManaged = c.branch === null || c.branch.startsWith("keelson/");
    if (c.reason === "tracked" && !isManaged) {
      continue;
    }
    if (c.reason === "tracked" && !opts.force && !isFinishedRun(c.runStatus)) {
      // A tracked entry whose run is still live (or whose status is unknown
      // because the server was down) stays put — `--force` is the operator
      // saying "yes, even live worktrees".
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
        if (c.branch?.startsWith("keelson/")) {
          const gone = await deleteBranch({ repoPath: c.repoPath, branch: c.branch });
          if (gone.deleted) result.branchesDeleted.push(c.branch);
          if (gone.warning !== null) result.failed.push({ path: c.path, error: gone.warning });
        }
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
