// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { delimiter } from "node:path";
import { bundledBinDir, forgeShimPath, installForgeOnPath } from "../src/seed.ts";

describe("forge seam wiring", () => {
  test("the shim ships in the bundled bin dir and is executable", () => {
    expect(existsSync(forgeShimPath())).toBe(true);
    expect(forgeShimPath().startsWith(bundledBinDir())).toBe(true);
    if (process.platform !== "win32") {
      // owner-executable bit set (0o100).
      expect(statSync(forgeShimPath()).mode & 0o100).not.toBe(0);
    }
  });

  test("installForgeOnPath prepends the bin dir and sets KEELSON_FORGE_BIN", () => {
    const env: Record<string, string | undefined> = { PATH: "/usr/bin" };
    installForgeOnPath(env);
    expect(env.PATH?.split(delimiter)[0]).toBe(bundledBinDir());
    expect(env.KEELSON_FORGE_BIN).toBe(forgeShimPath());
  });

  test("installForgeOnPath is idempotent (no duplicate PATH entries)", () => {
    const env: Record<string, string | undefined> = { PATH: "/usr/bin" };
    installForgeOnPath(env);
    installForgeOnPath(env);
    const count = env.PATH?.split(delimiter).filter((d) => d === bundledBinDir()).length;
    expect(count).toBe(1);
  });

  test("installForgeOnPath seeds PATH when the env has none", () => {
    const env: Record<string, string | undefined> = {};
    installForgeOnPath(env);
    expect(env.PATH).toBe(bundledBinDir());
  });

  test("installForgeOnPath targets a lowercase-Path key when that is the PATH-ish var", () => {
    const env: Record<string, string | undefined> = { Path: "C:\\Windows" };
    installForgeOnPath(env);
    expect(env.Path?.split(delimiter)[0]).toBe(bundledBinDir());
    expect(env.PATH).toBeUndefined();
  });
});
