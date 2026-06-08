// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const BIN = resolve(import.meta.dir, "..", "bin", "keelson.ts");

async function runCli(args: readonly string[]): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", BIN, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { stdout, exitCode };
}

// A stand-in for keelson serve that answers only GET /api/ribs, so the CLI's HTTP
// path (list, show, not-found) is exercised end to end without booting the server.
const RIBS = [
  {
    id: "demo",
    displayName: "Demo",
    registered: ["demo_status", "demo_emit"],
    views: [{ key: "rib:demo:panel", canvasKind: "view", title: "Panel" }],
    surfaces: [{ id: "demo", title: "Demo", layout: { rows: [] } }],
    hasOnAction: true,
    auth: { authenticated: false, statusMessage: "no token" },
  },
];

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === "/api/ribs") return Response.json({ ribs: RIBS });
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});
afterAll(() => {
  server.stop(true);
});

describe("keelson rib (HTTP)", () => {
  test("rib list --json returns the discovered ribs", async () => {
    const { stdout, exitCode } = await runCli(["--json", "rib", "list", "--base-url", baseUrl]);
    expect(exitCode).toBe(0);
    const env = JSON.parse(stdout.trim());
    expect(env.ok).toBe(true);
    expect(env.data.ribs).toHaveLength(1);
    expect(env.data.ribs[0]).toMatchObject({
      id: "demo",
      displayName: "Demo",
      tools: ["demo_status", "demo_emit"],
      surfaces: ["demo"],
      auth: "needs auth",
    });
  });

  test("rib show <id> --json returns the rib detail", async () => {
    const { stdout, exitCode } = await runCli([
      "--json",
      "rib",
      "show",
      "demo",
      "--base-url",
      baseUrl,
    ]);
    expect(exitCode).toBe(0);
    const env = JSON.parse(stdout.trim());
    expect(env.ok).toBe(true);
    expect(env.data.rib).toMatchObject({
      id: "demo",
      handlesActions: true,
      views: ["rib:demo:panel"],
    });
  });

  test("rib show on an unknown id exits 4 with NOT_FOUND", async () => {
    const { stdout, exitCode } = await runCli([
      "--json",
      "rib",
      "show",
      "ghost",
      "--base-url",
      baseUrl,
    ]);
    expect(exitCode).toBe(4);
    const env = JSON.parse(stdout.trim());
    expect(env.ok).toBe(false);
    expect(env.code).toBe("NOT_FOUND");
  });

  test("rib list without a server exits 3 with NO_SERVER", async () => {
    // An unused port → connection refused → the server-down path.
    const { stdout, exitCode } = await runCli([
      "--json",
      "rib",
      "list",
      "--base-url",
      "http://127.0.0.1:1",
    ]);
    expect(exitCode).toBe(3);
    const env = JSON.parse(stdout.trim());
    expect(env.ok).toBe(false);
    expect(env.code).toBe("NO_SERVER");
  });
});
