// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import "./test-setup.ts";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

import { bootstrapWorkflows } from "../src/bootstrap.ts";
import { createConversationStore } from "../src/conversation-store.ts";
import { openDatabase } from "../src/db/init.ts";
import { createProjectsStore } from "../src/projects-store.ts";
import { createWorkflowStore } from "../src/workflow-store.ts";
import { type ActiveRuns, createActiveRuns, workflowsRoutes } from "../src/workflows-handler.ts";
import { rmTemp } from "./temp.ts";

let tmpDir: string;
let artifactsDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keelson-canvas-artifact-"));
  artifactsDir = join(tmpDir, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  mkdirSync(join(tmpDir, "workflows"), { recursive: true });
});

afterEach(() => {
  rmTemp(tmpDir);
});

const RUN_ID = "run-1";

// Build the workflows routes with a custom ActiveRuns so the test controls the
// per-run artifacts dir directly (the route reads activeRuns.get(id)?.artifactsDir).
function makeRig(entry: "with-dir" | "no-dir" | "none"): { app: Hono; activeRuns: ActiveRuns } {
  const db = openDatabase({ path: join(tmpDir, "test.db") });
  const store = createWorkflowStore(db);
  const conversationStore = createConversationStore(db);
  const projectsStore = createProjectsStore(db);
  const catalog = bootstrapWorkflows({ workflowDir: join(tmpDir, "workflows") });

  const activeRuns = createActiveRuns();
  if (entry !== "none") {
    activeRuns.register(RUN_ID, {
      abort: new AbortController(),
      done: Promise.resolve(),
      pendingApprovals: new Map(),
      dedupeKey: "artifact-test",
      conversationId: "conv-test",
      ...(entry === "with-dir" ? { artifactsDir } : {}),
    });
  }

  const app = new Hono();
  workflowsRoutes(app, { catalog, store, conversationStore, projectsStore }, activeRuns);
  return { app, activeRuns };
}

function get(runId: string, path?: string): Request {
  const q = path === undefined ? "" : `?path=${encodeURIComponent(path)}`;
  // No Origin header — proves the read-only GET needs no CSRF/origin gate.
  return new Request(`http://test/api/workflows/runs/${runId}/artifact${q}`);
}

describe("GET /api/workflows/runs/:runId/artifact", () => {
  test("200 returns the file content for a live run", async () => {
    writeFileSync(join(artifactsDir, "plan.md"), "# Plan\n\n- step one\n");
    const { app } = makeRig("with-dir");
    const res = await app.fetch(get(RUN_ID, "plan.md"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: "plan.md", content: "# Plan\n\n- step one\n" });
  });

  test("200 resolves a nested path inside the dir", async () => {
    mkdirSync(join(artifactsDir, "sub"), { recursive: true });
    writeFileSync(join(artifactsDir, "sub", "notes.md"), "nested");
    const { app } = makeRig("with-dir");
    const res = await app.fetch(get(RUN_ID, "sub/notes.md"));
    expect(res.status).toBe(200);
    expect((await res.json()).content).toBe("nested");
  });

  test("400 when the path query is missing", async () => {
    const { app } = makeRig("with-dir");
    const res = await app.fetch(get(RUN_ID));
    expect(res.status).toBe(400);
  });

  test("410 for an unknown run (no live artifacts)", async () => {
    const { app } = makeRig("with-dir");
    const res = await app.fetch(get("nope", "plan.md"));
    expect(res.status).toBe(410);
  });

  test("410 when the run has no artifacts dir (terminal / never created)", async () => {
    const { app } = makeRig("no-dir");
    const res = await app.fetch(get(RUN_ID, "plan.md"));
    expect(res.status).toBe(410);
  });

  test("404 when the file does not exist in a live run", async () => {
    const { app } = makeRig("with-dir");
    const res = await app.fetch(get(RUN_ID, "missing.md"));
    expect(res.status).toBe(404);
  });

  test("400 rejects parent-traversal", async () => {
    writeFileSync(join(tmpDir, "secret.txt"), "TOP SECRET");
    const { app } = makeRig("with-dir");
    const res = await app.fetch(get(RUN_ID, "../secret.txt"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("invalid");
  });

  test("400 rejects an absolute path", async () => {
    const { app } = makeRig("with-dir");
    const res = await app.fetch(get(RUN_ID, "/etc/passwd"));
    expect(res.status).toBe(400);
  });

  test("400 rejects a symlink inside the dir that escapes the sandbox", async () => {
    writeFileSync(join(tmpDir, "outside.txt"), "ESCAPED");
    symlinkSync(join(tmpDir, "outside.txt"), join(artifactsDir, "link.md"));
    const { app } = makeRig("with-dir");
    const res = await app.fetch(get(RUN_ID, "link.md"));
    expect(res.status).toBe(400);
  });

  test("400 when the path is a directory, not a file", async () => {
    mkdirSync(join(artifactsDir, "adir"), { recursive: true });
    const { app } = makeRig("with-dir");
    const res = await app.fetch(get(RUN_ID, "adir"));
    expect(res.status).toBe(400);
  });

  test("400 when the file exceeds the size cap", async () => {
    writeFileSync(join(artifactsDir, "big.md"), "x".repeat(1_000_001));
    const { app } = makeRig("with-dir");
    const res = await app.fetch(get(RUN_ID, "big.md"));
    expect(res.status).toBe(400);
  });

  test("400 rejects a binary (non-UTF-8) artifact", async () => {
    writeFileSync(join(artifactsDir, "blob.bin"), Buffer.from([0x00, 0xff, 0xfe, 0x01]));
    const { app } = makeRig("with-dir");
    const res = await app.fetch(get(RUN_ID, "blob.bin"));
    expect(res.status).toBe(400);
  });
});
