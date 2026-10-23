// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  buildMxcConfig,
  hostLauncher,
  mxcProfileWarnings,
  resolveMxcExecutor,
  rewriteMxcStderrLine,
  type SpawnSpec,
  shellJoin,
} from "../src/launcher.ts";
import type { SandboxProfile } from "../src/sandbox.ts";

const IS_WINDOWS = process.platform === "win32";

function bunSpec(script: string, overrides: Partial<SpawnSpec> = {}): SpawnSpec {
  return {
    cmd: process.execPath,
    args: ["-e", script],
    cwd: process.cwd(),
    env: { ...(process.env as Record<string, string>) },
    ...overrides,
  };
}

// Parses the joined string with a real `sh` and returns the argv it produced.
function shRoundTrip(argv: readonly string[]): string[] {
  const proc = Bun.spawnSync(["sh", "-c", `printf '%s\\0' ${shellJoin(argv)}`]);
  expect(proc.exitCode).toBe(0);
  const out = proc.stdout.toString();
  return out.slice(0, -1).split("\0");
}

describe("shellJoin", () => {
  test("single-quotes every token", () => {
    expect(shellJoin(["echo", "a b"])).toBe("'echo' 'a b'");
  });

  test("closes, escapes, and reopens an embedded single quote", () => {
    expect(shellJoin(["it's"])).toBe("'it'\\''s'");
  });

  test("renders an empty argument as an empty quoted token", () => {
    expect(shellJoin(["a", "", "b"])).toBe("'a' '' 'b'");
  });

  test("an empty argv joins to an empty string", () => {
    expect(shellJoin([])).toBe("");
  });

  test.skipIf(IS_WINDOWS)("round-trips hostile tokens through sh", () => {
    const argv = [
      "plain",
      "two words",
      "it's",
      "'",
      "''",
      '"double"',
      "$HOME",
      "$(touch /nonexistent)",
      "`id`",
      "back\\slash",
      "line\nbreak",
      "tab\there",
      "*",
      "glob?[a]",
      "semi;colon && pipe | amp &",
      "",
      "trailing space ",
    ];
    expect(shRoundTrip(argv)).toEqual(argv);
  });
});

describe("hostLauncher", () => {
  test("identifies as the host launcher", () => {
    expect(hostLauncher.id).toBe("host");
  });

  test("pipes stdout and stderr and resolves the exit code", async () => {
    const handle = hostLauncher.spawn(
      bunSpec("console.log('out-line'); console.error('err-line'); process.exit(7)"),
    );
    expect(handle.pid).toBeGreaterThan(0);
    const [stdout, stderr, code] = await Promise.all([
      new Response(handle.stdout).text(),
      new Response(handle.stderr).text(),
      handle.exited,
    ]);
    expect(stdout.trim()).toBe("out-line");
    expect(stderr.trim()).toBe("err-line");
    expect(code).toBe(7);
  });

  test("honors cwd and env from the spec", async () => {
    const dir = realpathSync(mkdtempSync(`${tmpdir()}/keelson-launcher-`));
    try {
      const handle = hostLauncher.spawn(
        bunSpec("console.log(process.cwd() + '|' + process.env.KEELSON_LAUNCHER_PROBE)", {
          cwd: dir,
          env: { ...(process.env as Record<string, string>), KEELSON_LAUNCHER_PROBE: "seen" },
        }),
      );
      const stdout = await new Response(handle.stdout).text();
      expect(await handle.exited).toBe(0);
      expect(realpathSync(stdout.trim().split("|")[0] ?? "")).toBe(dir);
      expect(stdout.trim().split("|")[1]).toBe("seen");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("kill terminates a long-running child", async () => {
    const handle = hostLauncher.spawn(bunSpec("setTimeout(() => {}, 30000)"));
    handle.kill();
    const code = await Promise.race([
      handle.exited,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5000)),
    ]);
    expect(code).not.toBe("timeout");
    expect(code).not.toBe(0);
  });

  test("throws synchronously when the executable is missing", () => {
    expect(() =>
      hostLauncher.spawn({
        cmd: "keelson-launcher-missing-binary",
        args: [],
        cwd: process.cwd(),
        env: { ...(process.env as Record<string, string>) },
      }),
    ).toThrow();
  });
});

describe("resolveMxcExecutor", () => {
  const darwin = {
    env: {},
    platform: "darwin" as const,
    arch: "arm64",
    release: "24.1.0",
    exists: () => true,
    resolvePackageJson: () => "/home/k/node_modules/@microsoft/mxc-sdk/package.json",
    readVersion: () => "1.0.1",
  };

  test("finds the arm64 executor inside the installed SDK", () => {
    expect(resolveMxcExecutor(darwin)).toEqual({
      ok: true,
      path: "/home/k/node_modules/@microsoft/mxc-sdk/bin/arm64/mxc-exec-mac",
      source: "package",
      version: "1.0.1",
    });
  });

  test("KEELSON_MXC_EXEC wins when it exists, and is reported when it does not", () => {
    expect(resolveMxcExecutor({ ...darwin, env: { KEELSON_MXC_EXEC: "/dev/mxc" } })).toEqual({
      ok: true,
      path: "/dev/mxc",
      source: "env",
    });
    const missing = resolveMxcExecutor({
      ...darwin,
      env: { KEELSON_MXC_EXEC: "/nope" },
      exists: () => false,
    });
    expect(missing.ok).toBe(false);
    expect(!missing.ok && missing.reason).toContain("/nope");
  });

  test("refuses Linux, Windows, macOS before 15, and Intel Macs with a reason", () => {
    for (const [overrides, reason] of [
      [{ platform: "linux" as const }, "macOS only"],
      [{ platform: "win32" as const }, "macOS only"],
      [{ release: "23.6.0" }, "macOS 15 or later"],
      [{ arch: "x64" }, "Apple silicon only"],
    ] as const) {
      const res = resolveMxcExecutor({ ...darwin, ...overrides });
      expect(res.ok).toBe(false);
      expect(!res.ok && res.reason).toContain(reason);
    }
  });

  test("an absent SDK or a missing binary points at keelson sandbox install", () => {
    const notInstalled = resolveMxcExecutor({
      ...darwin,
      resolvePackageJson: () => {
        throw new Error("not found");
      },
    });
    expect(notInstalled).toEqual({
      ok: false,
      reason: "@microsoft/mxc-sdk is not installed",
      installHint: "run `keelson sandbox install`",
    });
    const noBinary = resolveMxcExecutor({ ...darwin, exists: () => false });
    expect(!noBinary.ok && noBinary.installHint).toBe("run `keelson sandbox install`");
  });
});

describe("buildMxcConfig", () => {
  const profile: SandboxProfile = {
    enabled: true,
    filesystem: { readwrite: ["/nonexistent/repo"], readonly: ["/nonexistent/tools"], denied: [] },
    network: { outbound: "deny" },
    env: [],
  };
  const spec: SpawnSpec = {
    cmd: "bash",
    args: ["/nonexistent/body.sh", "it's"],
    cwd: "/nonexistent/repo",
    env: { KEELSON_RUN_ID: "r1", PATH: "/usr/bin" },
  };

  test("emits a 1.0.0 seatbelt request with no process timeout", () => {
    const config = buildMxcConfig(profile, spec);
    expect(config).toEqual({
      version: "1.0.0",
      containment: "seatbelt",
      process: {
        commandLine: "'bash' '/nonexistent/body.sh' 'it'\\''s'",
        cwd: "/nonexistent/repo",
        env: ["KEELSON_RUN_ID=r1", "PATH=/usr/bin"],
        inheritDefaultEnv: true,
      },
      filesystem: {
        readwritePaths: ["/nonexistent/repo"],
        readonlyPaths: ["/nonexistent/tools"],
        deniedPaths: [],
      },
      network: {
        egress: { default: "deny" },
        ingress: { default: "deny", hostLoopback: "deny" },
      },
    });
    expect((config.process as Record<string, unknown>).timeout).toBeUndefined();
  });

  test("loopback opens inbound too, and says so", () => {
    const loop = { ...profile, network: { outbound: "allow" as const, loopback: true } };
    expect(buildMxcConfig(loop, spec).network).toEqual({
      egress: { default: "allow" },
      ingress: { default: "allow", hostLoopback: "allow" },
    });
    expect(mxcProfileWarnings(loop)[0]).toContain("inbound");
    expect(mxcProfileWarnings(profile)).toEqual([]);
  });

  test.skipIf(IS_WINDOWS)("grants are canonical paths and `..` is refused", () => {
    const real = realpathSync(tmpdir());
    const config = buildMxcConfig(
      { ...profile, filesystem: { readwrite: [tmpdir(), real], readonly: [], denied: [] } },
      spec,
    );
    expect((config.filesystem as { readwritePaths: string[] }).readwritePaths).toEqual([real]);
    expect(() =>
      buildMxcConfig(
        { ...profile, filesystem: { readwrite: ["/a/../b"], readonly: [], denied: [] } },
        spec,
      ),
    ).toThrow("contains '..'");
  });
});

describe("rewriteMxcStderrLine", () => {
  test("labels the executor's own failures as launch failures and leaves script output alone", () => {
    expect(rewriteMxcStderrLine("Request error")).toBe(
      "sandbox launch failed: the executor rejected its config",
    );
    expect(rewriteMxcStderrLine('{"error":{"code":"backend_error","message":"cwd missing"}}')).toBe(
      "sandbox launch failed: cwd missing",
    );
    expect(rewriteMxcStderrLine("ls: Operation not permitted")).toBe("ls: Operation not permitted");
    expect(rewriteMxcStderrLine('{"error": not json')).toBe('{"error": not json');
  });
});
