// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { describe, expect, test } from "bun:test";
import {
  buildSandboxProfile,
  describeSandboxProfile,
  describeSandboxStatus,
  EMPTY_SANDBOX_SETTINGS,
  mergeSandboxProfile,
  parseSandboxEnv,
  resolveClientSandbox,
  resolveSandboxEnabled,
  type SandboxProfile,
  sandboxProfileSchema,
  sandboxSupportSchema,
  sandboxUnsupportedWarning,
} from "../src/sandbox.ts";

const profile = (overrides: Partial<SandboxProfile> = {}): SandboxProfile => ({
  enabled: true,
  filesystem: { readwrite: ["/repo"], readonly: [], denied: [] },
  network: { outbound: "deny" },
  env: [],
  ...overrides,
});

describe("sandboxProfileSchema", () => {
  test("fills defaults: deny outbound, empty path lists, no env", () => {
    expect(sandboxProfileSchema.parse({ enabled: true })).toEqual({
      enabled: true,
      filesystem: { readwrite: [], readonly: [], denied: [] },
      network: { outbound: "deny" },
      env: [],
    });
  });

  test("rejects unknown keys at every level", () => {
    expect(sandboxProfileSchema.safeParse({ enabled: true, extra: 1 }).success).toBe(false);
    expect(
      sandboxProfileSchema.safeParse({ enabled: true, network: { outbound: "deny", wild: 1 } })
        .success,
    ).toBe(false);
    expect(
      sandboxProfileSchema.safeParse({ enabled: true, filesystem: { writable: [] } }).success,
    ).toBe(false);
    expect(sandboxProfileSchema.safeParse({ enabled: true, backend: { gemini: {} } }).success).toBe(
      false,
    );
    expect(
      sandboxProfileSchema.safeParse({ enabled: true, backend: { codex: { mode: "yolo" } } })
        .success,
    ).toBe(false);
  });

  test("env entries must be variable names, not assignments", () => {
    expect(sandboxProfileSchema.safeParse({ enabled: true, env: ["GH_TOKEN"] }).success).toBe(true);
    expect(sandboxProfileSchema.safeParse({ enabled: true, env: ["GH_TOKEN=x"] }).success).toBe(
      false,
    );
  });

  test("support levels are native, tool, none", () => {
    expect(sandboxSupportSchema.options).toEqual(["native", "tool", "none"]);
  });
});

describe("parseSandboxEnv", () => {
  test("recognizes required, on, off case-insensitively and treats blank as unset", () => {
    expect(parseSandboxEnv(undefined)).toEqual({ kind: "unset" });
    expect(parseSandboxEnv("  ")).toEqual({ kind: "unset" });
    expect(parseSandboxEnv(" Required ")).toEqual({ kind: "required" });
    expect(parseSandboxEnv("ON")).toEqual({ kind: "default", enabled: true });
    expect(parseSandboxEnv("off")).toEqual({ kind: "default", enabled: false });
  });

  test("anything else is invalid, including 1 and true", () => {
    expect(parseSandboxEnv("1")).toEqual({ kind: "invalid", value: "1" });
    expect(parseSandboxEnv("true")).toEqual({ kind: "invalid", value: "true" });
  });
});

describe("resolveSandboxEnabled", () => {
  test("the required floor beats an explicit frame and conversation off", () => {
    expect(
      resolveSandboxEnabled({
        frame: false,
        conversation: "off",
        configDefault: false,
        env: "required",
      }),
    ).toEqual({ enabled: true, source: "floor", locked: true });
  });

  test("a frame value beats the conversation", () => {
    expect(
      resolveSandboxEnabled({ frame: true, conversation: "off", configDefault: false }),
    ).toEqual({ enabled: true, source: "frame", locked: false });
    expect(
      resolveSandboxEnabled({ frame: false, conversation: "on", configDefault: true }),
    ).toEqual({ enabled: false, source: "frame", locked: false });
  });

  test("the conversation beats KEELSON_SANDBOX=on|off and the config default", () => {
    expect(resolveSandboxEnabled({ conversation: "off", configDefault: true, env: "on" })).toEqual({
      enabled: false,
      source: "conversation",
      locked: false,
    });
    expect(resolveSandboxEnabled({ conversation: "on", configDefault: false })).toEqual({
      enabled: true,
      source: "conversation",
      locked: false,
    });
  });

  test("KEELSON_SANDBOX=on|off replaces the config default", () => {
    expect(resolveSandboxEnabled({ configDefault: false, env: "on" })).toEqual({
      enabled: true,
      source: "env",
      locked: false,
    });
    expect(resolveSandboxEnabled({ configDefault: true, env: "off" })).toEqual({
      enabled: false,
      source: "env",
      locked: false,
    });
  });

  test("falls back to the config default; an invalid env value is ignored", () => {
    expect(resolveSandboxEnabled({ configDefault: false })).toEqual({
      enabled: false,
      source: "config",
      locked: false,
    });
    expect(resolveSandboxEnabled({ configDefault: true, env: "yes" })).toEqual({
      enabled: true,
      source: "config",
      locked: false,
    });
  });
});

describe("buildSandboxProfile", () => {
  test("adds the resolved cwd to readwrite exactly once, first", () => {
    const built = buildSandboxProfile(
      {
        ...EMPTY_SANDBOX_SETTINGS,
        filesystem: { readwrite: ["/real/repo", "/scratch"], readonly: ["/opt"], denied: [] },
      },
      "/link/repo",
      true,
      (p) => (p === "/link/repo" ? "/real/repo" : p),
    );
    expect(built.filesystem.readwrite).toEqual(["/real/repo", "/scratch"]);
    expect(built.filesystem.readonly).toEqual(["/opt"]);
    expect(built.enabled).toBe(true);
  });

  test("carries network, env, and backend, and copies rather than aliases", () => {
    const base = {
      filesystem: { readwrite: [], readonly: [], denied: ["/secret"] },
      network: { outbound: "allow" as const, loopback: true },
      env: ["GH_TOKEN", "GH_TOKEN"],
      backend: { codex: { mode: "read-only" as const } },
    };
    const built = buildSandboxProfile(base, "/repo", false);
    expect(built).toEqual({
      enabled: false,
      filesystem: { readwrite: ["/repo"], readonly: [], denied: ["/secret"] },
      network: { outbound: "allow", loopback: true },
      env: ["GH_TOKEN"],
      backend: { codex: { mode: "read-only" } },
    });
    built.filesystem.denied.push("/other");
    expect(base.filesystem.denied).toEqual(["/secret"]);
  });
});

describe("mergeSandboxProfile", () => {
  test("unions path and env lists and lets override scalars win", () => {
    const merged = mergeSandboxProfile(
      profile({ env: ["A"], filesystem: { readwrite: ["/repo"], readonly: ["/r"], denied: [] } }),
      {
        enabled: false,
        filesystem: { readwrite: ["/repo", "/tmp/x"], denied: ["/d"] },
        network: { outbound: "allow", loopback: true },
        env: ["B", "A"],
      },
    );
    expect(merged).toEqual({
      enabled: false,
      filesystem: { readwrite: ["/repo", "/tmp/x"], readonly: ["/r"], denied: ["/d"] },
      network: { outbound: "allow", loopback: true },
      env: ["A", "B"],
    });
  });

  test("an override that omits a field keeps the base value", () => {
    const base = profile({ network: { outbound: "allow", allowedHosts: ["github.com"] } });
    expect(mergeSandboxProfile(base, { network: { loopback: true } }).network).toEqual({
      outbound: "allow",
      allowedHosts: ["github.com"],
      loopback: true,
    });
    expect(mergeSandboxProfile(base, {})).toEqual(base);
  });

  test("backend keys merge per SDK with the override's leaves winning", () => {
    const merged = mergeSandboxProfile(
      profile({ backend: { claude: { a: 1, b: 1 }, codex: { mode: "workspace-write" } } }),
      { backend: { claude: { b: 2 }, copilot: { c: 3 } } },
    );
    expect(merged.backend).toEqual({
      claude: { a: 1, b: 2 },
      codex: { mode: "workspace-write" },
      copilot: { c: 3 },
    });
  });
});

describe("describeSandboxProfile", () => {
  test("off is terse", () => {
    expect(describeSandboxProfile(profile({ enabled: false }))).toBe("sandbox off");
  });

  test("on summarizes writes, network, and env on one line", () => {
    expect(describeSandboxProfile(profile())).toBe(
      "sandbox on · writes /repo · network outbound denied · no extra env",
    );
    const text = describeSandboxProfile(
      profile({
        filesystem: { readwrite: ["/repo", "/tmp/a"], readonly: ["/opt"], denied: ["/s", "/t"] },
        network: { outbound: "allow", loopback: true },
        env: ["GH_TOKEN"],
      }),
    );
    expect(text).toBe(
      "sandbox on · writes /repo +1 · 1 read-only · 2 denied · network outbound allowed + loopback · env GH_TOKEN",
    );
    expect(text).not.toContain("\n");
  });
});

describe("describeSandboxStatus", () => {
  const base = {
    providerId: "claude",
    support: "native" as const,
    platform: "darwin",
    profile: "writes <project> · network outbound denied",
  };

  test("names the source, the provider backend, the runtime, and the profile", () => {
    expect(
      describeSandboxStatus({
        ...base,
        resolution: { enabled: true, source: "conversation", locked: false },
        runtime: "seatbelt via /x",
      }),
    ).toEqual([
      "sandbox: on (saved on this conversation)",
      "provider: Claude Code sandbox (Seatbelt)",
      "runtime: seatbelt via /x",
      "profile: writes <project> · network outbound denied",
    ]);
  });

  test("a provider that cannot sandbox says turns fail closed only while it is on", () => {
    const pi = { ...base, providerId: "gateway-x", support: "none" as const };
    expect(
      describeSandboxStatus({
        ...pi,
        resolution: { enabled: true, source: "floor", locked: true },
      })[1],
    ).toBe(
      "provider: gateway-x cannot sandbox its tools; turns fail closed while the sandbox is on",
    );
    expect(
      describeSandboxStatus({
        ...pi,
        resolution: { enabled: false, source: "config", locked: false },
      })[1],
    ).toBe("provider: gateway-x cannot sandbox its tools");
  });

  test("the stub reads as n/a", () => {
    expect(
      describeSandboxStatus({
        ...base,
        providerId: "stub",
        support: "none",
        resolution: { enabled: false, source: "config", locked: false },
      }),
    ).toEqual([
      "sandbox: off (config default)",
      "provider: stub runs no tools (n/a)",
      "profile: writes <project> · network outbound denied",
    ]);
  });

  test("sandboxUnsupportedWarning fires only for a provider that cannot sandbox", () => {
    expect(sandboxUnsupportedWarning("claude", "native")).toBeUndefined();
    expect(sandboxUnsupportedWarning("stub", "none")).toContain(
      "switch to a provider that can sandbox",
    );
  });
});

describe("resolveClientSandbox", () => {
  const policy = { default: true, floor: false };

  test("with the policy known it resolves like the server", () => {
    expect(resolveClientSandbox({ policy })).toEqual({
      enabled: true,
      source: "config",
      locked: false,
    });
    expect(resolveClientSandbox({ policy, conversation: "off" })?.source).toBe("conversation");
    expect(resolveClientSandbox({ policy, conversation: "off", choice: true })?.enabled).toBe(true);
    expect(
      resolveClientSandbox({ policy: { default: false, floor: true }, choice: false }),
    ).toEqual({ enabled: true, source: "floor", locked: true });
  });

  test("with the policy unread it guesses nothing, but a choice or a saved row still counts", () => {
    expect(resolveClientSandbox({})).toBeUndefined();
    expect(resolveClientSandbox({ conversation: "on" })?.enabled).toBe(true);
    expect(resolveClientSandbox({ choice: false })).toEqual({
      enabled: false,
      source: "frame",
      locked: false,
    });
  });

  test("status says the server default applies when nothing resolves", () => {
    expect(
      describeSandboxStatus({
        providerId: "claude",
        support: "native",
        platform: "darwin",
        profile: "unavailable",
      })[0],
    ).toBe("sandbox: server default (its policy could not be read)");
  });
});
