// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import {
  isProviderSdkInstalled as defaultIsInstalled,
  isOnDemandProvider,
  onDemandProviderIds,
} from "@keelson/providers";
import {
  BUILT_IN_PROVIDER_IDS,
  loadKeelsonConfig as defaultLoadConfig,
  type KeelsonConfig,
  resolveEnabledProviders,
} from "@keelson/shared/config";
import type { CategoryResult, CheckResult } from "./types.ts";

export interface ProvidersDeps {
  loadConfig?: () => KeelsonConfig;
  isInstalled?: (id: string) => boolean;
  envProviders?: string;
}

export function runProvidersCheck(deps: ProvidersDeps = {}): CategoryResult {
  const loadConfig = deps.loadConfig ?? defaultLoadConfig;
  const isInstalled = deps.isInstalled ?? defaultIsInstalled;
  const config = loadConfig();
  const enabled = resolveEnabledProviders({
    config,
    envProviders: deps.envProviders ?? process.env.KEELSON_PROVIDERS,
    known: BUILT_IN_PROVIDER_IDS,
    onWarn: () => {},
  });

  const checks: CheckResult[] = [];
  let usable = (config.gateways ?? []).length;
  for (const id of enabled) {
    if (!isOnDemandProvider(id)) {
      usable += 1;
      continue;
    }
    if (isInstalled(id)) {
      usable += 1;
      checks.push({ name: id, status: "ok", detail: "SDK installed" });
      continue;
    }
    // Enabled but unresolvable: the server leaves it unregistered, so every turn
    // routed to it would fall back or fail.
    checks.push({
      name: id,
      status: "warn",
      detail: "enabled but its SDK is not installed; the server will not register it",
      hint: `run \`keelson provider add ${id}\`, or disable it in config.json (providers.${id})`,
    });
  }

  if (usable === 0) {
    // One runnable command, not a `|` list: copilot ships with the harness and
    // `provider add` rejects it, and a shell would read the bar as a pipe.
    checks.push({
      name: "usable provider",
      status: "warn",
      detail: "no enabled provider has a usable SDK and no gateway is configured",
      hint: `run \`keelson provider add ${onDemandProviderIds()[0]}\` (also available: ${onDemandProviderIds()
        .slice(1)
        .join(", ")}), or add an OpenAI-compatible endpoint with \`keelson gateway add\``,
    });
  }
  if (checks.length === 0) {
    checks.push({
      name: "provider SDKs",
      status: "skip",
      detail: "no on-demand providers enabled",
    });
  }
  return { category: "providers", checks };
}
