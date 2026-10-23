// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import {
  describeSandboxBackend as describeSharedSandboxBackend,
  type SandboxSupport,
} from "@keelson/shared";
import type { IAgentProvider } from "./types.ts";

export function sandboxSupportFor(
  provider: Pick<IAgentProvider, "getCapabilities">,
): SandboxSupport {
  return provider.getCapabilities().sandbox ?? "none";
}

export function describeSandboxBackend(
  providerId: string,
  support: SandboxSupport,
  platform: NodeJS.Platform = process.platform,
): string {
  return describeSharedSandboxBackend(providerId, support, platform);
}
