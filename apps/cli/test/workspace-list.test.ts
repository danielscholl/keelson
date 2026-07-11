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

type WorkspaceLease = {
  id: string;
  projectId: string | null;
  purpose: string;
  owner: string;
  branch: string;
  worktreePath: string;
  createdAt: string;
};

function startWorkspaceServer(config: { leases?: WorkspaceLease[] } = {}): {
  baseUrl: string;
  stop: () => void;
} {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/api/workspaces/leases") {
        return Response.json({ leases: config.leases ?? [] });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  return {
    baseUrl: `http://${server.hostname}:${server.port}`,
    stop: () => server.stop(true),
  };
}

function envelope(stdout: string): any {
  return JSON.parse(stdout.trim());
}

describe("keelson workspace", () => {
  test("workspace list --json returns workspace leases from the server", async () => {
    const leases: WorkspaceLease[] = [
      {
        id: "lease-1",
        projectId: "project-1",
        purpose: "smoke",
        owner: "tool",
        branch: "keelson/lease/smoke/abc123",
        worktreePath: "/tmp/repo/.worktrees/abc123",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    const fake = startWorkspaceServer({ leases });
    try {
      const { stdout, exitCode } = await runCli([
        "--json",
        "workspace",
        "list",
        "--base-url",
        fake.baseUrl,
      ]);
      expect(exitCode).toBe(0);
      const env = envelope(stdout);
      expect(env.ok).toBe(true);
      expect(env.data.leases).toEqual(leases);
    } finally {
      fake.stop();
    }
  });

  test("workspace list with no server exits 3 with NO_SERVER", async () => {
    const { stdout, exitCode } = await runCli([
      "--json",
      "workspace",
      "list",
      "--base-url",
      "http://127.0.0.1:1",
    ]);
    expect(exitCode).toBe(3);
    const env = envelope(stdout);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("NO_SERVER");
  });
});
