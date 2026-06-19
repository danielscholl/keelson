// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import { isAbsolute, resolve } from "node:path";
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

type Project = { id: string; name: string; rootPath: string };

interface ProjectsServerConfig {
  projects?: Project[];
  createStatus?: number;
  createBody?: unknown;
  createProject?: Project;
  deleteStatus?: number;
  deleteBody?: unknown;
}

function startProjectsServer(config: ProjectsServerConfig = {}): {
  baseUrl: string;
  stop: () => void;
  requests: { creates: Array<{ name: string; rootPath: string }>; deletes: string[] };
} {
  const requests = {
    creates: [] as Array<{ name: string; rootPath: string }>,
    deletes: [] as string[],
  };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const methodPath = `${req.method} ${url.pathname}`;
      if (methodPath === "GET /api/projects") {
        return Response.json({ projects: config.projects ?? [] });
      }
      if (methodPath === "POST /api/projects") {
        const body = (await req.json()) as { name: string; rootPath: string };
        requests.creates.push(body);
        if (config.createStatus !== undefined) {
          return Response.json(config.createBody ?? { error: "create failed" }, {
            status: config.createStatus,
          });
        }
        return Response.json({ project: config.createProject ?? { id: "p1", ...body } });
      }
      if (req.method === "DELETE" && url.pathname.startsWith("/api/projects/")) {
        requests.deletes.push(decodeURIComponent(url.pathname.slice("/api/projects/".length)));
        if (config.deleteStatus !== undefined) {
          return Response.json(config.deleteBody ?? { error: "delete failed" }, {
            status: config.deleteStatus,
          });
        }
        return new Response(null, { status: 204 });
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

describe("keelson project", () => {
  test("project list --json returns projects from the server", async () => {
    const projects = [{ id: "p1", name: "work", rootPath: "/tmp/work" }];
    const fake = startProjectsServer({ projects });
    try {
      const { stdout, exitCode } = await runCli([
        "--json",
        "project",
        "list",
        "--base-url",
        fake.baseUrl,
      ]);
      expect(exitCode).toBe(0);
      const env = envelope(stdout);
      expect(env.ok).toBe(true);
      expect(env.data.projects).toEqual(projects);
    } finally {
      fake.stop();
    }
  });

  test("project list with no server exits 3 with NO_SERVER", async () => {
    const { stdout, exitCode } = await runCli([
      "--json",
      "project",
      "list",
      "--base-url",
      "http://127.0.0.1:1",
    ]);
    expect(exitCode).toBe(3);
    const env = envelope(stdout);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("NO_SERVER");
  });

  test("project add rejects blank name", async () => {
    const { stdout, exitCode } = await runCli(["--json", "project", "add", "  ", "/tmp/x"]);
    expect(exitCode).toBe(2);
    const env = envelope(stdout);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("BAD_INPUTS");
  });

  test("project add rejects blank path", async () => {
    const { stdout, exitCode } = await runCli(["--json", "project", "add", "work", "  "]);
    expect(exitCode).toBe(2);
    const env = envelope(stdout);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("BAD_INPUTS");
  });

  test("project add maps HTTP 409 to CONFLICT", async () => {
    const fake = startProjectsServer({
      createStatus: 409,
      createBody: { error: "project already exists" },
    });
    try {
      const { stdout, exitCode } = await runCli([
        "--json",
        "project",
        "add",
        "work",
        "/tmp/x",
        "--base-url",
        fake.baseUrl,
      ]);
      expect(exitCode).toBe(1);
      const env = envelope(stdout);
      expect(env.ok).toBe(false);
      expect(env.code).toBe("CONFLICT");
    } finally {
      fake.stop();
    }
  });

  test("project add succeeds and sends an absolute rootPath", async () => {
    const fake = startProjectsServer({
      createProject: { id: "p9", name: "work", rootPath: "/any/ignored/by/fixture" },
    });
    const relativePath = "./tmp/project-root";
    try {
      const { stdout, exitCode } = await runCli([
        "--json",
        "project",
        "add",
        "work",
        relativePath,
        "--base-url",
        fake.baseUrl,
      ]);
      expect(exitCode).toBe(0);
      const env = envelope(stdout);
      expect(env.ok).toBe(true);
      expect(env.data.project).toMatchObject({ id: "p9", name: "work" });
      expect(fake.requests.creates).toHaveLength(1);
      expect(isAbsolute(fake.requests.creates[0].rootPath)).toBe(true);
      expect(fake.requests.creates[0].rootPath).toBe(resolve(process.cwd(), relativePath));
    } finally {
      fake.stop();
    }
  });

  test("project remove rejects blank nameOrId", async () => {
    const { stdout, exitCode } = await runCli(["--json", "project", "remove", "  "]);
    expect(exitCode).toBe(2);
    const env = envelope(stdout);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("BAD_INPUTS");
  });

  test("project remove exits 4 when no list match exists", async () => {
    const fake = startProjectsServer({
      projects: [{ id: "p1", name: "other", rootPath: "/tmp/other" }],
    });
    try {
      const { stdout, exitCode } = await runCli([
        "--json",
        "project",
        "remove",
        "ghost",
        "--base-url",
        fake.baseUrl,
      ]);
      expect(exitCode).toBe(4);
      const env = envelope(stdout);
      expect(env.ok).toBe(false);
      expect(env.code).toBe("NOT_FOUND");
    } finally {
      fake.stop();
    }
  });

  test("project remove maps DELETE 404 to NOT_FOUND", async () => {
    const fake = startProjectsServer({
      projects: [{ id: "p2", name: "work", rootPath: "/tmp/work" }],
      deleteStatus: 404,
      deleteBody: { error: "missing project" },
    });
    try {
      const { stdout, exitCode } = await runCli([
        "--json",
        "project",
        "remove",
        "work",
        "--base-url",
        fake.baseUrl,
      ]);
      expect(exitCode).toBe(4);
      const env = envelope(stdout);
      expect(env.ok).toBe(false);
      expect(env.code).toBe("NOT_FOUND");
    } finally {
      fake.stop();
    }
  });

  test("project remove succeeds and returns the deleted project", async () => {
    const project = { id: "p2", name: "work", rootPath: "/tmp/work" };
    const fake = startProjectsServer({ projects: [project] });
    try {
      const { stdout, exitCode } = await runCli([
        "--json",
        "project",
        "remove",
        "work",
        "--base-url",
        fake.baseUrl,
      ]);
      expect(exitCode).toBe(0);
      const env = envelope(stdout);
      expect(env.ok).toBe(true);
      expect(env.data.deleted).toEqual(project);
      expect(fake.requests.deletes).toEqual(["p2"]);
    } finally {
      fake.stop();
    }
  });
});
