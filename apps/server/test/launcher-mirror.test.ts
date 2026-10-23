// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// The server is the one workspace that sees both copies of the launcher types,
// so typecheck here is what keeps the workflows mirror assignable to shared.

import { describe, expect, test } from "bun:test";
import {
  type ProcessLauncher as SharedLauncher,
  hostLauncher as sharedHostLauncher,
} from "@keelson/shared/launcher";
import {
  type ProcessLauncher as WorkflowsLauncher,
  hostLauncher as workflowsHostLauncher,
} from "@keelson/workflows";

describe("ProcessLauncher mirror", () => {
  test("each package's launcher satisfies the other's contract", () => {
    const sharedAsWorkflows: WorkflowsLauncher = sharedHostLauncher;
    const workflowsAsShared: SharedLauncher = workflowsHostLauncher;
    expect(sharedAsWorkflows.id).toBe("host");
    expect(workflowsAsShared.id).toBe("host");
  });
});
