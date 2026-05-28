// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import "./test-setup.ts";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { TERMINAL_RUN_STATUSES } from "@keelson/shared";
import { Hono } from "hono";

import { bootstrapWorkflows } from "../src/bootstrap.ts";
import { createConversationStore } from "../src/conversation-store.ts";
import { openDatabase } from "../src/db/init.ts";
import { createProjectsStore } from "../src/projects-store.ts";
import { createWorkflowStore } from "../src/workflow-store.ts";
import { workflowsRoutes } from "../src/workflows-handler.ts";

let tmpDir: string;
let repoDir: string;
let wfDir: string;
let dbPath: string;

const ORIGIN = "http://127.0.0.1:5173";
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(TERMINAL_RUN_STATUSES);

async function git(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`git ${args.join(" ")} in ${cwd}: ${err}`);
  }
}

async function initRepo(path: string): Promise<void> {
  await git(["init", "--initial-branch=main"], path);
  await git(["config", "user.email", "t@t"], path);
  await git(["config", "user.name", "t"], path);
  writeFileSync(join(path, "README.md"), "x\n");
  await git(["add", "README.md"], path);
  await git(["commit", "-m", "init"], path);
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keelson-worktree-route-"));
  repoDir = join(tmpDir, "repo");
  mkdirSync(repoDir);
  wfDir = join(tmpDir, "workflows");
  mkdirSync(wfDir);
  dbPath = join(tmpDir, "test.db");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeWorkflow(filename: string, body: string): void {
  writeFileSync(join(wfDir, filename), body);
}

function makeRig() {
  const db = openDatabase({ path: dbPath });
  const store = createWorkflowStore(db);
  const conversationStore = createConversationStore(db);
  const projectsStore = createProjectsStore(db);
  const project = projectsStore.create({ name: "repo", rootPath: repoDir });
  const catalog = bootstrapWorkflows({ workflowDir: wfDir });
  const app = new Hono();
  workflowsRoutes(app, { catalog, store, conversationStore, projectsStore });
  return { app, store, projectId: project.id };
}

async function pollUntilTerminal(
  app: Hono,
  runId: string,
  timeoutMs = 5000,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await app.fetch(new Request(`http://test/api/workflows/runs/${runId}`));
    const body = (await res.json()) as { run: { status: string } };
    if (TERMINAL_STATUSES.has(body.run.status)) return body.run as Record<string, unknown>;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`run ${runId} did not complete in ${timeoutMs}ms`);
}

// The executor's worktree cleanup runs in the executeRunInBackground finally
// block, AFTER the terminal-status write that pollUntilTerminal observes. For
// the success path the worktree dir is removed and `worktree_path` is cleared
// to null; tests that assert post-cleanup state poll on that signal.
async function pollUntilWorktreeCleared(
  app: Hono,
  runId: string,
  timeoutMs = 2000,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await app.fetch(new Request(`http://test/api/workflows/runs/${runId}`));
    const body = (await res.json()) as { run: { worktreePath: string | null } };
    if (body.run.worktreePath === null) return body.run as Record<string, unknown>;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`worktree for run ${runId} not cleared in ${timeoutMs}ms`);
}

describe("workflow run worktree isolation (slice 3)", () => {
  test("YAML worktree.enabled creates a worktree, runs in it, prunes on success", async () => {
    await initRepo(repoDir);
    writeWorkflow(
      "iso.yaml",
      `name: iso
description: write a sentinel file in the worktree so we can confirm cwd
worktree:
  enabled: true
nodes:
  - id: where
    bash: pwd > sentinel.txt && cat sentinel.txt
`,
    );
    const { app, projectId } = makeRig();
    const res = await app.fetch(
      new Request("http://test/api/workflows/iso/runs", {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ inputs: {}, projectId }),
      }),
    );
    expect(res.status).toBe(200);
    const { runId } = (await res.json()) as { runId: string };
    const run = (await pollUntilTerminal(app, runId)) as {
      status: string;
      nodes: Array<{ outputText: string | null }>;
    };
    expect(run.status).toBe("succeeded");
    // The bash node printed `pwd`; assert that path differs from the repo root
    // (sanity check that the worktree was actually used) and lives under the
    // repo-local `.worktrees/` dir.
    const echoed = run.nodes[0]!.outputText?.trim();
    expect(echoed).toBeTruthy();
    expect(echoed).not.toBe(repoDir);
    expect(echoed!.includes(`${sep}.worktrees${sep}`)).toBe(true);

    // Sentinel was written to the worktree, not the source repo.
    expect(existsSync(join(repoDir, "sentinel.txt"))).toBe(false);

    // On success, worktree_path is cleared after the run's finally block
    // runs — race past the terminal-status write before asserting.
    const cleared = (await pollUntilWorktreeCleared(app, runId)) as {
      worktreePath: string | null;
    };
    expect(cleared.worktreePath).toBeNull();
  });

  test("isolation:none override defeats YAML default and runs in place", async () => {
    await initRepo(repoDir);
    writeWorkflow(
      "iso.yaml",
      `name: iso2
description: same isolation default, opt-out per run
worktree:
  enabled: true
nodes:
  - id: where
    bash: pwd
`,
    );
    const { app, projectId } = makeRig();
    const res = await app.fetch(
      new Request("http://test/api/workflows/iso2/runs", {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ inputs: {}, projectId, isolation: "none" }),
      }),
    );
    expect(res.status).toBe(200);
    const { runId } = (await res.json()) as { runId: string };
    const run = (await pollUntilTerminal(app, runId)) as {
      status: string;
      nodes: Array<{ outputText: string | null }>;
      worktreePath: string | null;
    };
    expect(run.status).toBe("succeeded");
    expect(run.worktreePath).toBeNull();
    // pwd should be the repo root, not a worktree.
    const echoed = run.nodes[0]!.outputText?.trim();
    expect(echoed).toBeTruthy();
    expect(echoed!.includes(`${sep}.worktrees${sep}`)).toBe(false);
  });

  test("isolation requested but target is not a git repo: warns, runs in place", async () => {
    // Skip initRepo — directory is not a git repo.
    writeWorkflow(
      "bare.yaml",
      `name: bare
description: bash echoing cwd
nodes:
  - id: where
    bash: pwd
`,
    );
    const { app, projectId } = makeRig();
    const res = await app.fetch(
      new Request("http://test/api/workflows/bare/runs", {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ inputs: {}, projectId, isolation: "worktree" }),
      }),
    );
    expect(res.status).toBe(200);
    const { runId } = (await res.json()) as { runId: string };
    const run = (await pollUntilTerminal(app, runId)) as {
      status: string;
      worktreePath: string | null;
    };
    // Run still succeeds — the warning is broadcast as a run_warning and
    // execution falls back to the repo path.
    expect(run.status).toBe("succeeded");
    expect(run.worktreePath).toBeNull();
  });

  test("failed run keeps its worktree on disk for inspection", async () => {
    await initRepo(repoDir);
    writeWorkflow(
      "boom.yaml",
      `name: boom
description: deliberate failure inside a worktree
worktree:
  enabled: true
nodes:
  - id: blow
    bash: exit 1
`,
    );
    const { app, store, projectId } = makeRig();
    const res = await app.fetch(
      new Request("http://test/api/workflows/boom/runs", {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ inputs: {}, projectId }),
      }),
    );
    const { runId } = (await res.json()) as { runId: string };
    const run = (await pollUntilTerminal(app, runId)) as { status: string };
    expect(run.status).toBe("failed");

    const detail = store.getRun(runId);
    expect(detail).toBeDefined();
    expect(detail!.worktreePath).not.toBeNull();
    // The worktree directory should still exist for the operator to inspect.
    expect(existsSync(detail!.worktreePath!)).toBe(true);
  });
});
