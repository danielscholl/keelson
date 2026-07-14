// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import "./test-setup.ts";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
import { createWorkspaceLeaseStore } from "../src/workspace-lease-store.ts";
import { createWorkspaceManager } from "../src/workspace-manager.ts";
import { rmTemp } from "./temp.ts";

let tmpDir: string;
let repoDir: string;
let wfDir: string;
let dbPath: string;

const ORIGIN = "http://127.0.0.1:5173";
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(TERMINAL_RUN_STATUSES);

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

async function gitText(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} in ${cwd}: ${stderr}`);
  }
  return stdout;
}

async function bunInstall(cwd: string): Promise<void> {
  const proc = Bun.spawn({
    cmd: ["bun", "install"],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    windowsHide: true,
  });
  const [, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`bun install in ${cwd}: ${err}`);
}

async function initRepo(path: string): Promise<void> {
  await git(["init", "--initial-branch=main"], path);
  await git(["config", "user.email", "t@t"], path);
  await git(["config", "user.name", "t"], path);
  writeFileSync(join(path, "README.md"), "x\n");
  await git(["add", "README.md"], path);
  await git(["commit", "-m", "init"], path);
}

async function addOrigin(path: string): Promise<void> {
  const remote = join(path, "origin.git");
  await git(["init", "--bare", "--initial-branch=main", remote], path);
  await git(["remote", "add", "origin", remote], path);
  await git(["push", "-u", "origin", "main"], path);
  await git(["remote", "set-head", "origin", "-a"], path);
}

beforeEach(() => {
  tmpDir = realpathSync.native(mkdtempSync(join(tmpdir(), "keelson-worktree-route-")));
  repoDir = join(tmpDir, "repo");
  mkdirSync(repoDir);
  wfDir = join(tmpDir, "workflows");
  mkdirSync(wfDir);
  dbPath = join(tmpDir, "test.db");
});

afterEach(() => {
  rmTemp(tmpDir);
});

function writeWorkflow(filename: string, body: string): void {
  writeFileSync(join(wfDir, filename), body);
}

function makeRig(opts: { includeWorkspaceManager?: boolean; projectRootPath?: string } = {}) {
  const db = openDatabase({ path: dbPath });
  const store = createWorkflowStore(db);
  const conversationStore = createConversationStore(db);
  const projectsStore = createProjectsStore(db);
  const workspaceManager = createWorkspaceManager({
    store: createWorkspaceLeaseStore(db),
    projectsStore,
  });
  const project = projectsStore.create({
    name: "repo",
    rootPath: opts.projectRootPath ?? repoDir,
  });
  const catalog = bootstrapWorkflows({ workflowDir: wfDir });
  const app = new Hono();
  workflowsRoutes(app, {
    catalog,
    store,
    conversationStore,
    projectsStore,
    ...(opts.includeWorkspaceManager === false ? {} : { workspaceManager }),
  });
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
    expect(echoed!.replace(/\\/g, "/").includes("/.worktrees/")).toBe(true);

    // Sentinel was written to the worktree, not the source repo.
    expect(existsSync(join(repoDir, "sentinel.txt"))).toBe(false);

    // On success, worktree_path is cleared after the run's finally block
    // runs — race past the terminal-status write before asserting.
    const cleared = (await pollUntilWorktreeCleared(app, runId)) as {
      worktreePath: string | null;
    };
    expect(cleared.worktreePath).toBeNull();
  });

  // Local dep links come from the checkout root, which a run's workingDir is
  // allowed to sit below.
  for (const includeWorkspaceManager of [true, false]) {
    test(`restores a root local dep link for a run started in a subdirectory (workspaceManager=${includeWorkspaceManager})`, async () => {
      await initRepo(repoDir);
      // A manifest + lockfile so the worktree actually installs; link
      // reproduction runs after a successful install. The workspace dep is what
      // makes bun emit a lockfile at all.
      writeFileSync(
        join(repoDir, "package.json"),
        JSON.stringify(
          {
            name: "linkiso-root",
            version: "0.0.0",
            private: true,
            workspaces: ["fixture"],
            dependencies: { "@fixture/base": "workspace:*" },
          },
          null,
          2,
        ),
      );
      mkdirSync(join(repoDir, "fixture"), { recursive: true });
      writeFileSync(
        join(repoDir, "fixture", "package.json"),
        JSON.stringify({ name: "@fixture/base", version: "0.0.0" }, null, 2),
      );
      await bunInstall(repoDir);
      await git(["add", "package.json", "fixture/package.json", "bun.lock"], repoDir);
      await git(["commit", "-m", "add manifest"], repoDir);

      const external = join(tmpDir, "external-pkg");
      mkdirSync(external, { recursive: true });
      writeFileSync(join(external, "index.js"), "module.exports = 'linked';\n");
      // The link lives in the ROOT's node_modules, gitignored, outside the repo.
      // "junction" so the fixture resolves on Windows, where the default "file"
      // type would produce a broken link to a directory.
      mkdirSync(join(repoDir, "node_modules", "@scope"), { recursive: true });
      symlinkSync(
        external,
        join(repoDir, "node_modules", "@scope", "pkg"),
        process.platform === "win32" ? "junction" : undefined,
      );
      const subdir = join(repoDir, "packages", "nested");
      mkdirSync(subdir, { recursive: true });

      writeWorkflow(
        "linkiso.yaml",
        `name: linkiso
description: report whether the root local dep link survived into the worktree
worktree:
  enabled: true
nodes:
  - id: probe
    bash: |
      test -e node_modules/@scope/pkg && echo LINK_PRESENT
`,
      );
      const { app, projectId } = makeRig({ includeWorkspaceManager });
      const res = await app.fetch(
        new Request("http://test/api/workflows/linkiso/runs", {
          method: "POST",
          headers: { origin: ORIGIN, "content-type": "application/json" },
          // Start BELOW the checkout root — the case that regresses.
          body: JSON.stringify({ inputs: {}, projectId, workingDir: subdir }),
        }),
      );
      expect(res.status).toBe(200);
      const { runId } = (await res.json()) as { runId: string };
      const run = (await pollUntilTerminal(app, runId)) as {
        status: string;
        nodes: Array<{ outputText: string | null }>;
      };
      expect(run.status).toBe("succeeded");
      const probe = run.nodes[0]!.outputText ?? "";
      expect(probe).toContain("LINK_PRESENT");
    });
  }

  for (const includeWorkspaceManager of [true, false]) {
    test(`resume restores local dep links from the linked source checkout (workspaceManager=${includeWorkspaceManager})`, async () => {
      await initRepo(repoDir);
      writeFileSync(
        join(repoDir, "package.json"),
        JSON.stringify(
          {
            name: "resume-link-root",
            version: "0.0.0",
            private: true,
            workspaces: ["fixture"],
            dependencies: { "@fixture/base": "workspace:*" },
          },
          null,
          2,
        ),
      );
      mkdirSync(join(repoDir, "fixture"), { recursive: true });
      writeFileSync(
        join(repoDir, "fixture", "package.json"),
        JSON.stringify({ name: "@fixture/base", version: "0.0.0" }, null, 2),
      );
      await bunInstall(repoDir);
      await git(["add", "package.json", "fixture/package.json", "bun.lock"], repoDir);
      await git(["commit", "-m", "add manifest"], repoDir);

      const sourceCheckout = join(tmpDir, "source-checkout");
      await git(["worktree", "add", "-b", "linked-source", sourceCheckout], repoDir);
      await bunInstall(sourceCheckout);
      const external = join(tmpDir, "resume-external-pkg");
      mkdirSync(external, { recursive: true });
      mkdirSync(join(sourceCheckout, "node_modules", "@scope"), { recursive: true });
      symlinkSync(
        external,
        join(sourceCheckout, "node_modules", "@scope", "pkg"),
        process.platform === "win32" ? "junction" : undefined,
      );
      const subdir = join(sourceCheckout, "packages", "nested");
      mkdirSync(subdir, { recursive: true });

      writeWorkflow(
        "resume-link.yaml",
        `name: resume-link
description: restore a linked dependency before re-entering a failed worktree
worktree:
  enabled: true
nodes:
  - id: probe
    bash: |
      test -e node_modules/@scope/pkg
      if [ ! -f .resume-ready ]; then touch .resume-ready; exit 1; fi
      echo LINK_PRESENT
`,
      );
      const { app, projectId } = makeRig({
        includeWorkspaceManager,
        projectRootPath: sourceCheckout,
      });
      const start = await app.fetch(
        new Request("http://test/api/workflows/resume-link/runs", {
          method: "POST",
          headers: { origin: ORIGIN, "content-type": "application/json" },
          body: JSON.stringify({ inputs: {}, projectId, workingDir: subdir }),
        }),
      );
      expect(start.status).toBe(200);
      const { runId } = (await start.json()) as { runId: string };
      const failed = (await pollUntilTerminal(app, runId)) as {
        status: string;
        worktreePath: string | null;
      };
      expect(failed.status).toBe("failed");
      expect(failed.worktreePath).toBeTruthy();
      if (failed.worktreePath === null) throw new Error("failed run did not retain its worktree");
      rmSync(join(failed.worktreePath, "node_modules", "@scope", "pkg"), {
        recursive: true,
        force: true,
      });

      const resume = await app.fetch(
        new Request(`http://test/api/workflows/runs/${runId}/resume-run`, {
          method: "POST",
          headers: { origin: ORIGIN, "content-type": "application/json" },
          body: JSON.stringify({}),
        }),
      );
      expect(resume.status).toBe(200);
      const completed = (await pollUntilTerminal(app, runId)) as {
        status: string;
        nodes: Array<{ outputText: string | null }>;
      };
      expect(completed.status).toBe("succeeded");
      expect(completed.nodes[0]!.outputText).toContain("LINK_PRESENT");
    });
  }

  test("worktree isolation still runs when workspaceManager is omitted", async () => {
    await initRepo(repoDir);
    writeWorkflow(
      "iso-no-manager.yaml",
      `name: iso-no-manager
description: isolate with primitive fallback
worktree:
  enabled: true
nodes:
  - id: where
    bash: pwd
`,
    );
    const { app, projectId } = makeRig({ includeWorkspaceManager: false });
    const res = await app.fetch(
      new Request("http://test/api/workflows/iso-no-manager/runs", {
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
    const echoed = run.nodes[0]!.outputText?.trim();
    expect(echoed).toBeTruthy();
    expect(echoed).not.toBe(repoDir);
    expect(echoed!.replace(/\\/g, "/").includes("/.worktrees/")).toBe(true);

    const cleared = (await pollUntilWorktreeCleared(app, runId)) as {
      worktreePath: string | null;
    };
    expect(cleared.worktreePath).toBeNull();
  });

  test("refresh honors a bound producer's worktree.enabled policy", async () => {
    await initRepo(repoDir);
    writeWorkflow(
      "isoprod.yaml",
      `name: isoprod
description: a bound producer that opts into worktree isolation
worktree:
  enabled: true
nodes:
  - id: where
    bash: pwd
`,
    );
    const db = openDatabase({ path: dbPath });
    const store = createWorkflowStore(db);
    const conversationStore = createConversationStore(db);
    const projectsStore = createProjectsStore(db);
    const workspaceManager = createWorkspaceManager({
      store: createWorkspaceLeaseStore(db),
      projectsStore,
    });
    const catalog = bootstrapWorkflows({ workflowDir: wfDir });
    const producer = catalog.get("isoprod");
    if (!producer) throw new Error("fixture workflow missing");
    const bindings = new Map([[producer, { publish: () => {} }]]);
    const app = new Hono();
    workflowsRoutes(app, {
      catalog,
      store,
      conversationStore,
      refreshCwd: repoDir,
      ribWorkflowBindings: bindings,
      workspaceManager,
    });
    const res = await app.fetch(
      new Request("http://test/api/workflows/isoprod/refresh", {
        method: "POST",
        headers: { origin: ORIGIN },
      }),
    );
    expect(res.status).toBe(200);
    const { runId } = (await res.json()) as { runId: string };
    const run = (await pollUntilTerminal(app, runId)) as {
      status: string;
      nodes: Array<{ outputText: string | null }>;
    };
    expect(run.status).toBe("succeeded");
    // The refresh ran in an isolated worktree, not the live checkout — without
    // honoring the policy this pwd would be `repoDir`.
    const echoed = run.nodes[0]!.outputText?.trim();
    expect(echoed).not.toBe(repoDir);
    expect(echoed!.replace(/\\/g, "/").includes("/.worktrees/")).toBe(true);
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

  test("default base excludes divergent checkout commits and is exposed on run detail", async () => {
    await initRepo(repoDir);
    await addOrigin(repoDir);
    await git(["checkout", "-b", "feature"], repoDir);
    writeFileSync(join(repoDir, "feature.txt"), "feature\n");
    await git(["add", "feature.txt"], repoDir);
    await git(["commit", "-m", "feature"], repoDir);
    writeWorkflow(
      "base.yaml",
      `name: basecheck
description: verify isolated worktree starts from default branch
worktree:
  enabled: true
nodes:
  - id: no-feature
    bash: test ! -f feature.txt
`,
    );
    const { app, projectId } = makeRig();
    const res = await app.fetch(
      new Request("http://test/api/workflows/basecheck/runs", {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ inputs: {}, projectId }),
      }),
    );
    expect(res.status).toBe(200);
    const { runId } = (await res.json()) as { runId: string };
    const run = (await pollUntilTerminal(app, runId)) as {
      status: string;
      worktreeBase: string | null;
    };

    expect(run.status).toBe("succeeded");
    expect(run.worktreeBase).toBe("origin/main");
    const branch = `keelson/basecheck/${runId.slice(0, 8)}`;
    expect((await gitText(["log", "--oneline", `origin/main..${branch}`], repoDir)).trim()).toBe(
      "",
    );
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
