// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { SCHEMA_VERSION } from "@keelson/shared";
import { spawnEnv } from "./spawn-env.ts";

const BIN = resolve(import.meta.dir, "..", "bin", "keelson.ts");
const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

test("workflow status rejects schema skew before fetching strict run detail", async () => {
  let runRequests = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/api/health") {
        return Response.json({
          ok: true,
          name: "keelson",
          schema_version: `${SCHEMA_VERSION}-stale`,
        });
      }
      if (pathname.startsWith("/api/workflows/runs")) runRequests += 1;
      return new Response("not found", { status: 404 });
    },
  });
  try {
    const baseUrl = `http://${server.hostname}:${server.port}`;
    const proc = Bun.spawn(
      ["bun", BIN, "--json", "workflow", "status", "run-1", "--brief", "--base-url", baseUrl],
      {
        cwd: REPO_ROOT,
        stdout: "pipe",
        stderr: "pipe",
        env: spawnEnv(),
      },
    );
    const [stdout, , exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout.trim())).toMatchObject({ ok: false, code: "SCHEMA_SKEW" });
    expect(runRequests).toBe(0);
  } finally {
    server.stop(true);
  }
});

test("workflow status brief preserves run errors and isolation facts", async () => {
  const detail = {
    runId: "run-1",
    workflowName: "fix-issue",
    status: "failed",
    startedAt: "2026-09-21T10:00:00.000Z",
    completedAt: "2026-09-21T10:00:01.000Z",
    error: "worktree setup failed: injected failure",
    conversationId: "conversation-1",
    projectId: "project-1",
    workingDir: "/repo",
    worktreePath: null,
    isolationEnabled: true,
    worktreeEstablished: false,
    inputs: {},
    nodes: [],
  };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/api/health") {
        return Response.json({
          ok: true,
          name: "keelson",
          schema_version: SCHEMA_VERSION,
        });
      }
      if (pathname === "/api/workflows/runs/run-1") {
        return Response.json({ run: detail });
      }
      return new Response("not found", { status: 404 });
    },
  });
  try {
    const baseUrl = `http://${server.hostname}:${server.port}`;
    const proc = Bun.spawn(
      ["bun", BIN, "--json", "workflow", "status", "run-1", "--brief", "--base-url", baseUrl],
      {
        cwd: REPO_ROOT,
        stdout: "pipe",
        stderr: "pipe",
        env: spawnEnv(),
      },
    );
    const [stdout, , exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.trim()).data).toMatchObject({
      runId: "run-1",
      status: "failed",
      error: "worktree setup failed: injected failure",
      workingDir: "/repo",
      worktreePath: null,
      isolationEnabled: true,
      worktreeEstablished: false,
    });
  } finally {
    server.stop(true);
  }
});
