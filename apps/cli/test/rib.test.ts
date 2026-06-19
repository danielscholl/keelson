// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  const [stdout, , exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
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

describe("keelson rib (home lifecycle)", () => {
  let home: string;
  let ribSrc: string;

  beforeAll(() => {
    home = join(mkdtempSync(join(tmpdir(), "keelson-rib-home-")), "keelson");
    // A minimal local rib package `bun add <path>` can install. Zero deps so
    // the install is self-contained and offline.
    ribSrc = mkdtempSync(join(tmpdir(), "keelson-rib-fake-"));
    writeFileSync(
      join(ribSrc, "package.json"),
      JSON.stringify({ name: "@keelson/rib-faketest", version: "0.0.0", main: "./index.ts" }),
    );
    writeFileSync(join(ribSrc, "index.ts"), "export default { id: 'faketest' };\n");
  });

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(ribSrc, { recursive: true, force: true });
  });

  test("add a local path installs the rib into the home", async () => {
    const { stdout, exitCode } = await runCli(["--json", "rib", "add", ribSrc], {
      KEELSON_HOME: home,
    });
    expect(exitCode).toBe(0);
    const env = JSON.parse(stdout.trim());
    expect(env.ok).toBe(true);
    expect(env.data.added).toContain("faketest");
    expect(env.data.installed).toContain("faketest");
  });

  test("list --installed reports it without a server", async () => {
    const { stdout, exitCode } = await runCli(["--json", "rib", "list", "--installed"], {
      KEELSON_HOME: home,
    });
    expect(exitCode).toBe(0);
    const env = JSON.parse(stdout.trim());
    expect(env.data.source).toBe("installed");
    expect(env.data.ribs.map((r: { id: string }) => r.id)).toContain("faketest");
  });

  test("remove uninstalls it", async () => {
    const { stdout, exitCode } = await runCli(["--json", "rib", "remove", "faketest"], {
      KEELSON_HOME: home,
    });
    expect(exitCode).toBe(0);
    const env = JSON.parse(stdout.trim());
    expect(env.data.removed).toBe("faketest");
    expect(env.data.installed).not.toContain("faketest");
  });

  test("remove an uninstalled rib exits 4 with NOT_FOUND", async () => {
    const { stdout, exitCode } = await runCli(["--json", "rib", "remove", "ghost"], {
      KEELSON_HOME: home,
    });
    expect(exitCode).toBe(4);
    const env = JSON.parse(stdout.trim());
    expect(env.ok).toBe(false);
    expect(env.code).toBe("NOT_FOUND");
  });
});

describe("keelson rib (restart hint)", () => {
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;
  let ribSrc: string;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        if (new URL(req.url).pathname === "/api/health") {
          return Response.json({ ok: true, name: "keelson", schema_version: "2.7" });
        }
        return Response.json({ error: "not found" }, { status: 404 });
      },
    });
    baseUrl = `http://${server.hostname}:${server.port}`;
    ribSrc = mkdtempSync(join(tmpdir(), "keelson-rib-fake-restart-"));
    writeFileSync(
      join(ribSrc, "package.json"),
      JSON.stringify({ name: "@keelson/rib-faketest", version: "0.0.0", main: "./index.ts" }),
    );
    writeFileSync(join(ribSrc, "index.ts"), "export default { id: 'faketest' };\n");
  });

  afterAll(() => {
    server.stop(true);
    rmSync(ribSrc, { recursive: true, force: true });
  });

  test("rib add --json reports restartRequired when server is live", async () => {
    const home = join(mkdtempSync(join(tmpdir(), "keelson-rib-home-restart-json-add-")), "keelson");
    try {
      const { stdout, exitCode } = await runCli(
        ["--json", "rib", "add", ribSrc, "--base-url", baseUrl],
        { KEELSON_HOME: home },
      );
      expect(exitCode).toBe(0);
      const env = JSON.parse(stdout.trim());
      expect(env.ok).toBe(true);
      expect(env.data.restartRequired).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("rib add in human mode prints the restart hint", async () => {
    const home = join(
      mkdtempSync(join(tmpdir(), "keelson-rib-home-restart-human-add-")),
      "keelson",
    );
    try {
      const { stdout, exitCode } = await runCli(["rib", "add", ribSrc, "--base-url", baseUrl], {
        KEELSON_HOME: home,
      });
      expect(exitCode).toBe(0);
      expect(stdout).toContain("restart the server");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("rib remove --json reports restartRequired when server is live", async () => {
    const home = join(
      mkdtempSync(join(tmpdir(), "keelson-rib-home-restart-json-remove-")),
      "keelson",
    );
    try {
      const add = await runCli(["--json", "rib", "add", ribSrc, "--base-url", baseUrl], {
        KEELSON_HOME: home,
      });
      expect(add.exitCode).toBe(0);
      const { stdout, exitCode } = await runCli(
        ["--json", "rib", "remove", "faketest", "--base-url", baseUrl],
        { KEELSON_HOME: home },
      );
      expect(exitCode).toBe(0);
      const env = JSON.parse(stdout.trim());
      expect(env.ok).toBe(true);
      expect(env.data.removed).toBe("faketest");
      expect(env.data.restartRequired).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("rib remove in human mode prints the restart hint", async () => {
    const home = join(
      mkdtempSync(join(tmpdir(), "keelson-rib-home-restart-human-remove-")),
      "keelson",
    );
    try {
      const add = await runCli(["--json", "rib", "add", ribSrc, "--base-url", baseUrl], {
        KEELSON_HOME: home,
      });
      expect(add.exitCode).toBe(0);
      const { stdout, exitCode } = await runCli(
        ["rib", "remove", "faketest", "--base-url", baseUrl],
        {
          KEELSON_HOME: home,
        },
      );
      expect(exitCode).toBe(0);
      expect(stdout).toContain("restart the server");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("keelson rib (dev home fallback)", () => {
  let root: string;
  let home: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "keelson-rib-dev-home-"));
    home = join(root, ".keelson");
    mkdirSync(join(root, "node_modules", "@keelson", "rib-faketest"), { recursive: true });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("list --installed finds ribs in parent workspace node_modules", async () => {
    const { stdout, exitCode } = await runCli(["--json", "rib", "list", "--installed"], {
      KEELSON_HOME: home,
    });
    expect(exitCode).toBe(0);
    const env = JSON.parse(stdout.trim());
    expect(env.data.source).toBe("installed");
    expect(env.data.ribs.map((r: { id: string }) => r.id)).toContain("faketest");
  });
});
