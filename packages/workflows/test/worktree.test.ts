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
  createWorktree,
  isGitRepo,
  listWorktrees,
  NotAGitRepoError,
  removeWorktree,
  repoPathFromWorktree,
  resolveBranchTemplate,
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

async function initRepo(path: string): Promise<void> {
  await git(["init", "--initial-branch=main"], path);
  await git(["config", "user.email", "test@example.com"], path);
  await git(["config", "user.name", "Test"], path);
  writeFileSync(join(path, "README.md"), "test repo\n");
  await git(["add", "README.md"], path);
  await git(["commit", "-m", "initial"], path);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "keelson-worktree-test-"));
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
    ).toBe("/repos/work/.worktrees/abc");
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
