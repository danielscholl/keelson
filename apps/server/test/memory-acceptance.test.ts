// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import "./test-setup.ts";

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RECALL_REQUEST_SCHEMA_VERSION,
  recallRequestSchema,
  writebackRequestSchema,
} from "@keelson/shared";
import {
  bashHandler,
  type MemoryTools,
  type NodeStreamEvent,
  parseWorkflow,
  type RunStreamEvent,
  runWorkflow,
  type WorkflowDefinition,
} from "@keelson/workflows";
import { openDatabase } from "../src/db/init.ts";
import { createMemoryStore, type MemoryStore } from "../src/memory-store.ts";

const MEMORY_WORKFLOW_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  ".keelson",
  "workflows",
  "memory.yaml",
);

function loadMemoryWorkflow(): WorkflowDefinition {
  const yaml = readFileSync(MEMORY_WORKFLOW_PATH, "utf8");
  const result = parseWorkflow(yaml, MEMORY_WORKFLOW_PATH);
  if (result.error) throw new Error(`failed to load memory workflow: ${result.error.error}`);
  return result.workflow;
}

// Mirror the adapter in apps/server/src/workflows-handler.ts so the
// executor sees the same schema-validated boundary the production path
// enforces. Plain Promise.resolve keeps the binding straightforward.
function wrapMemoryTools(store: MemoryStore): MemoryTools {
  return {
    recall: (req) => Promise.resolve(store.recall(recallRequestSchema.parse(req))),
    writeback: (req) => Promise.resolve(store.writeback(writebackRequestSchema.parse(req))),
  };
}

async function executeOnce(opts: {
  workflow: WorkflowDefinition;
  runId: string;
  inputs: Record<string, string>;
  store: MemoryStore;
}): Promise<{ events: RunStreamEvent[] }> {
  const events: RunStreamEvent[] = [];
  await runWorkflow({
    workflow: opts.workflow,
    runId: opts.runId,
    inputs: opts.inputs,
    handlers: new Map([["bash", bashHandler]]),
    cwd: process.cwd(),
    memoryTools: wrapMemoryTools(opts.store),
    onEvent: (e) => events.push(e),
  });
  return { events };
}

function nodeEvents(events: RunStreamEvent[], type: NodeStreamEvent["type"]): NodeStreamEvent[] {
  return events
    .filter((e): e is Extract<RunStreamEvent, { type: "node_event" }> => e.type === "node_event")
    .map((e) => e.event)
    .filter((inner) => inner.type === type);
}

describe("v0.3 memory layer acceptance", () => {
  // Issue #10 scenario, verbatim:
  //   Run the workflow twice with the same inputs but different run IDs. The
  //   second run's recall returns the first run's findings. Memory written by
  //   run 1 is evidence by default and only graduates to instruction if an
  //   operator confirms it via the review queue.
  test("memory workflow: writeback → recall → operator confirm → instruction-promotion", async () => {
    const db = openDatabase({ path: ":memory:" });
    try {
      const store = createMemoryStore(db);
      const workflow = loadMemoryWorkflow();
      // ARGUMENTS contains both tokens the recall query searches for ("prior",
      // "observations"), so the FTS5 default tokenizer hits on the writeback's
      // resolved content "Observed: observation recorded: prior observations
      // notes". Without tokens that match the workflow-authored query, recall
      // would return zero items even though the row exists.
      const inputs = { ARGUMENTS: "prior observations notes" };

      const run1 = await executeOnce({ workflow, runId: "run-1", inputs, store });
      const written1 = nodeEvents(run1.events, "memory_written");
      expect(written1).toHaveLength(1);
      const memoryId = (written1[0] as { type: "memory_written"; memoryId: string }).memoryId;

      const recall1 = nodeEvents(run1.events, "memory_recalled");
      expect(recall1).toHaveLength(1);
      expect((recall1[0] as { type: "memory_recalled"; returned: number }).returned).toBe(0);

      const stored = store.getById(memoryId);
      expect(stored).toBeDefined();
      expect(stored!.provenance).toBe("generated");
      expect(stored!.reviewStatus).toBe("pending");
      expect(stored!.usePolicy.canUseAsInstruction).toBe(false);
      expect(stored!.usePolicy.canUseAsEvidence).toBe(true);

      const run2 = await executeOnce({ workflow, runId: "run-2", inputs, store });
      const recall2 = nodeEvents(run2.events, "memory_recalled");
      expect(recall2).toHaveLength(1);
      const returned2 = (recall2[0] as { type: "memory_recalled"; returned: number }).returned;
      expect(returned2).toBeGreaterThan(0);

      // Direct store.recall verifies the wire projection: run 1's memory is
      // visible but still gated as evidence-only.
      const beforeConfirm = store.recall({
        schemaVersion: RECALL_REQUEST_SCHEMA_VERSION,
        scope: { visibility: "project" },
        task: { runtime: "workflow", taskId: "memory:capture", flowId: "verify-pre" },
        query: "prior observations",
        limits: { maxItems: 5 },
      });
      const recalledItem = beforeConfirm.items.find((it) => it.memoryId === memoryId);
      expect(recalledItem).toBeDefined();
      expect(recalledItem!.usePolicy.canUseAsInstruction).toBe(false);
      expect(recalledItem!.provenance).toBe("generated");

      const applied = store.confirm({ memoryId, action: "confirm", actor: "operator" });
      expect(applied.applied).toBe(true);

      const promoted = store.getById(memoryId);
      expect(promoted!.provenance).toBe("user_confirmed");
      expect(promoted!.reviewStatus).toBe("confirmed");
      expect(promoted!.usePolicy.canUseAsInstruction).toBe(true);

      const afterConfirm = store.recall({
        schemaVersion: RECALL_REQUEST_SCHEMA_VERSION,
        scope: { visibility: "project" },
        task: { runtime: "workflow", taskId: "memory:capture", flowId: "verify-post" },
        query: "prior observations",
        limits: { maxItems: 5 },
      });
      const promotedItem = afterConfirm.items.find((it) => it.memoryId === memoryId);
      expect(promotedItem).toBeDefined();
      expect(promotedItem!.usePolicy.canUseAsInstruction).toBe(true);
      expect(promotedItem!.provenance).toBe("user_confirmed");
    } finally {
      db.close();
    }
  });
});
