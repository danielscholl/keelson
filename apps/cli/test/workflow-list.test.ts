// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { spawnEnv } from "./spawn-env.ts";

const BIN = resolve(import.meta.dir, "..", "bin", "keelson.ts");
const FIXTURES = resolve(import.meta.dir, "fixtures");

async function runCli(
  args: readonly string[],
  env?: Record<string, string>,
): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", BIN, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    ...(env ? { env: spawnEnv(env) } : {}),
  });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { stdout, exitCode };
}

describe("workflow list (in-process)", () => {
  test("falls back to local discovery when no server is reachable", async () => {
    const { stdout, exitCode } = await runCli(["--json", "workflow", "list"], {
      KEELSON_SERVER_URL: "http://127.0.0.1:1",
    });
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout.trim());
    expect(envelope.ok).toBe(true);
    expect(Array.isArray(envelope.data.workflows)).toBe(true);
    expect(envelope.data.workflows.length).toBeGreaterThan(0);
  });

  test("--dir reads an explicit workflows directory", async () => {
    const { stdout, exitCode } = await runCli(["--json", "workflow", "list", "--dir", FIXTURES]);
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout.trim());
    expect(envelope.ok).toBe(true);
    const names = envelope.data.workflows.map((w: { name: string }) => w.name);
    expect(names).toContain("smoke-bash");
  });
});

describe("workflow list (server-backed)", () => {
  const workflows = [
    {
      name: "smoke-test",
      description: "Server workflow",
      nodeCount: 3,
      source: { kind: "rib", ribId: "chamber", ribName: "Chamber" },
      background: false,
    },
    {
      name: "local-only",
      description: "Plain local workflow",
      nodeCount: 1,
      source: { kind: "local" },
      background: false,
    },
  ];

  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const { pathname } = new URL(req.url);
        if (pathname === "/api/health") {
          return Response.json({ ok: true, name: "keelson", schema_version: "2.7" });
        }
        if (pathname === "/api/workflows") {
          return Response.json({
            workflows,
            discoveryNotices: [
              {
                level: "warning",
                filename: "fixtures/workflows/smoke-test.yaml",
                message: "ignored capability",
              },
            ],
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    baseUrl = `http://${server.hostname}:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  test("uses the server catalog when it is available", async () => {
    const { stdout, exitCode } = await runCli(["--json", "workflow", "list"], {
      KEELSON_SERVER_URL: baseUrl,
    });
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout.trim());
    expect(envelope.ok).toBe(true);
    const listed = envelope.data.workflows as Array<{ name: string; source: string }>;
    expect(listed.map((w) => w.name)).toContain("smoke-test");
    expect(listed.map((w) => w.name)).toContain("local-only");
    expect(listed.find((w) => w.name === "smoke-test")?.source).toBe("rib");
    expect(listed.find((w) => w.name === "local-only")?.source).toBe("global");
    expect(envelope.data.notices).toHaveLength(1);
    expect(envelope.data.notices[0].message).toContain("ignored");
  });

  test("fails when the server catalog request returns an error", async () => {
    const failingServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const { pathname } = new URL(req.url);
        if (pathname === "/api/health") {
          return Response.json({ ok: true, name: "keelson", schema_version: "2.7" });
        }
        if (pathname === "/api/workflows") {
          return new Response("boom", { status: 500 });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const { stdout, exitCode } = await runCli(["--json", "workflow", "list"], {
        KEELSON_SERVER_URL: `http://${failingServer.hostname}:${failingServer.port}`,
      });
      expect(exitCode).toBe(1);
      const envelope = JSON.parse(stdout.trim());
      expect(envelope.ok).toBe(false);
      expect(envelope.code).toBe("WORKFLOW_LIST_FAILED");
    } finally {
      failingServer.stop(true);
    }
  });

  test("falls back to local discovery if the catalog disappears after the probe", async () => {
    let server: ReturnType<typeof Bun.serve>;
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const { pathname } = new URL(req.url);
        if (pathname === "/api/health") {
          const response = Response.json({ ok: true, name: "keelson", schema_version: "2.7" });
          server.stop(true);
          return response;
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const { stdout, exitCode } = await runCli(["--json", "workflow", "list"], {
        KEELSON_SERVER_URL: `http://${server.hostname}:${server.port}`,
      });
      expect(exitCode).toBe(0);
      const envelope = JSON.parse(stdout.trim());
      expect(envelope.ok).toBe(true);
      expect(envelope.data.workflows.length).toBeGreaterThan(0);
    } finally {
      server.stop(true);
    }
  });
});
