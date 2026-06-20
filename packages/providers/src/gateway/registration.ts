// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { gatewayCredentialServiceId } from "@keelson/shared/config";
import { isRegisteredProvider, registerProvider } from "../registry.ts";
import { GatewayProvider, type GatewayProviderOptions } from "./provider.ts";

export interface RegisterGatewayProviderOptions extends GatewayProviderOptions {
  displayName?: string;
}

// Register one gateway as a provider whose id is the gateway name. Throws on a
// duplicate id (registerProvider's invariant) — the boot helper and the
// runtime handler each clear/guard the id before calling this.
export function registerGatewayProvider(opts: RegisterGatewayProviderOptions): void {
  // Build once to read the computed capabilities for the registry entry; the
  // factory builds a fresh instance per turn like the other providers.
  const probe = new GatewayProvider(opts);
  registerProvider({
    id: opts.id,
    displayName: opts.displayName ?? opts.id,
    factory: () => new GatewayProvider(opts),
    capabilities: probe.getCapabilities(),
    builtIn: false,
    credentialServiceId: gatewayCredentialServiceId(opts.id),
  });
}

// Structural view of a configured gateway — accepts a `GatewayConfig` directly
// while keeping this package free of a value dependency on the config schema.
export interface ConfiguredGateway {
  name: string;
  baseUrl: string;
  model?: string;
}

// Register every configured gateway, resolving each key lazily through the
// host's credential reader (keyed by gatewayCredentialServiceId). A name that
// already names a registered provider is skipped with a warning rather than
// throwing, so a config typo (or a gateway shadowing a built-in) can't down
// boot. Returns the ids actually registered.
export function registerConfiguredGateways(opts: {
  gateways: readonly ConfiguredGateway[];
  getApiKey: (serviceId: string) => Promise<string | undefined>;
  fetchImpl?: typeof fetch;
}): string[] {
  const registered: string[] = [];
  for (const gw of opts.gateways) {
    if (isRegisteredProvider(gw.name)) {
      console.warn(
        `[keelson] gateway '${gw.name}' shadows an already-registered provider; skipping`,
      );
      continue;
    }
    try {
      registerGatewayProvider({
        id: gw.name,
        baseUrl: gw.baseUrl,
        getApiKey: () => opts.getApiKey(gatewayCredentialServiceId(gw.name)),
        ...(gw.model ? { model: gw.model } : {}),
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      });
      registered.push(gw.name);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[keelson] failed to register gateway '${gw.name}': ${msg}`);
    }
  }
  return registered;
}
