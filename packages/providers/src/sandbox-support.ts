// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { SandboxSupport } from "@keelson/shared";
import type { IAgentProvider } from "./types.ts";

export function sandboxSupportFor(
  provider: Pick<IAgentProvider, "getCapabilities">,
): SandboxSupport {
  return provider.getCapabilities().sandbox ?? "none";
}

const NATIVE_BACKENDS: Record<string, Partial<Record<NodeJS.Platform, string>>> = {
  copilot: { darwin: "Seatbelt", linux: "bubblewrap", win32: "ProcessContainer" },
  claude: { darwin: "Seatbelt", linux: "bubblewrap" },
  codex: { darwin: "Seatbelt", linux: "Landlock", win32: "Windows sandbox" },
};

const NATIVE_NAMES: Record<string, string> = {
  copilot: "Copilot CLI sandbox",
  claude: "Claude Code sandbox",
  codex: "Codex sandbox",
};

export function describeSandboxBackend(
  providerId: string,
  support: SandboxSupport,
  platform: NodeJS.Platform = process.platform,
): string {
  if (support === "none") return `${providerId} cannot sandbox its tools`;
  if (support === "tool") return `${providerId} shell runs in the Keelson sandbox`;
  const name = NATIVE_NAMES[providerId] ?? `${providerId} native sandbox`;
  const backend = NATIVE_BACKENDS[providerId]?.[platform];
  return backend !== undefined ? `${name} (${backend})` : `${name} (unsupported on ${platform})`;
}
