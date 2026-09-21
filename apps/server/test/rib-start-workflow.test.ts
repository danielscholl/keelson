// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import "./test-setup.ts";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRegisteredProvider, registerStubProvider } from "@keelson/providers";
import type { Rib, RibContext, RibRunEvent } from "@keelson/shared";
import { parseRibWorkflowGrants } from "@keelson/shared/config";
import type { WorkflowDefinition } from "@keelson/workflows";
import { bootstrapRibs, bootstrapWorkflows } from "../src/bootstrap.ts";
import { createConversationStore } from "../src/conversation-store.ts";
import { openDatabase } from "../src/db/init.ts";
import type { PolicyEngine } from "../src/policy-engine.ts";
import { createProjectsStore } from "../src/projects-store.ts";
import { createRunEventDispatcher } from "../src/ribs.ts";
import { createWorkflowStore } from "../src/workflow-store.ts";
import {
  createActiveRuns,
  createWorkflowController,
  createWorkflowSubscribers,
} from "../src/workflows-handler.ts";
import { rmTemp } from "./temp.ts";

async function until(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function policyEngine(
  evaluateToolCall: PolicyEngine["evaluateToolCall"] = async () => ({ outcome: "allow" }),
): PolicyEngine {
  return {
    projectTools: async (candidates) => ({ allowed: [...candidates], denied: [] }),
    evaluateToolCall,
    evaluateRequest: async () => ({ outcome: "allow" }),
    evaluateToolResult: async () => ({ outcome: "allow" }),
    evaluateResponse: async () => ({ outcome: "allow" }),
    requestPhaseActive: false,
    resultPhaseActive: false,
    responsePhaseActive: false,
  };
}

const WORKFLOWS: WorkflowDefinition[] = [
  {
    name: "quick",
    description: "Use when: exercising the rib start seam",
    nodes: [{ id: "work", bash: "echo done" }],
  },
  {
    name: "gated",
    description: "Use when: exercising the paused state",
    nodes: [{ id: "review", approval: { message: "ship it?" } }],
  },
  {
    name: "two-gates",
    description: "Use when: exercising parallel approval gates",
    nodes: [
      { id: "a", approval: { message: "first?" } },
      { id: "b", approval: { message: "second?" } },
    ],
  },
  {
    name: "owned",
    description: "Use when: exercising a workflow another rib owns",
    nodes: [{ id: "work", bash: "echo done" }],
  },
  {
    name: "repo-only",
    description: "Use when: exercising the project requirement",
    requiresProject: true,
    nodes: [{ id: "work", bash: "echo done" }],
  },
];

describe("rib startWorkflow / getRunStatus / cancelRun", () => {
  let tmpDir: string;

  beforeEach(() => {
    if (!isRegisteredProvider("stub")) registerStubProvider();
    tmpDir = mkdtempSync(join(tmpdir(), "keelson-rib-start-"));
    mkdirSync(join(tmpDir, "workflows"), { recursive: true });
  });

  afterEach(() => {
    rmTemp(tmpDir);
  });

  async function makeRig(opts: { grants: string; engine?: PolicyEngine }) {
    const db = openDatabase({ path: join(tmpDir, "test.db") });
    const store = createWorkflowStore(db);
    const projectsStore = createProjectsStore(db);
    const catalog = bootstrapWorkflows({
      workflowDir: join(tmpDir, "workflows"),
      extra: WORKFLOWS,
      ribProvenance: new Map([["owned", { ribId: "bystander", background: false }]]),
    });
    const contexts = new Map<string, RibContext>();
    const events = new Map<string, RibRunEvent[]>();
    const rib = (id: string): Rib => ({
      id,
      displayName: id,
      registerTools: (ctx) => {
        contexts.set(id, ctx);
        return [];
      },
      onRunEvent: (event) => {
        events.set(id, [...(events.get(id) ?? []), event]);
      },
    });
    let controller: ReturnType<typeof createWorkflowController> | undefined;
    const ribs = await bootstrapRibs({
      available: { lead: rib("lead"), bystander: rib("bystander") },
      getWorkflowController: () => controller,
      refreshCwd: tmpDir,
      getProjects: () => projectsStore.list(),
      getPolicyEngine: () => opts.engine ?? policyEngine(),
      // Injected so a grant in the developer's real config.json can't turn the
      // default-deny assertion green.
      ribWorkflowGrants: parseRibWorkflowGrants(opts.grants),
      crossRibGrants: new Map(),
    });
    controller = createWorkflowController(
      {
        catalog,
        store,
        conversationStore: createConversationStore(db),
        projectsStore,
        onRibRunEvent: createRunEventDispatcher(ribs.runEventHandlers),
      },
      createActiveRuns(),
      createWorkflowSubscribers(),
    );
    const ctx = (
      id: string,
    ): Required<Pick<RibContext, "startWorkflow" | "getRunStatus" | "cancelRun">> => {
      const c = contexts.get(id);
      if (!c?.startWorkflow || !c.getRunStatus || !c.cancelRun) {
        throw new Error(`rib '${id}' is missing the run seams`);
      }
      return {
        startWorkflow: c.startWorkflow,
        getRunStatus: c.getRunStatus,
        cancelRun: c.cancelRun,
      };
    };
    return {
      db,
      store,
      projectsStore,
      controller,
      ctx,
      eventsFor: (id: string) => events.get(id) ?? [],
    };
  }

  test("an ungranted rib is denied before the policy engine is consulted", async () => {
    let policyCalls = 0;
    const { db, store, ctx } = await makeRig({
      grants: "lead:gated",
      engine: policyEngine(async () => {
        policyCalls += 1;
        return { outcome: "allow" };
      }),
    });
    try {
      await expect(ctx("bystander").startWorkflow("quick")).rejects.toThrow(/not granted/);
      await expect(ctx("lead").startWorkflow("quick")).rejects.toThrow(/not granted/);
      expect(policyCalls).toBe(0);
      expect(store.queryRuns({})).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("a granted rib is still subject to policy", async () => {
    const { db, store, ctx } = await makeRig({
      grants: "lead:quick",
      engine: policyEngine(async () => ({ outcome: "deny", reason: "no" })),
    });
    try {
      await expect(ctx("lead").startWorkflow("quick")).rejects.toThrow(/denied by policy/);
      expect(store.queryRuns({})).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("an unknown workflow or project rejects", async () => {
    const { db, ctx } = await makeRig({ grants: "lead:*" });
    try {
      await expect(ctx("lead").startWorkflow("nope")).rejects.toThrow(/unknown workflow 'nope'/);
      await expect(
        ctx("lead").startWorkflow("quick", {}, { projectId: "missing" }),
      ).rejects.toThrow(/unknown project 'missing'/);
      await expect(ctx("lead").startWorkflow("repo-only")).rejects.toThrow(/requires a project/);
    } finally {
      db.close();
    }
  });

  test("a granted start returns the run id at once and stamps the starting rib", async () => {
    const { db, projectsStore, ctx, eventsFor } = await makeRig({ grants: "lead:quick" });
    try {
      const project = projectsStore.create({ name: "repo", rootPath: tmpDir });
      const { runId } = await ctx("lead").startWorkflow(
        "quick",
        { issue: "904" },
        { projectId: project.id },
      );
      const first = await ctx("lead").getRunStatus(runId);
      expect(first).toMatchObject({
        runId,
        workflowName: "quick",
        projectId: project.id,
        startedByRibId: "lead",
      });

      await until(() => eventsFor("lead").some((e) => e.status === "succeeded"));
      expect(eventsFor("lead").map((e) => e.status)).toEqual(["running", "succeeded"]);
      expect(eventsFor("lead").every((e) => e.startedByRibId === "lead")).toBe(true);
      expect(eventsFor("lead")[0]?.inputs).toEqual({ issue: "904" });
      expect(eventsFor("bystander")).toHaveLength(0);

      const settled = await ctx("lead").getRunStatus(runId);
      expect(settled?.status).toBe("succeeded");
      expect(settled?.checkout).toMatchObject({ worktreeEstablished: false });
      expect(settled?.checkout.path).not.toBeNull();
      expect(settled?.nodes).toEqual([{ nodeId: "work", status: "succeeded", output: "done\n" }]);
    } finally {
      db.close();
    }
  });

  test("a run paused on approval reports the gate, and only the operator can answer it", async () => {
    const { db, controller, ctx, eventsFor } = await makeRig({ grants: "lead:gated" });
    try {
      const { runId } = await ctx("lead").startWorkflow("gated");
      await until(() => eventsFor("lead").some((e) => e.status === "paused"));
      expect(eventsFor("lead").at(-1)).toMatchObject({
        status: "paused",
        startedByRibId: "lead",
        pendingApproval: { nodeId: "review" },
      });
      expect(eventsFor("lead").at(-1)?.pendingApproval?.prompt).toContain("ship it?");

      const paused = await ctx("lead").getRunStatus(runId);
      expect(paused?.status).toBe("paused");
      expect(paused?.pendingApproval?.nodeId).toBe("review");
      expect(paused?.pendingApproval?.prompt).toContain("ship it?");

      const resolved = controller.resolveApproval(runId, { nodeId: "review", text: "approve" });
      expect(resolved.ok).toBe(true);
      await until(() => eventsFor("lead").some((e) => e.status === "succeeded"));
      expect(eventsFor("lead").map((e) => e.status)).toEqual([
        "running",
        "paused",
        "running",
        "succeeded",
      ]);
      expect((await ctx("lead").getRunStatus(runId))?.pendingApproval).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test("a run with parallel gates stays paused until the last one is answered", async () => {
    const { db, controller, ctx, eventsFor } = await makeRig({ grants: "lead:two-gates" });
    try {
      const { runId } = await ctx("lead").startWorkflow("two-gates");
      await until(() => eventsFor("lead").filter((e) => e.status === "paused").length === 2);

      expect(controller.resolveApproval(runId, { nodeId: "a", text: "approve" }).ok).toBe(true);
      await until(() => eventsFor("lead").length === 4);
      expect(eventsFor("lead").at(-1)).toMatchObject({
        status: "paused",
        pendingApproval: { nodeId: "b" },
      });
      expect((await ctx("lead").getRunStatus(runId))?.pendingApproval?.nodeId).toBe("b");

      expect(controller.resolveApproval(runId, { nodeId: "b", text: "approve" }).ok).toBe(true);
      await until(() => eventsFor("lead").some((e) => e.status === "succeeded"));
      expect(eventsFor("lead").map((e) => e.status)).toEqual([
        "running",
        "paused",
        "paused",
        "paused",
        "running",
        "succeeded",
      ]);
    } finally {
      db.close();
    }
  });

  test("the owning rib and the starting rib both follow a run", async () => {
    const { db, ctx, eventsFor } = await makeRig({ grants: "lead:owned" });
    try {
      const { runId } = await ctx("lead").startWorkflow("owned");
      await until(
        () =>
          eventsFor("lead").some((e) => e.status === "succeeded") &&
          eventsFor("bystander").some((e) => e.status === "succeeded"),
      );
      expect(eventsFor("bystander").map((e) => e.status)).toEqual(["running", "succeeded"]);
      expect(eventsFor("bystander").every((e) => e.startedByRibId === "lead")).toBe(true);

      expect((await ctx("bystander").getRunStatus(runId))?.startedByRibId).toBe("lead");
      expect((await ctx("bystander").cancelRun(runId)).ok).toBe(false);
    } finally {
      db.close();
    }
  });

  test("status and cancel are scoped to the rib that started the run", async () => {
    const { db, ctx, eventsFor } = await makeRig({ grants: "lead:gated" });
    try {
      const { runId } = await ctx("lead").startWorkflow("gated");
      await until(() => eventsFor("lead").some((e) => e.status === "paused"));

      expect(await ctx("bystander").getRunStatus(runId)).toBeUndefined();
      expect(await ctx("bystander").cancelRun(runId)).toEqual({
        ok: false,
        error: `rib 'bystander' did not start run '${runId}'`,
      });
      expect((await ctx("lead").getRunStatus(runId))?.status).toBe("paused");

      expect(await ctx("lead").cancelRun(runId)).toEqual({ ok: true });
      await until(() => eventsFor("lead").some((e) => e.status === "cancelled"));
      expect((await ctx("lead").getRunStatus(runId))?.status).toBe("cancelled");
      expect(await ctx("lead").cancelRun(runId)).toEqual({
        ok: false,
        error: `run '${runId}' is not live`,
      });
    } finally {
      db.close();
    }
  });

  test("a run the operator started is invisible to the seams", async () => {
    const { db, store, controller, ctx } = await makeRig({ grants: "lead:*" });
    try {
      const started = controller.startRun({ name: "gated", inputs: {}, workingDir: tmpDir });
      if (!started.ok) throw new Error(started.message);
      expect(await ctx("lead").getRunStatus(started.runId)).toBeUndefined();
      expect((await ctx("lead").cancelRun(started.runId)).ok).toBe(false);
      expect(controller.cancelRun(started.runId)).toBe(true);
      await until(() => store.getRun(started.runId)?.status === "cancelled");
    } finally {
      db.close();
    }
  });
});
