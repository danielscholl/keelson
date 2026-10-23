// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { SandboxProfile } from "@keelson/shared";
import type { CodexSandboxMode } from "./factory.ts";

export interface CodexSandboxSettings {
  sandboxMode: CodexSandboxMode;
  networkAccessEnabled: boolean;
}

const STRICTNESS: Record<CodexSandboxMode, number> = {
  "read-only": 0,
  "workspace-write": 1,
  "danger-full-access": 2,
};

// An enabled profile caps codex at workspace-write, so a configured or
// backend-requested danger-full-access cannot leave the sandbox, and network
// follows the profile instead of `codex.network`.
export function toCodexSandbox(
  profile: SandboxProfile | undefined,
  baseline: CodexSandboxSettings,
): CodexSandboxSettings {
  if (!profile?.enabled) return baseline;
  const requested = profile.backend?.codex?.mode ?? baseline.sandboxMode;
  return {
    sandboxMode:
      STRICTNESS[requested] > STRICTNESS["workspace-write"] ? "workspace-write" : requested,
    networkAccessEnabled: profile.network.outbound === "allow",
  };
}
