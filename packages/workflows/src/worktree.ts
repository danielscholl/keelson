// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * Worktree manager — wraps `git worktree add/remove` for per-run isolation.
 *
 * Borrows the mental model from Archon's `packages/isolation/src/providers/
 * worktree.ts` (per-run worktree, optional adoption, force-removable) but
 * re-typed for Bun + the single-user local harness. No DB-resident isolation
 * catalog; the worktree path is stored directly on the workflow_runs row.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

const DEFAULT_BRANCH_TEMPLATE = "keelson/{workflow}/{run_id_short}";
const GIT_TIMEOUT_MS = 30_000;
// Resolving a fresh worktree's workspace graph is far slower than a git op.
const BUN_INSTALL_TIMEOUT_MS = 300_000;

// realpathSync.native resolves through the OS (GetFinalPathNameByHandle on
// Windows), which also expands 8.3 short names (C:\Users\RUNNER~1\...) that the
// portable implementation leaves intact. Git records long-form paths, so a
// same-directory check against a short-form input (e.g. a Windows temp dir)
// only converges if both sides canonicalize the same way.
function canonicalPath(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return realpathSync(p);
  }
}

// Windows filesystems are case-insensitive; canonical forms can still differ
// in casing (drive letter, preserved-case components from different origins).
function samePath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export interface BranchTemplateContext {
  workflow: string;
  runId: string;
}

export class NotAGitRepoError extends Error {
  constructor(public readonly repoPath: string) {
    super(`not a git repository: ${repoPath}`);
    this.name = "NotAGitRepoError";
  }
}

export class WorktreeCreationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeCreationError";
  }
}

/**
 * Repo-local placement: `<projectRootPath>/.worktrees/<branch-leaf>/`.
 */
export function worktreePathForRepoLocal(opts: {
  projectRootPath: string;
  branch: string;
}): string {
  const leaf = opts.branch.split("/").pop() ?? opts.branch;
  return join(opts.projectRootPath, ".worktrees", leaf);
}

/** Resolve the branch-name template against the run's workflow / id. */
export function resolveBranchTemplate(
  template: string | undefined,
  ctx: BranchTemplateContext,
): string {
  const t = template && template.length > 0 ? template : DEFAULT_BRANCH_TEMPLATE;
  return t
    .replaceAll("{workflow}", ctx.workflow)
    .replaceAll("{run_id_short}", ctx.runId.slice(0, 8))
    .replaceAll("{run_id}", ctx.runId);
}

interface GitOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runGit(args: string[], cwd?: string): Promise<GitOutcome> {
  const proc = Bun.spawn({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      // already gone
    }
  }, GIT_TIMEOUT_MS);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  clearTimeout(timeout);
  return { exitCode, stdout, stderr };
}

async function runBun(args: string[], cwd: string, abortSignal?: AbortSignal): Promise<GitOutcome> {
  const proc = Bun.spawn({
    cmd: ["bun", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const kill = () => {
    try {
      proc.kill();
    } catch {
      // already gone
    }
  };
  const timeout = setTimeout(kill, BUN_INSTALL_TIMEOUT_MS);
  // An already-aborted signal won't fire a fresh "abort" event, so kill now
  // rather than waiting out the timeout.
  if (abortSignal?.aborted) {
    kill();
  } else {
    abortSignal?.addEventListener("abort", kill, { once: true });
  }
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  clearTimeout(timeout);
  abortSignal?.removeEventListener("abort", kill);
  return { exitCode, stdout, stderr };
}

/** Check if `path` is inside a git work tree. Cheap; one git invocation. */
export async function isGitRepo(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  const out = await runGit(["rev-parse", "--is-inside-work-tree"], path);
  return out.exitCode === 0 && out.stdout.trim() === "true";
}

/**
 * Absolute path of the work tree's top-level directory, or null when `path`
 * isn't inside a repo. Lets callers anchor repo-local worktrees at the repo
 * root even when invoked from a nested subdirectory.
 */
export async function gitToplevel(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  const out = await runGit(["rev-parse", "--show-toplevel"], path);
  if (out.exitCode !== 0) return null;
  const top = out.stdout.trim();
  return top.length > 0 ? top : null;
}

export interface CreateWorktreeOptions {
  /** Source repo (project's root path). */
  repoPath: string;
  /** Pre-resolved branch name (after template substitution). */
  branch: string;
  /** Absolute path where the worktree will be created. */
  dest: string;
}

export interface CreateWorktreeResult {
  worktreePath: string;
  branchCreated: boolean;
  /** Set when the destination already existed and was adopted instead of created. */
  adopted: boolean;
}

/**
 * Create a worktree at `dest` from `repoPath` on a new branch. If `dest`
 * already exists (e.g. an orphaned worktree from a previous failed run),
 * adopt it and return `adopted: true` rather than failing.
 *
 * Throws `NotAGitRepoError` when `repoPath` isn't a git work tree, and
 * `WorktreeCreationError` for any other git failure.
 */
export async function createWorktree(opts: CreateWorktreeOptions): Promise<CreateWorktreeResult> {
  if (!(await isGitRepo(opts.repoPath))) {
    throw new NotAGitRepoError(opts.repoPath);
  }
  if (existsSync(opts.dest)) {
    const known = await listWorktrees(opts.repoPath);
    const destReal = canonicalPath(opts.dest);
    const isRegistered = known.some((wt) => {
      try {
        return (
          samePath(canonicalPath(wt.path), destReal) &&
          (wt.branch === null || wt.branch === opts.branch)
        );
      } catch {
        return false;
      }
    });
    if (!isRegistered) {
      throw new WorktreeCreationError(
        `destination exists but is not a registered worktree for this repo: ${opts.dest}`,
      );
    }
    return { worktreePath: opts.dest, branchCreated: false, adopted: true };
  }
  mkdirSync(dirname(opts.dest), { recursive: true });
  // `-b` creates the branch; if the branch already exists from a previous
  // run that left its worktree behind, drop `-b` and check it out instead.
  const branchExists = await runGit(
    ["show-ref", "--verify", "--quiet", `refs/heads/${opts.branch}`],
    opts.repoPath,
  );
  const args =
    branchExists.exitCode === 0
      ? ["worktree", "add", opts.dest, opts.branch]
      : ["worktree", "add", "-b", opts.branch, opts.dest];
  const result = await runGit(args, opts.repoPath);
  if (result.exitCode !== 0) {
    throw new WorktreeCreationError(
      `git worktree add failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return {
    worktreePath: opts.dest,
    branchCreated: branchExists.exitCode !== 0,
    adopted: false,
  };
}

export interface EnsureWorktreeDepsResult {
  installed: boolean;
  /** Why the install was skipped, or null when it ran. */
  skipped: "no-manifest" | "no-lockfile" | "aborted" | null;
  /** Set when `bun install` ran but exited non-zero. */
  error: string | null;
  durationMs: number;
}

/**
 * Install a freshly-created worktree's dependencies. A worktree is a bare
 * checkout with no `node_modules` (gitignored), so validate-style nodes
 * (`bun run typecheck` / `test`) would fail on environment without this.
 * Skips repos with no `package.json` / bun lockfile so non-JS projects are
 * untouched. Honors `abortSignal` so a cancelled run kills the install
 * instead of blocking on it. Never throws — the caller decides what a
 * failed install means.
 */
export async function ensureWorktreeDeps(opts: {
  worktreePath: string;
  abortSignal?: AbortSignal;
}): Promise<EnsureWorktreeDepsResult> {
  const startedAtMs = Date.now();
  const elapsed = () => Date.now() - startedAtMs;
  if (opts.abortSignal?.aborted) {
    return { installed: false, skipped: "aborted", error: null, durationMs: elapsed() };
  }
  if (!existsSync(join(opts.worktreePath, "package.json"))) {
    return { installed: false, skipped: "no-manifest", error: null, durationMs: elapsed() };
  }
  const hasLockfile =
    existsSync(join(opts.worktreePath, "bun.lock")) ||
    existsSync(join(opts.worktreePath, "bun.lockb"));
  if (!hasLockfile) {
    return { installed: false, skipped: "no-lockfile", error: null, durationMs: elapsed() };
  }
  let out: GitOutcome;
  try {
    out = await runBun(["install", "--frozen-lockfile"], opts.worktreePath, opts.abortSignal);
  } catch (err) {
    return {
      installed: false,
      skipped: null,
      error: `bun install could not be spawned: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: elapsed(),
    };
  }
  if (opts.abortSignal?.aborted) {
    return { installed: false, skipped: "aborted", error: null, durationMs: elapsed() };
  }
  if (out.exitCode !== 0) {
    const tail = (out.stderr.trim() || out.stdout.trim()).slice(-2000);
    return {
      installed: false,
      skipped: null,
      error: `bun install failed (exit ${out.exitCode}): ${tail}`,
      durationMs: elapsed(),
    };
  }
  return { installed: true, skipped: null, error: null, durationMs: elapsed() };
}

export interface RemoveWorktreeOptions {
  repoPath: string;
  dest: string;
  /** When true, pass --force so an uncommitted-changes worktree is removed too. */
  force?: boolean;
}

export interface RemoveWorktreeResult {
  removed: boolean;
  warning: string | null;
}

/**
 * Remove a worktree. When the destination has uncommitted changes and
 * `force` is false, git refuses; the caller decides whether to retry with
 * force or leave it for inspection.
 *
 * Returns `removed: false` when the worktree didn't exist (idempotent).
 */
export async function removeWorktree(opts: RemoveWorktreeOptions): Promise<RemoveWorktreeResult> {
  if (!existsSync(opts.dest)) {
    return { removed: false, warning: null };
  }
  const args = opts.force
    ? ["worktree", "remove", "--force", opts.dest]
    : ["worktree", "remove", opts.dest];
  const result = await runGit(args, opts.repoPath);
  if (result.exitCode !== 0) {
    return {
      removed: false,
      warning: `git worktree remove failed: ${result.stderr.trim() || result.stdout.trim()}`,
    };
  }
  return { removed: true, warning: null };
}

/**
 * Recover the source repository's path from a worktree directory by parsing
 * its `.git` file. Git stores `gitdir: <abs-path>/.git/worktrees/<name>` in
 * that pointer; trimming the `/worktrees/<name>` and `/.git` suffixes yields
 * the source repo root. Returns `null` when the directory isn't a worktree
 * (no `.git` file, dir not a file, malformed pointer).
 *
 * Used by `keelson worktree prune` to unregister worktrees whose projects
 * were deleted (or were never associated with a project) — without the source
 * repo path, `git worktree remove` can't unregister the entry and a plain
 * `rm -rf` would leave a stale record under the source repo's
 * `.git/worktrees/`.
 */
export function repoPathFromWorktree(worktreeDir: string): string | null {
  const gitPointer = join(worktreeDir, ".git");
  if (!existsSync(gitPointer)) return null;
  let raw: string;
  try {
    raw = readFileSync(gitPointer, "utf-8");
  } catch {
    return null;
  }
  // Expected: `gitdir: <repo>/.git/worktrees/<name>`. A trailing newline is
  // standard but not guaranteed; trim aggressively.
  const match = raw.trim().match(/^gitdir:\s*(.+)$/);
  if (!match) return null;
  const gitdir = match[1]!.trim();
  // Strip `/worktrees/<name>` to get `<repo>/.git`, then dirname to get repo.
  // Git for Windows writes gitdir pointers with forward slashes, but tolerate
  // backslashes too — a misparse here downgrades a tracked worktree to an
  // orphan, and prune would rmSync it without unregistering the git record.
  const worktreesIdx = Math.max(
    gitdir.lastIndexOf("/.git/worktrees/"),
    gitdir.lastIndexOf("\\.git\\worktrees\\"),
  );
  if (worktreesIdx < 0) return null;
  return gitdir.slice(0, worktreesIdx);
}

/**
 * List the worktrees registered under `repoPath`. Output is `git worktree
 * list --porcelain` parsed into `{ path, branch }` entries; useful for the
 * `keelson worktree prune` command (slice 4).
 */
export async function listWorktrees(
  repoPath: string,
): Promise<readonly { path: string; branch: string | null }[]> {
  const out = await runGit(["worktree", "list", "--porcelain"], repoPath);
  if (out.exitCode !== 0) return [];
  const entries: { path: string; branch: string | null }[] = [];
  let path: string | null = null;
  let branch: string | null = null;
  for (const line of out.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (path) entries.push({ path, branch });
      path = line.slice("worktree ".length);
      branch = null;
    } else if (line.startsWith("branch ")) {
      branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    }
  }
  if (path) entries.push({ path, branch });
  return entries;
}
