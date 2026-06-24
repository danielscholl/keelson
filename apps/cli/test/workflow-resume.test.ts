// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterEach, describe, expect, test } from "bun:test";
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

interface ResumeServerConfig {
  exactRunIds?: string[];
  listRunIds?: string[];
  resumeStatus?: number;
  resumeBody?: unknown;
}

function startResumeServer(config: ResumeServerConfig): {
  baseUrl: string;
  stop: () => void;
  requests: { resumePosts: string[] };
} {
  const requests = { resumePosts: [] as string[] };
  const exactRunIds = new Set(config.exactRunIds ?? []);
  const listRunIds = config.listRunIds ?? [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const { pathname, searchParams } = new URL(req.url);
      if (req.method === "GET" && pathname === "/api/workflows/runs") {
        if (searchParams.get("limit") === "1000") {
          return Response.json({ runs: listRunIds.map((runId) => ({ runId })) });
        }
        return Response.json({ runs: [] });
      }
      const runDetail = pathname.match(/^\/api\/workflows\/runs\/([^/]+)$/);
      if (req.method === "GET" && runDetail) {
        const runId = decodeURIComponent(runDetail[1] ?? "");
        return exactRunIds.has(runId)
          ? Response.json({ run: { runId } })
          : Response.json({ error: "not found" }, { status: 404 });
      }
      const resumeRoute = pathname.match(/^\/api\/workflows\/runs\/([^/]+)\/resume-run$/);
      if (req.method === "POST" && resumeRoute) {
        const runId = decodeURIComponent(resumeRoute[1] ?? "");
        requests.resumePosts.push(runId);
        if (config.resumeStatus !== undefined) {
          return Response.json(config.resumeBody ?? { error: "resume failed" }, {
            status: config.resumeStatus,
          });
        }
        return Response.json({ resumed: true, runId });
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

const RUN_A1 = "aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa";
const RUN_A2 = "aaaaaaaa-2222-4aaa-8aaa-aaaaaaaaaaaa";
const RUN_B = "bbbbbbbb-3333-4bbb-8bbb-bbbbbbbbbbbb";

const servers: Array<{ stop: () => void }> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
});

describe("keelson workflow resume", () => {
  test("resumes an interrupted run and returns resumed: true", async () => {
    const fake = startResumeServer({
      exactRunIds: [RUN_B],
      listRunIds: [RUN_B],
    });
    servers.push(fake);
    const { stdout, exitCode } = await runCli([
      "--json",
      "workflow",
      "resume",
      RUN_B,
      "--base-url",
      fake.baseUrl,
    ]);
    expect(exitCode).toBe(0);
    expect(envelope(stdout)).toEqual({ ok: true, data: { resumed: true, runId: RUN_B } });
    expect(fake.requests.resumePosts).toEqual([RUN_B]);
  });

  test("maps ambiguous run refs to AMBIGUOUS_RUN_ID", async () => {
    const fake = startResumeServer({
      exactRunIds: [RUN_A1, RUN_A2, RUN_B],
      listRunIds: [RUN_A1, RUN_A2, RUN_B],
    });
    servers.push(fake);
    const { stdout, exitCode } = await runCli([
      "--json",
      "workflow",
      "resume",
      "aaaaaaaa",
      "--base-url",
      fake.baseUrl,
    ]);
    expect(exitCode).toBe(1);
    const env = envelope(stdout);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("AMBIGUOUS_RUN_ID");
    expect(fake.requests.resumePosts).toEqual([]);
  });

  test("maps resume 404 responses to NOT_FOUND", async () => {
    const fake = startResumeServer({
      exactRunIds: [RUN_B],
      listRunIds: [RUN_B],
      resumeStatus: 404,
      resumeBody: { error: "unknown run" },
    });
    servers.push(fake);
    const { stdout, exitCode } = await runCli([
      "--json",
      "workflow",
      "resume",
      RUN_B,
      "--base-url",
      fake.baseUrl,
    ]);
    expect(exitCode).toBe(4);
    const env = envelope(stdout);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("NOT_FOUND");
  });

  test("maps resume 409 responses to NOT_RESUMABLE", async () => {
    const fake = startResumeServer({
      exactRunIds: [RUN_B],
      listRunIds: [RUN_B],
      resumeStatus: 409,
      resumeBody: { error: "not resumable" },
    });
    servers.push(fake);
    const { stdout, exitCode } = await runCli([
      "--json",
      "workflow",
      "resume",
      RUN_B,
      "--base-url",
      fake.baseUrl,
    ]);
    expect(exitCode).toBe(1);
    const env = envelope(stdout);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("NOT_RESUMABLE");
  });

  test("maps an unreachable server to NO_SERVER", async () => {
    const { stdout, exitCode } = await runCli([
      "--json",
      "workflow",
      "resume",
      RUN_B,
      "--base-url",
      "http://127.0.0.1:1",
    ]);
    expect(exitCode).toBe(3);
    const env = envelope(stdout);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("NO_SERVER");
  });
});
