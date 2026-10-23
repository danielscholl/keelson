// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { isAbsolute, relative } from "node:path";
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

// What an enabled profile asks for that codex's thread options cannot express:
// codex reads anywhere and writes all of cwd, with only an on/off network
// switch. A non-empty result means the turn must not run.
export function codexSandboxGaps(profile: SandboxProfile): string[] {
  if (!profile.enabled) return [];
  const gaps: string[] = [];
  if (profile.filesystem.denied.length > 0) gaps.push("denied paths");
  const inside = (child: string, parent: string) => {
    const rel = relative(parent, child);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  if (
    profile.filesystem.readonly.some((ro) =>
      profile.filesystem.readwrite.some((rw) => inside(ro, rw)),
    )
  ) {
    gaps.push("read-only paths inside a writable root");
  }
  if (profile.network.outbound === "allow" && (profile.network.allowedHosts?.length ?? 0) > 0) {
    gaps.push("a host allowlist");
  }
  return gaps;
}

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
