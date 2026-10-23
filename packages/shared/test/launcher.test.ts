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
import { hostLauncher, type SpawnSpec, shellJoin } from "../src/launcher.ts";

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
