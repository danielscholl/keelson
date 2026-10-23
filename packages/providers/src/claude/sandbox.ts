// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { SandboxProfile } from "@keelson/shared";

// The SDK's SandboxSettings. failIfUnavailable makes a host without Seatbelt or
// bubblewrap end the turn instead of running Bash unconfined. `backend.claude`
// is the base the profile is applied over, never on top of it: it may add SDK
// options and extra grants, but cannot turn confinement off or drop a deny.
export function toClaudeSandboxSettings(profile: SandboxProfile): Record<string, unknown> {
  const { filesystem, network } = profile;
  const pass = profile.backend?.claude ?? {};
  const passFs = asRecord(pass.filesystem);
  const passNet = asRecord(pass.network);
  // An empty allowedDomains denies every host; absent leaves the SDK's own
  // network handling, which is what outbound "allow" without a host list means.
  const allowedDomains =
    network.outbound === "deny"
      ? []
      : network.allowedHosts
        ? [...network.allowedHosts]
        : passNet.allowedDomains;
  return {
    autoAllowBashIfSandboxed: true,
    ...pass,
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    network: {
      ...passNet,
      ...(allowedDomains !== undefined ? { allowedDomains } : {}),
      allowLocalBinding: network.loopback === true,
    },
    filesystem: {
      ...passFs,
      allowWrite: union(passFs.allowWrite, filesystem.readwrite),
      allowRead: union(passFs.allowRead, filesystem.readonly),
      // allowRead does not revoke a write grant inherited from a writable
      // parent, so read-only roots are write-denied explicitly.
      denyWrite: union(passFs.denyWrite, filesystem.readonly, filesystem.denied),
      denyRead: union(passFs.denyRead, filesystem.denied),
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function union(...lists: unknown[]): string[] {
  const out = new Set<string>();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) if (typeof item === "string") out.add(item);
  }
  return [...out];
}
