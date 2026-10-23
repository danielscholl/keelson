// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import type { KeelsonConfig } from "@keelson/shared/config";
import { type ResolvedSandboxConfig, resolveSandboxConfig } from "@keelson/shared/config";
import { createMxcRuntime, resolveMxcExecutor } from "@keelson/shared/launcher";
import { keelsonPaths, resolveKeelsonHome } from "@keelson/shared/paths";
import { bundledBinDir, createOperatorSandboxPolicy, type SandboxPolicy } from "@keelson/workflows";

export class SandboxUnavailableError extends Error {
  override readonly name = "SandboxUnavailableError";
}

export interface CliSandbox {
  resolved: ResolvedSandboxConfig;
  policy: SandboxPolicy;
  // True when the host executor resolves, so a "tool" provider gets a confined shell.
  runtimeAvailable: boolean;
}

// The policy and runtime the server builds at boot, so an offline run or turn
// sandboxes (or fails closed) exactly as a server-routed one would.
export function cliSandbox(config: KeelsonConfig): CliSandbox {
  const resolved = resolveSandboxConfig(config);
  for (const warning of resolved.warnings) console.warn(`[sandbox] ${warning}`);
  const home = resolveKeelsonHome();
  const executor = resolveMxcExecutor();
  const policy = createOperatorSandboxPolicy(resolved, {
    home,
    dbPath: keelsonPaths(home).dbPath,
    bundledBinDir: bundledBinDir(),
    ...(executor.ok
      ? { runtime: createMxcRuntime({ executorPath: executor.path }) }
      : { unavailableReason: executor.reason }),
  });
  return { resolved, policy, runtimeAvailable: executor.ok };
}
