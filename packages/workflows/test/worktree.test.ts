// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  canonicalPath,
  createWorktree,
  ensureWorktreeDeps,
  gitToplevel,
  headDivergesFrom,
  isGitRepo,
  listWorktrees,
  NotAGitRepoError,
  removeWorktree,
  repoPathFromWorktree,
  resolveBranchTemplate,
  resolveDefaultBranch,
  WorktreeCreationError,
  worktreePathForRepoLocal,
} from "../src/worktree.ts";

let tmp: string;

async function git(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${err}`);
  }
}

async function gitText(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${stderr}`);
  }
  return stdout;
}

async function bun(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn({ cmd: ["bun", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`bun ${args.join(" ")} failed in ${cwd}: ${err}`);
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function initRepo(path: string): Promise<void> {
  await git(["init", "--initial-branch=main"], path);
  await git(["config", "user.email", "test@example.com"], path);
  await git(["config", "user.name", "Test"], path);
  // Hermetic line endings: a host-level core.autocrlf=true (the Git for
  // Windows default, and what GitHub's windows runners ship) would smudge the
  // committed bun.lock to CRLF on worktree checkout, and `bun install
  // --frozen-lockfile` rejects the reserialized lockfile as changed.
  await git(["config", "core.autocrlf", "false"], path);
  writeFileSync(join(path, "README.md"), "test repo\n");
  await git(["add", "README.md"], path);
  await git(["commit", "-m", "initial"], path);
}

async function addOrigin(path: string): Promise<void> {
  const remote = join(path, "origin.git");
  await git(["init", "--bare", "--initial-branch=main", remote], path);
  await git(["remote", "add", "origin", remote], path);
  await git(["push", "-u", "origin", "main"], path);
  await git(["remote", "set-head", "origin", "-a"], path);
}

beforeEach(() => {
  // Canonicalize (8.3 short form → long): GitHub's windows runners expose TEMP
  // as C:\Users\RUNNER~1\..., and a short-form repo cwd makes bun record
  // repo-escaping workspace keys in bun.lock (breaking the frozen install in
  // the worktree) and makes lexical comparisons against git's long-form
  // output miss.
  tmp = canonicalPath(mkdtempSync(join(tmpdir(), "keelson-worktree-test-")));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("resolveBranchTemplate", () => {
  test("substitutes {workflow} and {run_id_short}", () => {
    expect(
      resolveBranchTemplate("keelson/{workflow}/{run_id_short}", {
        workflow: "architect",
        runId: "abcdef0123456789",
      }),
    ).toBe("keelson/architect/abcdef01");
  });

  test("falls back to default when template is undefined", () => {
    expect(resolveBranchTemplate(undefined, { workflow: "x", runId: "1234567890" })).toBe(
      "keelson/x/12345678",
    );
  });

  test("supports {run_id} for the full id", () => {
    expect(resolveBranchTemplate("custom/{run_id}", { workflow: "x", runId: "abcdef" })).toBe(
      "custom/abcdef",
    );
  });
});

describe("worktreePathForRepoLocal", () => {
  test("places the branch leaf under the repo's .worktrees dir", () => {
    expect(
      worktreePathForRepoLocal({
        projectRootPath: "/repos/work",
        branch: "keelson/architect/abc",
      }),
    ).toBe(join("/repos/work", ".worktrees", "abc"));
  });
});

describe("isGitRepo", () => {
  test("returns true for an initialized repo", async () => {
    await initRepo(tmp);
    expect(await isGitRepo(tmp)).toBe(true);
  });

  test("returns false for a plain directory", async () => {
    expect(await isGitRepo(tmp)).toBe(false);
  });

  test("returns false for a non-existent path", async () => {
    expect(await isGitRepo(join(tmp, "ghost"))).toBe(false);
  });
});

describe("gitToplevel", () => {
  test("resolves the repo root from a nested subdirectory", async () => {
    await initRepo(tmp);
    const sub = join(tmp, "a", "b");
    mkdirSync(sub, { recursive: true });
    expect(await gitToplevel(sub)).toBe(await gitToplevel(tmp));
    // Functional anchor: the resolved root is a real work tree.
    expect(await isGitRepo((await gitToplevel(sub))!)).toBe(true);
  });

  test("returns null for a plain directory", async () => {
    expect(await gitToplevel(tmp)).toBeNull();
  });
});

describe("createWorktree", () => {
  test("creates a worktree on a new branch", async () => {
    await initRepo(tmp);
    const dest = join(tmp, ".wt", "feature");
    const result = await createWorktree({
      repoPath: tmp,
      branch: "keelson/test/feature",
      dest,
    });
    expect(result.worktreePath).toBe(dest);
    expect(result.adopted).toBe(false);
    expect(result.branchCreated).toBe(true);
    expect(existsSync(dest)).toBe(true);
    expect(existsSync(join(dest, "README.md"))).toBe(true);
  });

  test("creates a new branch from base instead of checkout HEAD", async () => {
    await initRepo(tmp);
    writeFileSync(join(tmp, "feature.txt"), "feature\n");
    await git(["checkout", "-b", "feature"], tmp);
    await git(["add", "feature.txt"], tmp);
    await git(["commit", "-m", "feature"], tmp);

    const dest = join(tmp, ".wt", "base");
    await createWorktree({
      repoPath: tmp,
      branch: "keelson/test/base",
      dest,
      base: "main",
    });

    expect((await gitText(["log", "--oneline", "main..keelson/test/base"], tmp)).trim()).toBe("");
    expect(existsSync(join(dest, "feature.txt"))).toBe(false);
  });

  test("throws NotAGitRepoError for a non-repo path", async () => {
    await expect(
      createWorktree({ repoPath: tmp, branch: "x", dest: join(tmp, "wt") }),
    ).rejects.toBeInstanceOf(NotAGitRepoError);
  });

  test("adopts an existing worktree directory rather than failing", async () => {
    await initRepo(tmp);
    const dest = join(tmp, ".wt", "feature");
    await createWorktree({ repoPath: tmp, branch: "keelson/test/feature", dest });
    const second = await createWorktree({
      repoPath: tmp,
      branch: "keelson/test/feature",
      dest,
    });
    expect(second.adopted).toBe(true);
    expect(second.worktreePath).toBe(dest);
  });

  test("throws WorktreeCreationError when dest exists but is not a registered worktree", async () => {
    await initRepo(tmp);
    const dest = join(tmp, ".wt", "unrelated");
    mkdirSync(dest, { recursive: true });
    await expect(
      createWorktree({ repoPath: tmp, branch: "keelson/test/feature", dest }),
    ).rejects.toBeInstanceOf(WorktreeCreationError);
  });
});

describe("resolveDefaultBranch", () => {
  test("prefers origin HEAD", async () => {
    await initRepo(tmp);
    await addOrigin(tmp);

    expect(await resolveDefaultBranch(tmp)).toBe("origin/main");
  });

  test("falls back to origin main then local main when origin exists", async () => {
    await initRepo(tmp);
    await addOrigin(tmp);
    await git(["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"], tmp);
    expect(await resolveDefaultBranch(tmp)).toBe("origin/main");

    await git(["update-ref", "-d", "refs/remotes/origin/main"], tmp);
    expect(await resolveDefaultBranch(tmp)).toBe("main");
  });

  test("returns null for a local-only repo", async () => {
    await initRepo(tmp);

    expect(await resolveDefaultBranch(tmp)).toBeNull();
  });

  test("returns null instead of throwing when the cwd does not exist", async () => {
    // Bun.spawn throws ENOENT (posix_spawn) when its cwd was removed out from
    // under it — e.g. a timed-out test's teardown, or a concurrent worktree
    // removal. runGit must degrade to a non-zero result, not an unhandled throw.
    const gone = join(tmp, "does-not-exist", "sub");
    expect(await resolveDefaultBranch(gone)).toBeNull();
  });
});

describe("headDivergesFrom", () => {
  test("detects when HEAD has commits outside the base", async () => {
    await initRepo(tmp);
    expect(await headDivergesFrom(tmp, "main")).toBe(false);

    await git(["checkout", "-b", "feature"], tmp);
    writeFileSync(join(tmp, "feature.txt"), "feature\n");
    await git(["add", "feature.txt"], tmp);
    await git(["commit", "-m", "feature"], tmp);

    expect(await headDivergesFrom(tmp, "main")).toBe(true);
  });
});

describe("ensureWorktreeDeps", () => {
  test("installs the workspace graph into a fresh worktree", async () => {
    await initRepo(tmp);
    writeJson(join(tmp, "package.json"), {
      name: "wt-deps-root",
      version: "0.0.0",
      private: true,
      workspaces: ["pkg"],
    });
    mkdirSync(join(tmp, "pkg"), { recursive: true });
    writeJson(join(tmp, "pkg", "package.json"), { name: "@wt-deps/pkg", version: "0.0.0" });
    // Generate bun.lock against the committed manifests, then commit only the
    // tracked files — node_modules stays untracked so the new worktree starts
    // dependency-empty (the exact gap this guards).
    await bun(["install"], tmp);
    await git(["add", "package.json", "pkg/package.json", "bun.lock"], tmp);
    await git(["commit", "-m", "add workspace"], tmp);

    const dest = join(tmp, ".wt", "feature");
    await createWorktree({ repoPath: tmp, branch: "keelson/test/feature", dest });
    expect(existsSync(join(dest, "node_modules"))).toBe(false);

    const result = await ensureWorktreeDeps({ worktreePath: dest });
    expect(result.skipped).toBeNull();
    expect(result.error).toBeNull();
    expect(result.installed).toBe(true);
    expect(existsSync(join(dest, "node_modules"))).toBe(true);
  });

  test("skips a worktree with no package.json", async () => {
    await initRepo(tmp);
    const dest = join(tmp, ".wt", "feature");
    await createWorktree({ repoPath: tmp, branch: "keelson/test/feature", dest });
    const result = await ensureWorktreeDeps({ worktreePath: dest });
    expect(result.installed).toBe(false);
    expect(result.skipped).toBe("no-manifest");
    expect(result.error).toBeNull();
  });

  test("skips install when the run is already aborted", async () => {
    await initRepo(tmp);
    const dest = join(tmp, ".wt", "feature");
    await createWorktree({ repoPath: tmp, branch: "keelson/test/feature", dest });
    const ac = new AbortController();
    ac.abort();
    const result = await ensureWorktreeDeps({ worktreePath: dest, abortSignal: ac.signal });
    expect(result.installed).toBe(false);
    expect(result.skipped).toBe("aborted");
    expect(result.error).toBeNull();
  });

  test("skips a package with no bun lockfile", async () => {
    await initRepo(tmp);
    writeJson(join(tmp, "package.json"), { name: "no-lock", version: "0.0.0", private: true });
    await git(["add", "package.json"], tmp);
    await git(["commit", "-m", "manifest only"], tmp);
    const dest = join(tmp, ".wt", "feature");
    await createWorktree({ repoPath: tmp, branch: "keelson/test/feature", dest });
    const result = await ensureWorktreeDeps({ worktreePath: dest });
    expect(result.installed).toBe(false);
    expect(result.skipped).toBe("no-lockfile");
    expect(result.error).toBeNull();
  });
});

describe("removeWorktree", () => {
  test("removes a clean worktree", async () => {
    await initRepo(tmp);
    const dest = join(tmp, ".wt", "feature");
    await createWorktree({ repoPath: tmp, branch: "keelson/test/feature", dest });
    expect(existsSync(dest)).toBe(true);
    const result = await removeWorktree({ repoPath: tmp, dest });
    expect(result.removed).toBe(true);
    expect(existsSync(dest)).toBe(false);
  });

  test("returns removed:false (idempotent) when worktree is gone", async () => {
    await initRepo(tmp);
    const result = await removeWorktree({ repoPath: tmp, dest: join(tmp, "missing") });
    expect(result.removed).toBe(false);
    expect(result.warning).toBeNull();
  });

  test("dirty worktree without force returns warning, with force removes", async () => {
    await initRepo(tmp);
    const dest = join(tmp, ".wt", "feature");
    await createWorktree({ repoPath: tmp, branch: "keelson/test/feature", dest });
    writeFileSync(join(dest, "dirty.txt"), "uncommitted\n");
    const soft = await removeWorktree({ repoPath: tmp, dest });
    expect(soft.removed).toBe(false);
    expect(soft.warning).toMatch(/.+/);
    const forced = await removeWorktree({ repoPath: tmp, dest, force: true });
    expect(forced.removed).toBe(true);
    expect(existsSync(dest)).toBe(false);
  });
});

describe("repoPathFromWorktree", () => {
  test("recovers the source repo from a real worktree's .git pointer", async () => {
    await initRepo(tmp);
    const dest = join(tmp, ".wt", "feature");
    await createWorktree({ repoPath: tmp, branch: "keelson/test/feature", dest });
    // git resolves /tmp → /private/tmp on macOS, so compare via realpath.
    const recovered = repoPathFromWorktree(dest);
    expect(recovered).toBeTruthy();
    expect(recovered!.endsWith(basename(tmp))).toBe(true);
  });

  test("returns null when the directory has no .git pointer", () => {
    expect(repoPathFromWorktree(tmp)).toBeNull();
  });

  test("parses a backslash-separated gitdir pointer", () => {
    const wt = join(tmp, "winwt");
    require("node:fs").mkdirSync(wt);
    require("node:fs").writeFileSync(
      join(wt, ".git"),
      "gitdir: C:\\Users\\dev\\repo\\.git\\worktrees\\feature\n",
    );
    expect(repoPathFromWorktree(wt)).toBe("C:\\Users\\dev\\repo");
  });

  test("returns null when .git is malformed", () => {
    const wt = join(tmp, "broken");
    require("node:fs").mkdirSync(wt);
    require("node:fs").writeFileSync(join(wt, ".git"), "not a git pointer");
    expect(repoPathFromWorktree(wt)).toBeNull();
  });
});

describe("listWorktrees", () => {
  test("includes the main worktree plus created ones", async () => {
    await initRepo(tmp);
    const dest = join(tmp, ".wt", "feature");
    await createWorktree({ repoPath: tmp, branch: "keelson/test/feature", dest });
    const entries = await listWorktrees(tmp);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    // git resolves symlinks (e.g. /tmp → /private/tmp on macOS) so match on
    // branch instead of the dest path.
    const found = entries.find((e) => e.branch === "keelson/test/feature");
    expect(found).toBeDefined();
  });
});
