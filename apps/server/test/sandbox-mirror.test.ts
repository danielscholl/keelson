// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// The server sees both copies of the sandbox profile and resolved config, so
// typecheck here keeps the @keelson/workflows mirrors assignable to shared.

import { describe, expect, test } from "bun:test";
import type { SandboxProfile as SharedProfile } from "@keelson/shared";
import { type ResolvedSandboxConfig, resolveSandboxConfig } from "@keelson/shared/config";
import type { OperatorSandboxConfig, SandboxProfile as WorkflowsProfile } from "@keelson/workflows";

describe("SandboxProfile mirror", () => {
  test("each package's profile and resolved config satisfy the other's", () => {
    const shared: SharedProfile = {
      enabled: true,
      filesystem: { readwrite: ["/repo"], readonly: [], denied: [] },
      network: { outbound: "deny", loopback: false, allowedHosts: ["github.com"] },
      env: ["GH_TOKEN"],
      backend: { codex: { mode: "workspace-write" }, claude: { a: 1 } },
    };
    const asWorkflows: WorkflowsProfile = shared;
    const backToShared: SharedProfile = asWorkflows;
    const resolved: ResolvedSandboxConfig = resolveSandboxConfig({}, {});
    const operator: OperatorSandboxConfig = resolved;
    expect(backToShared).toEqual(shared);
    expect(operator.default).toBe(true);
  });
});
