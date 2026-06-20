// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnEnv } from "./spawn-env.ts";

const BIN = resolve(import.meta.dir, "..", "bin", "keelson.ts");

async function runCli(
  args: readonly string[],
  env?: Record<string, string>,
): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", BIN, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    ...(env ? { env: spawnEnv(env) } : {}),
  });
  const [stdout, , exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, exitCode };
}

async function runGit(args: readonly string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${exitCode}): ${stderr.trim() || stdout.trim()}`,
    );
  }
  return stdout.trim();
}

async function setupFixture(): Promise<{
  sandbox: string;
  repoRoot: string;
  managedPath: string;
  userPath: string;
  orphanPath: string;
  persistedPaths: string[];
  baseUrl: string;
  server: ReturnType<typeof Bun.serve>;
}> {
  const sandbox = mkdtempSync(join(tmpdir(), "keelson-worktree-prune-"));
  const repoRootRaw = join(sandbox, "repo");
  mkdirSync(repoRootRaw, { recursive: true });
  await runGit(["init"], repoRootRaw);
  // Canonical repo root straight from git. On Windows CI, tmpdir() is an 8.3
  // short path (C:\Users\RUNNER~1\...) that realpath won't expand, but git
  // records the long form — derive every path the CLI sees from git's view, or
  // tracked worktrees mis-classify as orphans (and prune would delete them).
  const repoRoot = await runGit(["rev-parse", "--show-toplevel"], repoRootRaw);
  await runGit(["config", "user.email", "keelson@example.com"], repoRoot);
  await runGit(["config", "user.name", "Keelson"], repoRoot);
  writeFileSync(join(repoRoot, "README.md"), "repo\n");
  await runGit(["add", "README.md"], repoRoot);
  await runGit(["commit", "-m", "init"], repoRoot);

  const orphanPath = join(dirname(repoRoot), "orphan");
  mkdirSync(orphanPath, { recursive: true });
  mkdirSync(join(repoRoot, ".worktrees"), { recursive: true });
  const managedPath = join(repoRoot, ".worktrees", "managed");
  const userPath = join(repoRoot, ".worktrees", "keep");
  await runGit(["worktree", "add", "-b", "keelson/run-1", managedPath], repoRoot);
  await runGit(["worktree", "add", "-b", "feature/keep", userPath], repoRoot);

  writeFileSync(join(orphanPath, ".git"), "gitdir: /nowhere/.git/worktrees/orphan\n");
  const persistedPaths = [orphanPath];

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/api/projects") {
        return Response.json({
          projects: [{ id: "p1", name: "repo", rootPath: repoRoot }],
        });
      }
      if (pathname === "/api/workflows/worktree-paths") {
        return Response.json({ paths: persistedPaths });
      }
      if (pathname === "/api/health") {
        return Response.json({ ok: true, name: "keelson", schema_version: "2.7" });
      }
      return new Response("not found", { status: 404 });
    },
  });

  return {
    sandbox,
    repoRoot,
    managedPath,
    userPath,
    orphanPath,
    persistedPaths,
    baseUrl: `http://${server.hostname}:${server.port}`,
    server,
  };
}

function cleanupFixture(fixture: { sandbox: string; server: ReturnType<typeof Bun.serve> }): void {
  fixture.server.stop(true);
  rmSync(fixture.sandbox, { recursive: true, force: true });
}

describe("keelson worktree prune", () => {
  test("dry-run reports tracked and orphan candidates without removing them", async () => {
    const fixture = await setupFixture();
    try {
      const { stdout, exitCode } = await runCli([
        "--json",
        "worktree",
        "prune",
        "--dry-run",
        "--base-url",
        fixture.baseUrl,
      ]);

      expect(exitCode).toBe(0);
      const env = JSON.parse(stdout.trim()) as {
        ok: boolean;
        data: {
          candidates: Array<{ path: string; branch: string | null; reason: string }>;
        };
      };

      expect(env.ok).toBe(true);
      expect(env.data.candidates).toHaveLength(3);
      expect(env.data.candidates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: fixture.managedPath,
            branch: "keelson/run-1",
            reason: "tracked",
          }),
          expect.objectContaining({
            path: fixture.userPath,
            branch: "feature/keep",
            reason: "tracked",
          }),
          expect.objectContaining({
            path: fixture.orphanPath,
            branch: null,
            reason: "orphan-stale-record",
          }),
        ]),
      );
      expect(existsSync(fixture.managedPath)).toBe(true);
      expect(existsSync(fixture.userPath)).toBe(true);
      expect(existsSync(fixture.orphanPath)).toBe(true);
    } finally {
      cleanupFixture(fixture);
    }
  });

  test("prunes orphan paths while leaving tracked worktrees in place without --force", async () => {
    const fixture = await setupFixture();
    try {
      const { stdout, exitCode } = await runCli([
        "--json",
        "worktree",
        "prune",
        "--base-url",
        fixture.baseUrl,
      ]);

      expect(exitCode).toBe(0);
      const env = JSON.parse(stdout.trim()) as {
        ok: boolean;
        data: {
          removed: string[];
          failed: Array<{ path: string; error: string }>;
          inspected: number;
        };
      };

      expect(env.ok).toBe(true);
      expect(env.data.inspected).toBe(3);
      expect(env.data.removed).toEqual([fixture.orphanPath]);
      expect(env.data.failed).toHaveLength(0);
      expect(existsSync(fixture.managedPath)).toBe(true);
      expect(existsSync(fixture.userPath)).toBe(true);
      expect(existsSync(fixture.orphanPath)).toBe(false);
    } finally {
      cleanupFixture(fixture);
    }
  });

  test("force-removes managed worktrees while preserving user-managed branches", async () => {
    const fixture = await setupFixture();
    try {
      const { stdout, exitCode } = await runCli([
        "--json",
        "worktree",
        "prune",
        "--force",
        "--base-url",
        fixture.baseUrl,
      ]);

      expect(exitCode).toBe(0);
      const env = JSON.parse(stdout.trim()) as {
        ok: boolean;
        data: {
          removed: string[];
          failed: Array<{ path: string; error: string }>;
          inspected: number;
        };
      };

      expect(env.ok).toBe(true);
      expect(env.data.inspected).toBe(3);
      expect(env.data.removed).toEqual(
        expect.arrayContaining([fixture.managedPath, fixture.orphanPath]),
      );
      expect(env.data.removed).toHaveLength(2);
      expect(env.data.failed).toHaveLength(0);
      expect(existsSync(fixture.managedPath)).toBe(false);
      expect(existsSync(fixture.userPath)).toBe(true);
      expect(existsSync(fixture.orphanPath)).toBe(false);
    } finally {
      cleanupFixture(fixture);
    }
  });

  test("force prune falls back to rmSync when git worktree remove fails", async () => {
    const fixture = await setupFixture();
    try {
      writeFileSync(join(fixture.repoRoot, ".git", "worktrees", "managed", "locked"), "locked\n");
      const { stdout, exitCode } = await runCli([
        "--json",
        "worktree",
        "prune",
        "--force",
        "--base-url",
        fixture.baseUrl,
      ]);

      expect([0, 1]).toContain(exitCode);
      const env = JSON.parse(stdout.trim()) as {
        ok: boolean;
        data: {
          removed: string[];
          failed: Array<{ path: string; error: string }>;
        };
      };
      expect(env.ok).toBe(true);
      expect(env.data.removed).toEqual(expect.arrayContaining([fixture.managedPath]));
      if (env.data.failed.length > 0) {
        expect(env.data.failed).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              path: fixture.managedPath,
              error: expect.stringContaining("git worktree remove failed"),
            }),
          ]),
        );
      }
      expect(existsSync(fixture.managedPath)).toBe(false);
    } finally {
      cleanupFixture(fixture);
    }
  });

  test("classifies orphan-no-repo and removes it without --force", async () => {
    const fixture = await setupFixture();
    const orphanNoRepoPath = join(fixture.sandbox, "orphan-no-repo");
    try {
      mkdirSync(orphanNoRepoPath, { recursive: true });
      fixture.persistedPaths.push(orphanNoRepoPath);

      const dryRun = await runCli([
        "--json",
        "worktree",
        "prune",
        "--dry-run",
        "--base-url",
        fixture.baseUrl,
      ]);
      expect(dryRun.exitCode).toBe(0);
      const dryRunEnv = JSON.parse(dryRun.stdout.trim()) as {
        ok: boolean;
        data: {
          candidates: Array<{ path: string; branch: string | null; reason: string }>;
        };
      };
      expect(dryRunEnv.ok).toBe(true);
      expect(dryRunEnv.data.candidates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: orphanNoRepoPath,
            branch: null,
            reason: "orphan-no-repo",
          }),
        ]),
      );

      const prune = await runCli(["--json", "worktree", "prune", "--base-url", fixture.baseUrl]);
      expect(prune.exitCode).toBe(0);
      const pruneEnv = JSON.parse(prune.stdout.trim()) as {
        ok: boolean;
        data: {
          removed: string[];
          failed: Array<{ path: string; error: string }>;
        };
      };
      expect(pruneEnv.ok).toBe(true);
      expect(pruneEnv.data.removed).toEqual(expect.arrayContaining([orphanNoRepoPath]));
      expect(pruneEnv.data.failed).toHaveLength(0);
      expect(existsSync(orphanNoRepoPath)).toBe(false);
    } finally {
      cleanupFixture(fixture);
    }
  });
});
