// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { spawnEnv } from "./spawn-env.ts";

const BIN = resolve(import.meta.dir, "..", "bin", "keelson.ts");

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

type ApprovalView = {
  id: string;
  surface: string;
  policyId: string;
  reason: string;
  tool?: string;
  createdAt: string;
};

interface ApprovalsServerConfig {
  approvals?: ApprovalView[];
  postStatus?: number;
  postBody?: unknown;
}

function startApprovalsServer(config: ApprovalsServerConfig = {}): {
  baseUrl: string;
  stop: () => void;
  requests: { posts: Array<{ id: string; body: Record<string, unknown> }> };
} {
  const requests = { posts: [] as Array<{ id: string; body: Record<string, unknown> }> };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/api/approvals") {
        return Response.json({ approvals: config.approvals ?? [] });
      }
      if (req.method === "POST" && url.pathname.startsWith("/api/approvals/")) {
        const id = decodeURIComponent(url.pathname.slice("/api/approvals/".length));
        const body = (await req.json()) as Record<string, unknown>;
        requests.posts.push({ id, body });
        if (config.postStatus !== undefined) {
          return Response.json(config.postBody ?? { error: "resolve failed" }, {
            status: config.postStatus,
          });
        }
        return Response.json({ ok: true });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  return {
    baseUrl: `http://${server.hostname}:${server.port}`,
    stop: () => server.stop(true),
    requests,
  };
}

function envelope(stdout: string): any {
  return JSON.parse(stdout.trim());
}

describe("keelson approval", () => {
  test("approval list --json returns pending approvals from the server", async () => {
    const approvals: ApprovalView[] = [
      {
        id: "abc-123",
        surface: "chat",
        policyId: "builtin:ask_on_shell",
        reason: "'Bash' runs shell or file-mutating actions",
        tool: "Bash",
        createdAt: "2026-06-20T00:00:00.000Z",
      },
    ];
    const fake = startApprovalsServer({ approvals });
    try {
      const { stdout, exitCode } = await runCli([
        "--json",
        "approval",
        "list",
        "--base-url",
        fake.baseUrl,
      ]);
      expect(exitCode).toBe(0);
      const env = envelope(stdout);
      expect(env.ok).toBe(true);
      expect(env.data.approvals).toEqual(approvals);
    } finally {
      fake.stop();
    }
  });

  test("approval list with no server exits 3 with NO_SERVER", async () => {
    const { stdout, exitCode } = await runCli([
      "--json",
      "approval",
      "list",
      "--base-url",
      "http://127.0.0.1:1",
    ]);
    expect(exitCode).toBe(3);
    const env = envelope(stdout);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("NO_SERVER");
  });

  test("approval resolve sends the decision and echoes id + decision", async () => {
    const fake = startApprovalsServer();
    try {
      const { stdout, exitCode } = await runCli([
        "--json",
        "approval",
        "resolve",
        "abc-123",
        "accept",
        "--base-url",
        fake.baseUrl,
      ]);
      expect(exitCode).toBe(0);
      const env = envelope(stdout);
      expect(env.ok).toBe(true);
      expect(env.data).toEqual({ id: "abc-123", decision: "accept" });
      expect(fake.requests.posts).toEqual([{ id: "abc-123", body: { decision: "accept" } }]);
    } finally {
      fake.stop();
    }
  });

  test("approval resolve rejects an invalid decision before any request", async () => {
    const { stdout, exitCode } = await runCli([
      "--json",
      "approval",
      "resolve",
      "abc-123",
      "maybe",
      "--base-url",
      "http://127.0.0.1:1",
    ]);
    expect(exitCode).toBe(2);
    expect(envelope(stdout).code).toBe("BAD_INPUTS");
  });

  test("approval resolve rejects a blank id", async () => {
    const { stdout, exitCode } = await runCli(["--json", "approval", "resolve", "  ", "accept"]);
    expect(exitCode).toBe(2);
    expect(envelope(stdout).code).toBe("BAD_INPUTS");
  });

  test("approval resolve maps an HTTP 404 to NOT_FOUND (exit 4)", async () => {
    const fake = startApprovalsServer({ postStatus: 404, postBody: { error: "unknown approval" } });
    try {
      const { stdout, exitCode } = await runCli([
        "--json",
        "approval",
        "resolve",
        "gone",
        "reject",
        "--base-url",
        fake.baseUrl,
      ]);
      expect(exitCode).toBe(4);
      expect(envelope(stdout).code).toBe("NOT_FOUND");
    } finally {
      fake.stop();
    }
  });
});
