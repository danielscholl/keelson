// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { describe, expect, test } from "bun:test";
import type { SandboxProfile } from "@keelson/shared";
import {
  applyCopilotSandbox,
  codexSandboxGaps,
  describeSandboxBackend,
  StubProvider,
  sandboxSupportFor,
  toClaudeSandboxSettings,
  toCodexSandbox,
  toCopilotSandboxConfig,
} from "../src/index.ts";

const profile = (overrides: Partial<SandboxProfile> = {}): SandboxProfile => ({
  enabled: true,
  filesystem: { readwrite: ["/repo"], readonly: ["/opt/tools"], denied: ["/home/op/.ssh"] },
  network: { outbound: "deny" },
  env: ["GH_TOKEN"],
  ...overrides,
});

describe("toCopilotSandboxConfig", () => {
  test("maps paths and network onto the SDK's userPolicy, with bypass off", () => {
    expect(toCopilotSandboxConfig(profile())).toEqual({
      enabled: true,
      addCurrentWorkingDirectory: true,
      allowBypass: false,
      sandboxMcpServers: true,
      userPolicy: {
        filesystem: {
          readwritePaths: ["/repo"],
          readonlyPaths: ["/opt/tools"],
          deniedPaths: ["/home/op/.ssh"],
        },
        network: { allowOutbound: false, allowLocalNetwork: false },
      },
    });
  });

  test("outbound allow, loopback, and hosts carry through; backend.copilot spreads last", () => {
    const config = toCopilotSandboxConfig(
      profile({
        network: { outbound: "allow", loopback: true, allowedHosts: ["github.com"] },
        backend: { copilot: { allowDevToolAccess: false, sandboxMcpServers: false } },
      }),
    );
    expect(config.userPolicy).toMatchObject({
      network: { allowOutbound: true, allowLocalNetwork: true, allowedHosts: ["github.com"] },
    });
    expect(config.allowDevToolAccess).toBe(false);
    expect(config.sandboxMcpServers).toBe(false);
  });
});

describe("applyCopilotSandbox", () => {
  const supported = { rpc: { sandbox: { getHostSupport: async () => ({ supported: true }) } } };

  test("returns undefined once the session accepts the policy", async () => {
    const updates: Record<string, unknown>[] = [];
    const session = {
      rpc: {
        options: {
          update: async (p: Record<string, unknown>) => {
            updates.push(p);
            return { success: true };
          },
        },
      },
    };
    expect(await applyCopilotSandbox(supported, session, profile())).toBeUndefined();
    expect(updates[0]?.sandboxConfigSource).toBe("session_flag");
  });

  test("names the reason when the SDK lacks the RPCs or the host or session refuses", async () => {
    const accept = { rpc: { options: { update: async () => ({ success: true }) } } };
    expect(await applyCopilotSandbox({}, accept, profile())).toBe(
      "this Copilot SDK cannot report sandbox support",
    );
    expect(
      await applyCopilotSandbox(
        { rpc: { sandbox: { getHostSupport: async () => ({ supported: false }) } } },
        accept,
        profile(),
      ),
    ).toBe("Copilot cannot sandbox on this host");
    expect(await applyCopilotSandbox(supported, {}, profile())).toBe(
      "this Copilot SDK cannot apply a sandbox to a session",
    );
    expect(
      await applyCopilotSandbox(
        supported,
        {
          rpc: {
            options: {
              update: async () => {
                throw new Error("bad policy");
              },
            },
          },
        },
        profile(),
      ),
    ).toBe("Copilot rejected the sandbox policy: bad policy");
  });
});

describe("toClaudeSandboxSettings", () => {
  test("fails closed, forbids unsandboxed commands, and denies every host on outbound deny", () => {
    expect(toClaudeSandboxSettings(profile())).toEqual({
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: [], allowLocalBinding: false },
      filesystem: {
        allowWrite: ["/repo"],
        allowRead: ["/opt/tools"],
        denyWrite: ["/opt/tools", "/home/op/.ssh"],
        denyRead: ["/home/op/.ssh"],
      },
    });
  });

  test("a read-only child of a writable root is write-denied", () => {
    const settings = toClaudeSandboxSettings(
      profile({ filesystem: { readwrite: ["/repo"], readonly: ["/repo/vendor"], denied: [] } }),
    );
    expect(settings.filesystem).toMatchObject({
      allowWrite: ["/repo"],
      denyWrite: ["/repo/vendor"],
    });
  });

  test("outbound allow leaves domains to the SDK unless hosts narrow them", () => {
    expect(
      toClaudeSandboxSettings(profile({ network: { outbound: "allow", loopback: true } })).network,
    ).toEqual({ allowLocalBinding: true });
    expect(
      toClaudeSandboxSettings(
        profile({ network: { outbound: "allow", allowedHosts: ["registry.npmjs.org"] } }),
      ).network,
    ).toEqual({ allowedDomains: ["registry.npmjs.org"], allowLocalBinding: false });
  });

  test("backend.claude spreads over the mapped settings", () => {
    const settings = toClaudeSandboxSettings(
      profile({ backend: { claude: { excludedCommands: ["docker"] } } }),
    );
    expect(settings.excludedCommands).toEqual(["docker"]);
    expect(settings.failIfUnavailable).toBe(true);
  });
});

describe("toCodexSandbox", () => {
  const baseline = { sandboxMode: "danger-full-access" as const, networkAccessEnabled: true };

  test("returns the baseline untouched when the profile is absent or disabled", () => {
    expect(toCodexSandbox(undefined, baseline)).toBe(baseline);
    expect(toCodexSandbox(profile({ enabled: false }), baseline)).toBe(baseline);
  });

  test("clamps danger-full-access to workspace-write and follows the profile's network", () => {
    expect(toCodexSandbox(profile(), baseline)).toEqual({
      sandboxMode: "workspace-write",
      networkAccessEnabled: false,
    });
    expect(
      toCodexSandbox(
        profile({
          network: { outbound: "allow" },
          backend: { codex: { mode: "danger-full-access" } },
        }),
        { sandboxMode: "read-only", networkAccessEnabled: false },
      ),
    ).toEqual({ sandboxMode: "workspace-write", networkAccessEnabled: true });
  });

  test("keeps a stricter configured or requested mode", () => {
    expect(
      toCodexSandbox(profile(), { sandboxMode: "read-only", networkAccessEnabled: false })
        .sandboxMode,
    ).toBe("read-only");
    expect(
      toCodexSandbox(profile({ backend: { codex: { mode: "read-only" } } }), baseline).sandboxMode,
    ).toBe("read-only");
  });
});

describe("codexSandboxGaps", () => {
  const clean = profile({
    filesystem: { readwrite: ["/repo"], readonly: ["/opt/tools"], denied: [] },
  });

  test("a profile codex can express has no gaps; a disabled one never does", () => {
    expect(codexSandboxGaps(clean)).toEqual([]);
    expect(codexSandboxGaps(profile({ enabled: false }))).toEqual([]);
  });

  test("denied paths, read-only roots under a writable one, and host allowlists are gaps", () => {
    expect(
      codexSandboxGaps(
        profile({
          filesystem: { readwrite: ["/repo"], readonly: ["/repo/vendor"], denied: ["/repo/.env"] },
          network: { outbound: "allow", allowedHosts: ["github.com"] },
        }),
      ),
    ).toEqual(["denied paths", "read-only paths inside a writable root", "a host allowlist"]);
  });
});

describe("sandboxSupportFor / describeSandboxBackend", () => {
  test("a provider that declares nothing reads as none", () => {
    expect(sandboxSupportFor(new StubProvider())).toBe("none");
    expect(
      sandboxSupportFor({
        getCapabilities: () => ({ ...new StubProvider().getCapabilities(), sandbox: "native" }),
      }),
    ).toBe("native");
  });

  test("names the backend per provider and platform", () => {
    expect(describeSandboxBackend("copilot", "native", "darwin")).toBe(
      "Copilot CLI sandbox (Seatbelt)",
    );
    expect(describeSandboxBackend("claude", "native", "linux")).toBe(
      "Claude Code sandbox (bubblewrap)",
    );
    expect(describeSandboxBackend("claude", "native", "win32")).toBe(
      "Claude Code sandbox (unsupported on win32)",
    );
    expect(describeSandboxBackend("pi", "tool", "darwin")).toBe(
      "pi shell runs in the Keelson sandbox",
    );
    expect(describeSandboxBackend("stub", "none", "darwin")).toBe("stub cannot sandbox its tools");
  });
});
