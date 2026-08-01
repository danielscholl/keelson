// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { defaultUserHome } from "../src/paths.ts";

const USER = join("C:", "Users", "dev");
const LOCAL_APP_DATA = join(USER, "AppData", "Local");
const never = () => false;
const always = () => true;

describe("defaultUserHome", () => {
  // join() is platform-dependent, so the expectation has to be built the same
  // way rather than hardcoding a "/" separator that fails on a Windows runner.
  test("posix uses ~/.keelson", () => {
    expect(defaultUserHome({ platform: "linux", userHome: "/home/dev", exists: never })).toBe(
      join("/home/dev", ".keelson"),
    );
    expect(defaultUserHome({ platform: "darwin", userHome: "/Users/dev", exists: never })).toBe(
      join("/Users/dev", ".keelson"),
    );
  });

  // A dotdir named .keelson under the posix home is the default there, so its
  // presence must not change the answer the way it does on Windows.
  test("posix ignores whether the directory already exists", () => {
    const args = { platform: "darwin" as const, userHome: "/Users/dev" };
    expect(defaultUserHome({ ...args, exists: always })).toBe(
      defaultUserHome({ ...args, exists: never }),
    );
  });

  test("a fresh Windows install lands in %LOCALAPPDATA%", () => {
    expect(
      defaultUserHome({
        platform: "win32",
        userHome: USER,
        localAppData: LOCAL_APP_DATA,
        exists: never,
      }),
    ).toBe(join(LOCAL_APP_DATA, "keelson"));
  });

  // Upgrading an install that predates the move must never strand its database.
  test("an existing %USERPROFILE%\\.keelson keeps winning on Windows", () => {
    expect(
      defaultUserHome({
        platform: "win32",
        userHome: USER,
        localAppData: LOCAL_APP_DATA,
        exists: (p) => p === join(USER, ".keelson"),
      }),
    ).toBe(join(USER, ".keelson"));
  });

  // An explicitly-absent localAppData must not fall through to the ambient
  // process env — which is set on a Windows runner and unset elsewhere, so
  // getting this wrong passes on posix and fails only in Windows CI.
  test("Windows without LOCALAPPDATA falls back to the profile", () => {
    const saved = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = join("C:", "ambient", "AppData", "Local");
    try {
      for (const localAppData of [undefined, "", "   "]) {
        expect(
          defaultUserHome({ platform: "win32", userHome: USER, localAppData, exists: never }),
        ).toBe(join(USER, ".keelson"));
      }
    } finally {
      if (saved === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = saved;
    }
  });

  test("an uninjected localAppData does read the process env", () => {
    const saved = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = join("C:", "ambient");
    try {
      expect(defaultUserHome({ platform: "win32", userHome: USER, exists: never })).toBe(
        join("C:", "ambient", "keelson"),
      );
    } finally {
      if (saved === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = saved;
    }
  });

  test("a whitespace-padded LOCALAPPDATA is trimmed", () => {
    expect(
      defaultUserHome({
        platform: "win32",
        userHome: USER,
        localAppData: `  ${LOCAL_APP_DATA}  `,
        exists: never,
      }),
    ).toBe(join(LOCAL_APP_DATA, "keelson"));
  });
});
