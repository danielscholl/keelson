// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { CLAUDE_CREDENTIAL_SERVICE_ID, COPILOT_CREDENTIAL_SERVICE_ID } from "@keelson/providers";
import { gatewayCredentialServiceId, type KeelsonConfig } from "@keelson/shared/config";

// Program files inside the home — the bun project the installer provisions.
// Everything else under the home is the operator's own data and survives
// unless --purge is given.
export const PROGRAM_ENTRIES = ["node_modules", "package.json", "bun.lock", ".npmrc"] as const;

// Left in the home by a non-purge uninstall. Removing package.json destroys the
// only evidence that a directory was ever an install, and a later --purge must
// not infer one from a missing manifest: KEELSON_HOME is operator-supplied, so
// every unrelated directory would qualify. This marker is that evidence.
export const UNINSTALL_MARKER = ".keelson-uninstalled";

export function uninstallMarkerContents(version: string, when: string): string {
  return [
    `keelson ${version} removed this home's program files on ${when}.`,
    "The data beside this file was kept. Delete this directory to discard it,",
    "or re-run the installer to make the home usable again.",
    "",
  ].join("\n");
}

// Keychain accounts keelson itself writes under the `keelson` service. Codex
// and pi are absent by design: both manage their own auth files outside the
// keychain, so there is nothing here to revoke for them.
export function credentialAccounts(config: KeelsonConfig): string[] {
  return [
    CLAUDE_CREDENTIAL_SERVICE_ID,
    COPILOT_CREDENTIAL_SERVICE_ID,
    ...(config.gateways ?? []).map((g) => gatewayCredentialServiceId(g.name)),
  ];
}

// @napi-rs/keyring resolves entries by exact (service, account) and cannot
// enumerate, so a rib's credentials — stored under rib-chosen service ids at
// `rib_<ribId>_<serviceId>` — are not derivable here. Uninstall reports them as
// possibly-remaining rather than implying a clean sweep it cannot perform.
export function unreachableCredentialRibs(installedRibIds: readonly string[]): string[] {
  return [...installedRibIds].sort();
}
