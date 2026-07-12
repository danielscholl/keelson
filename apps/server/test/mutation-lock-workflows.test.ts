// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import "./test-setup.ts";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TERMINAL_RUN_STATUSES } from "@keelson/shared";
import { Hono } from "hono";
import { bootstrapWorkflows } from "../src/bootstrap.ts";
import { createConversationStore } from "../src/conversation-store.ts";
import { openDatabase } from "../src/db/init.ts";
import { createMutationLockManager } from "../src/mutation-lock-manager.ts";
import { createMutationLockStore } from "../src/mutation-lock-store.ts";
import { createProjectsStore } from "../src/projects-store.ts";
import { createWorkflowStore, type WorkflowStore } from "../src/workflow-store.ts";
import {
  createActiveRuns,
  createWorkflowSubscribers,
  workflowsRoutes,
} from "../src/workflows-handler.ts";
import { rmTemp } from "./temp.ts";

const ORIGIN = "http://127.0.0.1:5173";
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(TERMINAL_RUN_STATUSES);

let tmpDir: string;
let wfDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keelson-mutation-lock-workflows-"));
  wfDir = join(tmpDir, "workflows");
  mkdirSync(wfDir);
});

afterEach(() => {
  rmTemp(tmpDir);
});

function writeWorkflow(filename: string, body: string): void {
  writeFileSync(join(wfDir, filename), body);
}

async function git(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    windowsHide: true,
  });
  // Drain both pipes even on success: an undrained pipe read-end stays an open
  // handle on win32 that can block bun test from exiting.
  const [, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
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

function postJson(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function pollUntilStoreStatus(
  store: WorkflowStore,
  runId: string,
  predicate: (status: string | undefined) => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate(store.getRun(runId)?.status)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`run ${runId} did not reach expected status`);
}

async function pollUntilTerminal(
  store: WorkflowStore,
  runId: string,
  timeoutMs = 2000,
): Promise<void> {
  await pollUntilStoreStatus(
    store,
    runId,
    (status) => status !== undefined && TERMINAL_STATUSES.has(status),
    timeoutMs,
  );
}

describe("workflow mutation lock enforcement", () => {
  test("a second live-checkout mutating run conflicts until the first settles", async () => {
    writeWorkflow(
      "guarded.yaml",
      `name: guarded
description: waits under the mutation lock
nodes:
  - id: review
    approval:
      message: hold the lock
`,
    );
    const db = openDatabase({ path: join(tmpDir, "test.db") });
    const store = createWorkflowStore(db);
    const conversationStore = createConversationStore(db);
    const projectsStore = createProjectsStore(db);
    const project = projectsStore.create({ name: "repo", rootPath: tmpDir });
    const mutationLockStore = createMutationLockStore();
    const mutationLockManager = createMutationLockManager({ store: mutationLockStore });
    const activeRuns = createActiveRuns();
    const catalog = bootstrapWorkflows({
      workflowDir: wfDir,
      listProjects: () => projectsStore.list(),
    });
    const app = new Hono();
    workflowsRoutes(
      app,
      {
        catalog,
        store,
        conversationStore,
        projectsStore,
        mutationLockManager,
      },
      activeRuns,
      createWorkflowSubscribers(),
    );
    try {
      const firstRes = await app.fetch(
        postJson("http://test/api/workflows/guarded/runs", {
          inputs: {},
          projectId: project.id,
        }),
      );
      expect(firstRes.status).toBe(200);
      const first = (await firstRes.json()) as { runId: string };
      await pollUntilStoreStatus(store, first.runId, (status) => status === "paused");

      const conflictRes = await app.fetch(
        postJson("http://test/api/workflows/guarded/runs", {
          inputs: {},
          projectId: project.id,
        }),
      );
      expect(conflictRes.status).toBe(409);
      const conflict = (await conflictRes.json()) as { error: string };
      expect(conflict.error).toContain(`project ${project.id} is locked by workflow:`);
      expect(conflict.error).toContain('for "guarded"');
      expect(conflict.error).toContain(first.runId.slice(0, 8));

      const resumeRes = await app.fetch(
        postJson(`http://test/api/workflows/runs/${first.runId}/resume`, {
          nodeId: "review",
          text: "approve",
        }),
      );
      expect(resumeRes.status).toBe(200);
      await pollUntilTerminal(store, first.runId);

      const afterReleaseRes = await app.fetch(
        postJson("http://test/api/workflows/guarded/runs", {
          inputs: {},
          projectId: project.id,
        }),
      );
      expect(afterReleaseRes.status).toBe(200);
    } finally {
      await activeRuns.abortAll();
      db.close();
    }
  });

  test("workingDir override locks the project containing execution cwd", async () => {
    writeWorkflow(
      "guarded-override.yaml",
      `name: guarded-override
description: waits under the mutation lock
nodes:
  - id: review
    approval:
      message: hold the lock
`,
    );
    const db = openDatabase({ path: join(tmpDir, "test.db") });
    const store = createWorkflowStore(db);
    const conversationStore = createConversationStore(db);
    const projectsStore = createProjectsStore(db);
    const repoA = join(tmpDir, "repo-a");
    const repoB = join(tmpDir, "repo-b");
    mkdirSync(repoA);
    mkdirSync(repoB);
    const projectA = projectsStore.create({ name: "repo-a", rootPath: repoA });
    const projectB = projectsStore.create({ name: "repo-b", rootPath: repoB });
    const mutationLockStore = createMutationLockStore();
    const mutationLockManager = createMutationLockManager({ store: mutationLockStore });
    const activeRuns = createActiveRuns();
    const catalog = bootstrapWorkflows({
      workflowDir: wfDir,
      listProjects: () => projectsStore.list(),
    });
    const app = new Hono();
    workflowsRoutes(
      app,
      {
        catalog,
        store,
        conversationStore,
        projectsStore,
        mutationLockManager,
      },
      activeRuns,
      createWorkflowSubscribers(),
    );
    try {
      const firstRes = await app.fetch(
        postJson("http://test/api/workflows/guarded-override/runs", {
          inputs: {},
          projectId: projectA.id,
          workingDir: repoB,
        }),
      );
      expect(firstRes.status).toBe(200);
      const first = (await firstRes.json()) as { runId: string };
      await pollUntilStoreStatus(store, first.runId, (status) => status === "paused");

      const conflictRes = await app.fetch(
        postJson("http://test/api/workflows/guarded-override/runs", {
          inputs: {},
          projectId: projectB.id,
        }),
      );
      expect(conflictRes.status).toBe(409);
      const conflict = (await conflictRes.json()) as { error: string };
      expect(conflict.error).toContain(`project ${projectB.id} is locked by workflow:`);
      expect(conflict.error).not.toContain(`project ${projectA.id} is locked by workflow:`);

      const unaffectedRes = await app.fetch(
        postJson("http://test/api/workflows/guarded-override/runs", {
          inputs: {},
          projectId: projectA.id,
        }),
      );
      expect(unaffectedRes.status).toBe(200);
    } finally {
      await activeRuns.abortAll();
      db.close();
    }
  });

  test("isolation fallback acquires mutation lock before running in place", async () => {
    writeWorkflow(
      "guarded-fallback.yaml",
      `name: guarded-fallback
description: waits under the mutation lock
nodes:
  - id: review
    approval:
      message: hold the lock
`,
    );
    const db = openDatabase({ path: join(tmpDir, "test.db") });
    const store = createWorkflowStore(db);
    const conversationStore = createConversationStore(db);
    const projectsStore = createProjectsStore(db);
    const project = projectsStore.create({ name: "repo", rootPath: tmpDir });
    const mutationLockStore = createMutationLockStore();
    const mutationLockManager = createMutationLockManager({ store: mutationLockStore });
    const activeRuns = createActiveRuns();
    const catalog = bootstrapWorkflows({
      workflowDir: wfDir,
      listProjects: () => projectsStore.list(),
    });
    const app = new Hono();
    workflowsRoutes(
      app,
      {
        catalog,
        store,
        conversationStore,
        projectsStore,
        mutationLockManager,
      },
      activeRuns,
      createWorkflowSubscribers(),
    );
    try {
      const firstRes = await app.fetch(
        postJson("http://test/api/workflows/guarded-fallback/runs", {
          inputs: {},
          projectId: project.id,
        }),
      );
      expect(firstRes.status).toBe(200);
      const first = (await firstRes.json()) as { runId: string };
      await pollUntilStoreStatus(store, first.runId, (status) => status === "paused");

      const fallbackRes = await app.fetch(
        postJson("http://test/api/workflows/guarded-fallback/runs", {
          inputs: {},
          projectId: project.id,
          isolation: "worktree",
        }),
      );
      expect(fallbackRes.status).toBe(200);
      const fallback = (await fallbackRes.json()) as { runId: string };
      await pollUntilTerminal(store, fallback.runId);
      const fallbackRun = store.getRun(fallback.runId);
      expect(fallbackRun?.status).toBe("failed");
      expect(fallbackRun?.error).toContain(`project ${project.id} is locked by workflow:`);
    } finally {
      await activeRuns.abortAll();
      db.close();
    }
  });

  test("a mutates_checkout:false run starts while the project lock is held", async () => {
    writeWorkflow(
      "guarded.yaml",
      `name: guarded
description: holds the mutation lock at an approval
nodes:
  - id: review
    approval:
      message: hold the lock
`,
    );
    writeWorkflow(
      "readonly.yaml",
      `name: readonly
description: read-only, exempt from the mutation lock
mutates_checkout: false
nodes:
  - id: noop
    bash: "true"
`,
    );
    const db = openDatabase({ path: join(tmpDir, "test.db") });
    const store = createWorkflowStore(db);
    const conversationStore = createConversationStore(db);
    const projectsStore = createProjectsStore(db);
    const project = projectsStore.create({ name: "repo", rootPath: tmpDir });
    const mutationLockStore = createMutationLockStore();
    const mutationLockManager = createMutationLockManager({ store: mutationLockStore });
    const activeRuns = createActiveRuns();
    const catalog = bootstrapWorkflows({
      workflowDir: wfDir,
      listProjects: () => projectsStore.list(),
    });
    const app = new Hono();
    workflowsRoutes(
      app,
      { catalog, store, conversationStore, projectsStore, mutationLockManager },
      activeRuns,
      createWorkflowSubscribers(),
    );
    try {
      const firstRes = await app.fetch(
        postJson("http://test/api/workflows/guarded/runs", { inputs: {}, projectId: project.id }),
      );
      expect(firstRes.status).toBe(200);
      const first = (await firstRes.json()) as { runId: string };
      await pollUntilStoreStatus(store, first.runId, (status) => status === "paused");

      // The read-only workflow never takes the lock, so it starts despite the hold.
      const exemptRes = await app.fetch(
        postJson("http://test/api/workflows/readonly/runs", { inputs: {}, projectId: project.id }),
      );
      expect(exemptRes.status).toBe(200);
      const exempt = (await exemptRes.json()) as { runId: string };
      await pollUntilTerminal(store, exempt.runId);
      expect(store.getRun(exempt.runId)?.status).toBe("succeeded");
    } finally {
      await activeRuns.abortAll();
      db.close();
    }
  });

  test("a successfully worktree-isolated run starts while the project lock is held", async () => {
    const repo = join(tmpDir, "iso-repo");
    mkdirSync(repo);
    await initRepo(repo);
    writeWorkflow(
      "guarded-live.yaml",
      `name: guarded-live
description: holds the in-place mutation lock at an approval
nodes:
  - id: review
    approval:
      message: hold the lock
`,
    );
    writeWorkflow(
      "iso.yaml",
      `name: iso
description: worktree-isolated, runs outside the live checkout
worktree:
  enabled: true
nodes:
  - id: where
    bash: pwd
`,
    );
    const db = openDatabase({ path: join(tmpDir, "test.db") });
    const store = createWorkflowStore(db);
    const conversationStore = createConversationStore(db);
    const projectsStore = createProjectsStore(db);
    const project = projectsStore.create({ name: "iso-repo", rootPath: repo });
    const mutationLockStore = createMutationLockStore();
    const mutationLockManager = createMutationLockManager({ store: mutationLockStore });
    const activeRuns = createActiveRuns();
    const catalog = bootstrapWorkflows({
      workflowDir: wfDir,
      listProjects: () => projectsStore.list(),
    });
    const app = new Hono();
    workflowsRoutes(
      app,
      { catalog, store, conversationStore, projectsStore, mutationLockManager },
      activeRuns,
      createWorkflowSubscribers(),
    );
    try {
      const firstRes = await app.fetch(
        postJson("http://test/api/workflows/guarded-live/runs", {
          inputs: {},
          projectId: project.id,
        }),
      );
      expect(firstRes.status).toBe(200);
      const first = (await firstRes.json()) as { runId: string };
      await pollUntilStoreStatus(store, first.runId, (status) => status === "paused");

      // Isolation succeeds (real git repo), so the run never falls back to the
      // in-place lock and must not conflict with the held live-checkout lock.
      const isoRes = await app.fetch(
        postJson("http://test/api/workflows/iso/runs", {
          inputs: {},
          projectId: project.id,
          isolation: "worktree",
        }),
      );
      expect(isoRes.status).toBe(200);
      const iso = (await isoRes.json()) as { runId: string };
      await pollUntilTerminal(store, iso.runId);
      const isoRun = store.getRun(iso.runId);
      expect(isoRun?.status).toBe("succeeded");
      expect(isoRun?.error ?? "").not.toContain("is locked by workflow");
    } finally {
      await activeRuns.abortAll();
      db.close();
    }
  });

  test("resume of a failed live-checkout run conflicts on a held lock, then succeeds once released", async () => {
    writeWorkflow(
      "failing.yaml",
      `name: failing
description: fails fast so the run becomes resumable
nodes:
  - id: boom
    bash: exit 1
`,
    );
    writeWorkflow(
      "guarded-hold.yaml",
      `name: guarded-hold
description: holds the project mutation lock at an approval
nodes:
  - id: review
    approval:
      message: hold the lock
`,
    );
    const db = openDatabase({ path: join(tmpDir, "test.db") });
    const store = createWorkflowStore(db);
    const conversationStore = createConversationStore(db);
    const projectsStore = createProjectsStore(db);
    const project = projectsStore.create({ name: "repo", rootPath: tmpDir });
    const mutationLockStore = createMutationLockStore();
    const mutationLockManager = createMutationLockManager({ store: mutationLockStore });
    const activeRuns = createActiveRuns();
    const catalog = bootstrapWorkflows({
      workflowDir: wfDir,
      listProjects: () => projectsStore.list(),
    });
    const app = new Hono();
    workflowsRoutes(
      app,
      { catalog, store, conversationStore, projectsStore, mutationLockManager },
      activeRuns,
      createWorkflowSubscribers(),
    );
    try {
      // A first run fails, leaving a resumable failed run (its lock released on settle).
      const failRes = await app.fetch(
        postJson("http://test/api/workflows/failing/runs", { inputs: {}, projectId: project.id }),
      );
      const failed = (await failRes.json()) as { runId: string };
      await pollUntilTerminal(store, failed.runId);
      expect(store.getRun(failed.runId)?.status).toBe("failed");

      // Hold the project lock with a paused approval run.
      const holdRes = await app.fetch(
        postJson("http://test/api/workflows/guarded-hold/runs", {
          inputs: {},
          projectId: project.id,
        }),
      );
      const hold = (await holdRes.json()) as { runId: string };
      await pollUntilStoreStatus(store, hold.runId, (status) => status === "paused");

      // Resuming the failed run now conflicts on the held lock — a distinct 409 with
      // the lock-holder message, NOT the "only failed/cancelled can resume" error.
      const conflictRes = await app.fetch(
        postJson(`http://test/api/workflows/runs/${failed.runId}/resume-run`, {}),
      );
      expect(conflictRes.status).toBe(409);
      const conflict = (await conflictRes.json()) as { error: string };
      expect(conflict.error).toContain(`project ${project.id} is locked by workflow:`);

      // Release the lock; the resumed run then holds it and releases it on settle.
      await app.fetch(
        postJson(`http://test/api/workflows/runs/${hold.runId}/resume`, {
          nodeId: "review",
          text: "approve",
        }),
      );
      await pollUntilTerminal(store, hold.runId);

      const okRes = await app.fetch(
        postJson(`http://test/api/workflows/runs/${failed.runId}/resume-run`, {}),
      );
      expect(okRes.status).toBe(200);
      // The resumed run released the project lock once it settled.
      const releaseDeadline = Date.now() + 2000;
      while (
        Date.now() < releaseDeadline &&
        mutationLockStore.getByProject(project.id) !== undefined
      ) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(mutationLockStore.getByProject(project.id)).toBeUndefined();
    } finally {
      await activeRuns.abortAll();
      db.close();
    }
  });

  test("resume of a succeeded run reports not-resumable, not locked, under a held lock", async () => {
    writeWorkflow(
      "done-ok.yaml",
      `name: done-ok
description: succeeds so it is not resumable
nodes:
  - id: ok
    bash: "true"
`,
    );
    writeWorkflow(
      "guarded-hold.yaml",
      `name: guarded-hold
description: holds the project mutation lock at an approval
nodes:
  - id: review
    approval:
      message: hold the lock
`,
    );
    const db = openDatabase({ path: join(tmpDir, "test.db") });
    const store = createWorkflowStore(db);
    const conversationStore = createConversationStore(db);
    const projectsStore = createProjectsStore(db);
    const project = projectsStore.create({ name: "repo", rootPath: tmpDir });
    const mutationLockStore = createMutationLockStore();
    const mutationLockManager = createMutationLockManager({ store: mutationLockStore });
    const activeRuns = createActiveRuns();
    const catalog = bootstrapWorkflows({
      workflowDir: wfDir,
      listProjects: () => projectsStore.list(),
    });
    const app = new Hono();
    workflowsRoutes(
      app,
      { catalog, store, conversationStore, projectsStore, mutationLockManager },
      activeRuns,
      createWorkflowSubscribers(),
    );
    try {
      const okRes = await app.fetch(
        postJson("http://test/api/workflows/done-ok/runs", { inputs: {}, projectId: project.id }),
      );
      const done = (await okRes.json()) as { runId: string };
      await pollUntilTerminal(store, done.runId);
      expect(store.getRun(done.runId)?.status).toBe("succeeded");

      const holdRes = await app.fetch(
        postJson("http://test/api/workflows/guarded-hold/runs", {
          inputs: {},
          projectId: project.id,
        }),
      );
      const hold = (await holdRes.json()) as { runId: string };
      await pollUntilStoreStatus(store, hold.runId, (status) => status === "paused");

      // The lock is never acquired for a non-resumable run, so this reports the
      // accurate not-resumable error rather than a misleading lock conflict.
      const res = await app.fetch(
        postJson(`http://test/api/workflows/runs/${done.runId}/resume-run`, {}),
      );
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("not in a resumable state");
      expect(body.error).not.toContain("is locked by workflow");
    } finally {
      await activeRuns.abortAll();
      db.close();
    }
  });

  test("resume of a failed worktree-isolated run is exempt from a held project lock", async () => {
    const repo = join(tmpDir, "iso-resume-repo");
    mkdirSync(repo);
    await initRepo(repo);
    writeWorkflow(
      "iso-boom.yaml",
      `name: iso-boom
description: fails inside an isolated worktree
worktree:
  enabled: true
nodes:
  - id: boom
    bash: exit 1
`,
    );
    writeWorkflow(
      "guarded-hold.yaml",
      `name: guarded-hold
description: holds the project mutation lock at an approval
nodes:
  - id: review
    approval:
      message: hold the lock
`,
    );
    const db = openDatabase({ path: join(tmpDir, "test.db") });
    const store = createWorkflowStore(db);
    const conversationStore = createConversationStore(db);
    const projectsStore = createProjectsStore(db);
    const project = projectsStore.create({ name: "iso-resume-repo", rootPath: repo });
    const mutationLockStore = createMutationLockStore();
    const mutationLockManager = createMutationLockManager({ store: mutationLockStore });
    const activeRuns = createActiveRuns();
    const catalog = bootstrapWorkflows({
      workflowDir: wfDir,
      listProjects: () => projectsStore.list(),
    });
    const app = new Hono();
    workflowsRoutes(
      app,
      { catalog, store, conversationStore, projectsStore, mutationLockManager },
      activeRuns,
      createWorkflowSubscribers(),
    );
    try {
      // A failed worktree run keeps its worktree on disk (worktreePath set).
      const failRes = await app.fetch(
        postJson("http://test/api/workflows/iso-boom/runs", {
          inputs: {},
          projectId: project.id,
          isolation: "worktree",
        }),
      );
      const failed = (await failRes.json()) as { runId: string };
      await pollUntilTerminal(store, failed.runId);
      expect(store.getRun(failed.runId)?.status).toBe("failed");
      expect(store.getRun(failed.runId)?.worktreePath).not.toBeNull();

      // Hold the project lock.
      const holdRes = await app.fetch(
        postJson("http://test/api/workflows/guarded-hold/runs", {
          inputs: {},
          projectId: project.id,
        }),
      );
      const hold = (await holdRes.json()) as { runId: string };
      await pollUntilStoreStatus(store, hold.runId, (status) => status === "paused");

      // The resumed run re-enters its worktree, so it never takes the project lock:
      // resume succeeds despite the held lock (the worktree-resume exemption).
      const resumeRes = await app.fetch(
        postJson(`http://test/api/workflows/runs/${failed.runId}/resume-run`, {}),
      );
      expect(resumeRes.status).toBe(200);
    } finally {
      await activeRuns.abortAll();
      db.close();
    }
  });
});
