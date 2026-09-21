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
import {
  isRegisteredProvider,
  registerProvider,
  registerStubProvider,
  unregisterProvider,
} from "@keelson/providers";
import type { ReasoningEffortLevel } from "@keelson/shared";
import type { NodeHandler } from "@keelson/workflows";

import { bootstrapWorkflows } from "../src/bootstrap.ts";
import { createConversationStore } from "../src/conversation-store.ts";
import { openDatabase } from "../src/db/init.ts";
import { createProjectsStore } from "../src/projects-store.ts";
import { createUsageStore, type UsageStore } from "../src/usage-store.ts";
import { createWorkflowStore } from "../src/workflow-store.ts";
import {
  type ActiveRuns,
  createActiveRuns,
  createWorkflowController,
  createWorkflowSubscribers,
  type WorkflowController,
} from "../src/workflows-handler.ts";
import { rmTemp } from "./temp.ts";

// The RibContext.runWorkflow seam runs an in-memory definition on the shared executor.
// A bash-only workflow exercises the real path with no provider.

let tmpDir: string;

function makeController(opts?: { promptHandler?: NodeHandler; usageStore?: UsageStore }): {
  controller: WorkflowController;
  activeRuns: ActiveRuns;
  usageStore?: UsageStore;
  projectId: string;
} {
  const db = openDatabase({ path: join(tmpDir, "test.db") });
  const store = createWorkflowStore(db);
  const conversationStore = createConversationStore(db);
  const projectsStore = createProjectsStore(db);
  const project = projectsStore.create({ name: "test-project", rootPath: tmpDir });
  const wfDir = join(tmpDir, "workflows");
  mkdirSync(wfDir, { recursive: true });
  const catalog = bootstrapWorkflows({ workflowDir: wfDir });
  const activeRuns = createActiveRuns();
  const usageStore = opts?.usageStore ?? createUsageStore(db);
  const controller = createWorkflowController(
    {
      catalog,
      store,
      conversationStore,
      projectsStore,
      usageStore,
      ...(opts?.promptHandler !== undefined ? { promptHandler: opts.promptHandler } : {}),
    },
    activeRuns,
    createWorkflowSubscribers(),
  );
  return { controller, activeRuns, usageStore, projectId: project.id };
}

beforeEach(() => {
  if (!isRegisteredProvider("stub")) registerStubProvider();
  tmpDir = mkdtempSync(join(tmpdir(), "keelson-rib-runwf-"));
});
afterEach(() => {
  rmTemp(tmpDir);
});

describe("WorkflowController.runDefinition (RibContext.runWorkflow)", () => {
  const successfulPromptHandler: NodeHandler = {
    type: "prompt",
    async handle() {
      return {
        status: "succeeded",
        output: { kind: "text", text: "ok" },
        provider: "stub",
        model: "stub-echo",
      };
    },
  };

  function registerCatalogProvider(
    id: string,
    model: string,
    opts: {
      efforts?: readonly ReasoningEffortLevel[];
      unavailable?: boolean;
      onCatalogCall?: () => void;
    } = {},
  ): void {
    const capabilities = {
      sessionResume: false,
      streaming: false,
      tools: false,
      reasoningEffort: opts.efforts !== undefined,
      models: [model],
      defaultModel: model,
    };
    registerProvider({
      id,
      displayName: id,
      capabilities,
      builtIn: false,
      factory: () => ({
        getType: () => id,
        getCapabilities: () => capabilities,
        async *sendQuery() {
          yield { type: "done" as const };
        },
        async listModels() {
          return [{ id: model }];
        },
        async listModelsLive() {
          opts.onCatalogCall?.();
          if (opts.unavailable === true) throw new Error("offline");
          return [
            {
              id: model,
              ...(opts.efforts !== undefined
                ? { supportedReasoningEfforts: [...opts.efforts] }
                : {}),
            },
          ];
        },
      }),
    });
  }

  test("runs an in-memory bash workflow and returns the terminal result", async () => {
    const { controller, activeRuns } = makeController();
    const res = await controller.runDefinition(
      {
        name: "verify-demo",
        description: "echo a marker",
        nodes: [{ id: "step", bash: "echo squad-ran-it" }],
      },
      {},
      tmpDir,
    );
    expect(res.status).toBe("succeeded");
    expect(res.nodes.step?.state).toBe("completed");
    expect(res.nodes.step?.output).toContain("squad-ran-it");
    // The run registers for shutdown-drain while live and deregisters on return.
    expect(activeRuns.size()).toBe(0);
  });

  test("runs a two-node DAG honoring depends_on ordering", async () => {
    const { controller } = makeController();
    // `second` reads a file `first` writes — if the edge were dropped and the
    // nodes ran as independent roots, `cat` would race the write and fail.
    const marker = join(tmpDir, "ordered.txt");
    const res = await controller.runDefinition(
      {
        name: "verify-chain",
        description: "two steps",
        nodes: [
          { id: "first", bash: `printf one > ${marker}` },
          { id: "second", bash: `cat ${marker}`, depends_on: ["first"] },
        ],
      },
      {},
      tmpDir,
    );
    expect(res.status).toBe("succeeded");
    expect(res.nodes.first?.state).toBe("completed");
    expect(res.nodes.second?.state).toBe("completed");
    expect(res.nodes.second?.output).toContain("one");
  });

  test("records usage for a rib-driven prompt workflow", async () => {
    const promptHandler: NodeHandler = {
      type: "prompt",
      handle: async () => ({
        status: "succeeded",
        output: { kind: "text", text: "prompt ok" },
        usage: { inputTokens: 7, outputTokens: 3 },
        provider: "stub",
        model: "stub-model",
      }),
    };
    const { controller, usageStore, projectId } = makeController({ promptHandler });
    const res = await controller.runDefinition(
      {
        name: "usage-demo",
        description: "prompt usage",
        nodes: [{ id: "ask", prompt: "hello" }],
      },
      {},
      tmpDir,
      "rib-usage",
    );
    expect(res.status).toBe("succeeded");

    const events = usageStore?.listEvents();
    expect(events).toHaveLength(1);
    expect(events?.[0]).toMatchObject({
      source: "workflow",
      provider: "stub",
      model: "stub-model",
      inputTokens: 7,
      outputTokens: 3,
      status: "ok",
      nodeId: "ask",
      workflowName: "usage-demo",
      conversationId: null,
      projectId,
      ribId: "rib-usage",
    });
    expect(events?.[0]?.runId).toEqual(expect.any(String));
    expect(events?.[0]?.durationMs).toEqual(expect.any(Number));
  });

  test("returns a failed result for retired prompt, command, and loop model pins", async () => {
    const { controller, activeRuns } = makeController({ promptHandler: successfulPromptHandler });
    const result = await controller.runDefinition(
      {
        name: "provider-bound-preflight",
        description: "reject retired provider-bound pins",
        provider: "stub",
        model: "retired-model",
        nodes: [
          { id: "prompt", prompt: "run" },
          { id: "command", command: "review" },
          {
            id: "loop",
            loop: { prompt: "run", until: "DONE", max_iterations: 1 },
          },
        ],
      },
      {},
      tmpDir,
    );

    expect(result.status).toBe("failed");
    expect(result.nodes).toEqual({});
    expect(result.error).toContain("- prompt: model 'retired-model' is not in stub's live catalog");
    expect(result.error).toContain(
      "- command: model 'retired-model' is not in stub's live catalog",
    );
    expect(result.error).toContain("- loop: model 'retired-model' is not in stub's live catalog");
    expect(activeRuns.size()).toBe(0);
  });

  test("returns a failed result for an unsupported effort pin", async () => {
    registerCatalogProvider("effort-catalog", "effort-model", { efforts: ["low", "high"] });
    try {
      const { controller } = makeController({ promptHandler: successfulPromptHandler });
      const result = await controller.runDefinition(
        {
          name: "effort-preflight",
          description: "reject an unsupported effort",
          provider: "effort-catalog",
          nodes: [{ id: "prompt", model: "effort-model", effort: "xhigh", prompt: "run" }],
        },
        {},
        tmpDir,
      );

      expect(result).toMatchObject({
        status: "failed",
        nodes: {},
        error:
          "preflight failed:\n- prompt: effort 'xhigh' exceeds effort-catalog/effort-model (supports low, high)",
      });
    } finally {
      unregisterProvider("effort-catalog");
    }
  });

  test("preflights with the effective default provider and model", async () => {
    registerCatalogProvider("rib-default", "rib-model");
    const prior = process.env.KEELSON_WORKFLOW_PROVIDER;
    process.env.KEELSON_WORKFLOW_PROVIDER = "rib-default";
    try {
      const { controller } = makeController({ promptHandler: successfulPromptHandler });
      const result = await controller.runDefinition(
        {
          name: "default-preflight",
          description: "use the effective default",
          nodes: [{ id: "prompt", model: "rib-model", prompt: "run" }],
        },
        {},
        tmpDir,
      );

      expect(result.status).toBe("succeeded");
    } finally {
      if (prior === undefined) delete process.env.KEELSON_WORKFLOW_PROVIDER;
      else process.env.KEELSON_WORKFLOW_PROVIDER = prior;
      unregisterProvider("rib-default");
    }
  });

  test("continues when the effective provider catalog is unavailable", async () => {
    registerCatalogProvider("rib-offline", "rib-model", { unavailable: true });
    try {
      const { controller } = makeController({ promptHandler: successfulPromptHandler });
      const result = await controller.runDefinition(
        {
          name: "offline-preflight",
          description: "continue without an authoritative catalog",
          provider: "rib-offline",
          nodes: [{ id: "prompt", model: "rib-model", prompt: "run" }],
        },
        {},
        tmpDir,
      );

      expect(result.status).toBe("succeeded");
    } finally {
      unregisterProvider("rib-offline");
    }
  });

  test("performs no catalog I/O for a deterministic in-memory workflow", async () => {
    let catalogCalls = 0;
    registerCatalogProvider("rib-unused", "rib-model", {
      onCatalogCall: () => {
        catalogCalls += 1;
      },
    });
    try {
      const { controller } = makeController();
      const result = await controller.runDefinition(
        {
          name: "deterministic-preflight",
          description: "no provider-bound nodes",
          provider: "rib-unused",
          nodes: [{ id: "shell", bash: "echo deterministic" }],
        },
        {},
        tmpDir,
      );

      expect(result.status).toBe("succeeded");
      expect(catalogCalls).toBe(0);
    } finally {
      unregisterProvider("rib-unused");
    }
  });

  test("the environment can disable in-memory preflight", async () => {
    const prior = process.env.KEELSON_WORKFLOW_PREFLIGHT;
    process.env.KEELSON_WORKFLOW_PREFLIGHT = "off";
    try {
      const { controller } = makeController({ promptHandler: successfulPromptHandler });
      const result = await controller.runDefinition(
        {
          name: "disabled-preflight",
          description: "operator-disabled preflight",
          provider: "stub",
          nodes: [{ id: "prompt", model: "retired-model", prompt: "run" }],
        },
        {},
        tmpDir,
      );

      expect(result.status).toBe("succeeded");
    } finally {
      if (prior === undefined) delete process.env.KEELSON_WORKFLOW_PREFLIGHT;
      else process.env.KEELSON_WORKFLOW_PREFLIGHT = prior;
    }
  });

  test("config can disable in-memory preflight", async () => {
    const priorConfig = process.env.KEELSON_CONFIG;
    const priorEnv = process.env.KEELSON_WORKFLOW_PREFLIGHT;
    const configPath = join(tmpDir, "config.json");
    writeFileSync(configPath, JSON.stringify({ workflowPreflight: false }));
    process.env.KEELSON_CONFIG = configPath;
    delete process.env.KEELSON_WORKFLOW_PREFLIGHT;
    try {
      const { controller } = makeController({ promptHandler: successfulPromptHandler });
      const result = await controller.runDefinition(
        {
          name: "config-disabled-preflight",
          description: "config-disabled preflight",
          provider: "stub",
          nodes: [{ id: "prompt", model: "retired-model", prompt: "run" }],
        },
        {},
        tmpDir,
      );

      expect(result.status).toBe("succeeded");
    } finally {
      if (priorConfig === undefined) delete process.env.KEELSON_CONFIG;
      else process.env.KEELSON_CONFIG = priorConfig;
      if (priorEnv === undefined) delete process.env.KEELSON_WORKFLOW_PREFLIGHT;
      else process.env.KEELSON_WORKFLOW_PREFLIGHT = priorEnv;
    }
  });

  test("fails closed on a structurally-invalid definition (no run)", async () => {
    const { controller } = makeController();
    const res = await controller.runDefinition({ name: "x", nodes: [] }, {}, tmpDir);
    expect(res.status).toBe("failed");
    expect(res.error).toContain("invalid workflow");
  });

  test("fails closed on a non-object definition", async () => {
    const { controller } = makeController();
    const res = await controller.runDefinition("not a workflow", {}, tmpDir);
    expect(res.status).toBe("failed");
  });

  test("fails closed when cwd does not exist", async () => {
    const { controller } = makeController();
    const res = await controller.runDefinition(
      { name: "x", description: "d", nodes: [{ id: "a", bash: "echo hi" }] },
      {},
      join(tmpDir, "no", "such", "dir"),
    );
    expect(res.status).toBe("failed");
    expect(res.error).toContain("cwd");
  });

  test("surfaces a failed node as status failed with the node error", async () => {
    const { controller } = makeController();
    const res = await controller.runDefinition(
      {
        name: "verify-fail",
        description: "a failing step",
        nodes: [{ id: "boom", bash: "exit 3" }],
      },
      {},
      tmpDir,
    );
    expect(res.status).toBe("failed");
    expect(res.nodes.boom?.state).toBe("failed");
    expect(typeof res.nodes.boom?.error).toBe("string");
    expect(typeof res.error).toBe("string");
  });

  test("a cancel node aborts the run, yields cancelled status, and leaves no active run", async () => {
    const { controller, activeRuns } = makeController();
    const res = await controller.runDefinition(
      {
        name: "verify-cancel",
        description: "cancels itself",
        nodes: [{ id: "stop", cancel: "halt" }],
      },
      {},
      tmpDir,
    );
    expect(res.status).toBe("cancelled");
    expect(activeRuns.size()).toBe(0);
  });
});
