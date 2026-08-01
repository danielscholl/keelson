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
  test("posix uses ~/.keelson", () => {
    expect(defaultUserHome({ platform: "linux", userHome: "/home/dev", exists: never })).toBe(
      "/home/dev/.keelson",
    );
    expect(defaultUserHome({ platform: "darwin", userHome: "/Users/dev", exists: never })).toBe(
      "/Users/dev/.keelson",
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

  test("Windows without LOCALAPPDATA falls back to the profile", () => {
    for (const localAppData of [undefined, "", "   "]) {
      expect(
        defaultUserHome({ platform: "win32", userHome: USER, localAppData, exists: never }),
      ).toBe(join(USER, ".keelson"));
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
