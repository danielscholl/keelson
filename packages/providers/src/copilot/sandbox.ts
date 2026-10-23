// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { SandboxProfile } from "@keelson/shared";

// The SDK's SandboxConfig. `profile.env` has no counterpart here: Copilot's
// credentials.envVars masks each value behind per-variable HTTPS inject hosts,
// so an operator who needs one sets it through `backend.copilot`.
export function toCopilotSandboxConfig(profile: SandboxProfile): Record<string, unknown> {
  const { filesystem, network } = profile;
  return {
    enabled: true,
    addCurrentWorkingDirectory: true,
    allowBypass: false,
    sandboxMcpServers: true,
    userPolicy: {
      filesystem: {
        readwritePaths: [...filesystem.readwrite],
        readonlyPaths: [...filesystem.readonly],
        deniedPaths: [...filesystem.denied],
      },
      network: {
        allowOutbound: network.outbound === "allow",
        allowLocalNetwork: network.loopback === true,
        ...(network.allowedHosts !== undefined ? { allowedHosts: [...network.allowedHosts] } : {}),
      },
    },
    ...profile.backend?.copilot,
  };
}

// Structural slices of the SDK's server and session RPC surfaces.
export interface CopilotSandboxClient {
  readonly rpc?: {
    sandbox?: { getHostSupport?: () => Promise<{ supported?: boolean; reason?: string }> };
  };
}

export interface CopilotSandboxSession {
  readonly rpc?: {
    options?: { update?: (params: Record<string, unknown>) => Promise<{ success?: boolean }> };
  };
}

// The SDK's createSession/resumeSession build their wire payload from a fixed
// field list that omits sandboxConfig, so the policy only takes effect through
// session.options.update. Returns why the sandbox could not be applied, or
// undefined once the session confirmed it.
export async function applyCopilotSandbox(
  client: CopilotSandboxClient,
  session: CopilotSandboxSession,
  profile: SandboxProfile,
): Promise<string | undefined> {
  let host: { supported?: boolean; reason?: string } | undefined;
  try {
    host = await client.rpc?.sandbox?.getHostSupport?.();
  } catch (err) {
    return `could not check Copilot sandbox support: ${errorMessage(err)}`;
  }
  if (host === undefined) return "this Copilot SDK cannot report sandbox support";
  if (host.supported !== true) {
    return `Copilot cannot sandbox on this host${host.reason ? `: ${host.reason}` : ""}`;
  }
  const update = session.rpc?.options?.update;
  if (update === undefined) return "this Copilot SDK cannot apply a sandbox to a session";
  try {
    const result = await update({
      sandboxConfig: toCopilotSandboxConfig(profile),
      sandboxConfigSource: "session_flag",
    });
    if (result?.success !== true) return "Copilot did not accept the sandbox policy";
  } catch (err) {
    return `Copilot rejected the sandbox policy: ${errorMessage(err)}`;
  }
  return undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
