// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// Vendor SDKs the harness does not ship, keyed by the provider that wraps them.
// Each runs to hundreds of megabytes and serves exactly one provider, so a
// fresh install carries none of them and `keelson provider add <id>` fetches
// what the operator actually uses.
export const ON_DEMAND_PROVIDER_PACKAGES: Readonly<Record<string, readonly string[]>> = {
  claude: ["@anthropic-ai/claude-agent-sdk"],
  codex: ["@openai/codex-sdk"],
  pi: ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai"],
};

export function isOnDemandProvider(id: string): boolean {
  return Object.hasOwn(ON_DEMAND_PROVIDER_PACKAGES, id);
}

export function onDemandProviderIds(): string[] {
  return Object.keys(ON_DEMAND_PROVIDER_PACKAGES).sort();
}

// Resolution is relative to THIS module, which in a release is the bundled CLI
// under <home>/node_modules/@keelson/cli/dist — so it walks up to the home's
// own node_modules, exactly where `keelson provider add` installs. Never throws:
// a provider whose SDK is absent must degrade to "not installed", not a boot
// failure.
export function missingProviderPackages(id: string): readonly string[] {
  const packages = ON_DEMAND_PROVIDER_PACKAGES[id];
  if (!packages) return [];
  return packages.filter((spec) => {
    try {
      import.meta.resolve(spec);
      return false;
    } catch {
      return true;
    }
  });
}

export function isProviderSdkInstalled(id: string): boolean {
  return missingProviderPackages(id).length === 0;
}

export function providerNotInstalledMessage(id: string): string {
  return `provider '${id}' is not installed — run: keelson provider add ${id}`;
}
