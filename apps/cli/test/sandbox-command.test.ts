// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MxcExecutorResolution } from "@keelson/shared/launcher";
import { runSandboxCheck } from "../src/checks/sandbox.ts";
import { collectSandboxStatus, sandboxInstallSpec } from "../src/commands/sandbox.ts";

const ok: MxcExecutorResolution = {
  ok: true,
  path: "/home/k/node_modules/@microsoft/mxc-sdk/bin/arm64/mxc-exec-mac",
  source: "package",
  version: "1.0.1",
};
const missing: MxcExecutorResolution = {
  ok: false,
  reason: "@microsoft/mxc-sdk is not installed",
  installHint: "run `keelson sandbox install`",
};
const deps = (
  executor: MxcExecutorResolution,
  mode: { default: boolean; floor: boolean },
  probe: { ok: true } | { ok: false; detail: string } = { ok: true },
) => ({
  resolve: () => executor,
  sandboxConfig: () => mode,
  probe: async () => probe,
});

describe("runSandboxCheck", () => {
  test("unavailable is a failure when the sandbox is on, a warning when it is off", async () => {
    const on = await runSandboxCheck(deps(missing, { default: true, floor: false }));
    expect(on.category).toBe("sandbox");
    expect(on.checks.find((c) => c.name === "runtime")).toMatchObject({
      status: "fail",
      hint: "run `keelson sandbox install`",
    });
    const required = await runSandboxCheck(deps(missing, { default: false, floor: true }));
    expect(required.checks[0]?.detail).toBe("required (KEELSON_SANDBOX=required)");
    expect(required.checks.find((c) => c.name === "runtime")?.status).toBe("fail");
    const off = await runSandboxCheck(deps(missing, { default: false, floor: false }));
    expect(off.checks.find((c) => c.name === "runtime")?.status).toBe("warn");
  });

  test("a usable runtime reports its path, version, and a passing dry run", async () => {
    const result = await runSandboxCheck(deps(ok, { default: true, floor: false }));
    expect(result.checks.map((c) => [c.name, c.status])).toEqual([
      ["mode", "ok"],
      ["runtime", "ok"],
      ["probe", "ok"],
    ]);
    expect(result.checks[1]?.detail).toContain("1.0.1");
  });

  test("a failing dry run fails only when the sandbox is on", async () => {
    const bad = { ok: false as const, detail: "dry run exited 1" };
    const on = await runSandboxCheck(deps(ok, { default: true, floor: false }, bad));
    expect(on.checks.find((c) => c.name === "probe")?.status).toBe("fail");
    const off = await runSandboxCheck(deps(ok, { default: false, floor: false }, bad));
    expect(off.checks.find((c) => c.name === "probe")?.status).toBe("warn");
  });
});

describe("collectSandboxStatus", () => {
  test("does not probe an executor it could not resolve", async () => {
    let probed = 0;
    const status = await collectSandboxStatus({
      resolve: () => missing,
      sandboxConfig: () => ({ default: false, floor: false }),
      probe: async () => {
        probed++;
        return { ok: true };
      },
    });
    expect(status.probe).toBeUndefined();
    expect(probed).toBe(0);
  });
});

describe("sandboxInstallSpec", () => {
  test("pins to the released CLI's peer range, else the verified version", () => {
    const home = mkdtempSync(join(tmpdir(), "keelson-sbx-spec-"));
    try {
      expect(sandboxInstallSpec(home)).toBe("@microsoft/mxc-sdk@1.0.1");
      const cli = join(home, "node_modules", "@keelson", "cli");
      mkdirSync(cli, { recursive: true });
      writeFileSync(
        join(cli, "package.json"),
        JSON.stringify({ peerDependencies: { "@microsoft/mxc-sdk": "~1.0.2" } }),
      );
      expect(sandboxInstallSpec(home)).toBe("@microsoft/mxc-sdk@~1.0.2");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
