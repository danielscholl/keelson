// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { SandboxProfile } from "@keelson/shared";

// The SDK's SandboxSettings. failIfUnavailable makes a host without Seatbelt or
// bubblewrap end the turn instead of running Bash unconfined.
export function toClaudeSandboxSettings(profile: SandboxProfile): Record<string, unknown> {
  const { filesystem, network } = profile;
  // An empty allowedDomains denies every host; absent leaves the SDK's own
  // network handling, which is what outbound "allow" without a host list means.
  const allowedDomains =
    network.outbound === "deny" ? [] : network.allowedHosts ? [...network.allowedHosts] : undefined;
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    network: {
      ...(allowedDomains !== undefined ? { allowedDomains } : {}),
      allowLocalBinding: network.loopback === true,
    },
    filesystem: {
      allowWrite: [...filesystem.readwrite],
      allowRead: [...filesystem.readonly],
      denyWrite: [...filesystem.denied],
      denyRead: [...filesystem.denied],
    },
    ...profile.backend?.claude,
  };
}
