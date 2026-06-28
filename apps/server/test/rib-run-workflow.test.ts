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

import { bootstrapWorkflows } from "../src/bootstrap.ts";
import { createConversationStore } from "../src/conversation-store.ts";
import { openDatabase } from "../src/db/init.ts";
import { createProjectsStore } from "../src/projects-store.ts";
import { createWorkflowStore } from "../src/workflow-store.ts";
import {
  createActiveRuns,
  createWorkflowController,
  createWorkflowSubscribers,
  type WorkflowController,
} from "../src/workflows-handler.ts";
import { rmTemp } from "./temp.ts";

// The RibContext.runWorkflow seam runs an in-memory definition on the shared executor.
// A bash-only workflow exercises the real path with no provider.

let tmpDir: string;

function makeController(): WorkflowController {
  const db = openDatabase({ path: join(tmpDir, "test.db") });
  const store = createWorkflowStore(db);
  const conversationStore = createConversationStore(db);
  const projectsStore = createProjectsStore(db);
  const wfDir = join(tmpDir, "workflows");
  mkdirSync(wfDir, { recursive: true });
  const catalog = bootstrapWorkflows({ workflowDir: wfDir });
  return createWorkflowController(
    { catalog, store, conversationStore, projectsStore },
    createActiveRuns(),
    createWorkflowSubscribers(),
  );
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keelson-rib-runwf-"));
});
afterEach(() => {
  rmTemp(tmpDir);
});

describe("WorkflowController.runDefinition (RibContext.runWorkflow)", () => {
  test("runs an in-memory bash workflow and returns the terminal result", async () => {
    const controller = makeController();
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
  });

  test("runs a two-node DAG honoring depends_on ordering", async () => {
    const controller = makeController();
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

  test("fails closed on a structurally-invalid definition (no run)", async () => {
    const controller = makeController();
    const res = await controller.runDefinition({ name: "x", nodes: [] }, {}, tmpDir);
    expect(res.status).toBe("failed");
    expect(res.error).toContain("invalid workflow");
  });

  test("fails closed on a non-object definition", async () => {
    const controller = makeController();
    const res = await controller.runDefinition("not a workflow", {}, tmpDir);
    expect(res.status).toBe("failed");
  });

  test("fails closed when cwd does not exist", async () => {
    const controller = makeController();
    const res = await controller.runDefinition(
      { name: "x", description: "d", nodes: [{ id: "a", bash: "echo hi" }] },
      {},
      join(tmpDir, "no", "such", "dir"),
    );
    expect(res.status).toBe("failed");
    expect(res.error).toContain("cwd");
  });

  test("surfaces a failed node as status failed with the node error", async () => {
    const controller = makeController();
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
});
