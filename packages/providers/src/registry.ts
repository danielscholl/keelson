// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { UnknownProviderError } from "./errors.ts";
import type { IAgentProvider, ProviderInfo, ProviderRegistration } from "./types.ts";

const registry = new Map<string, ProviderRegistration>();

// Provider instances that expose dispose() — tracked so disposeAllProviders()
// can drain them at shutdown. A singleton provider (Copilot's warm-client
// holder) returns the same reference on every factory() call, so the Set
// dedupes to one entry; stateless per-turn providers omit dispose() and are
// never tracked, so this can't grow unbounded.
const liveProviders = new Set<IAgentProvider>();

export function registerProvider(entry: ProviderRegistration): void {
  if (registry.has(entry.id)) {
    throw new Error(`Provider '${entry.id}' is already registered`);
  }
  registry.set(entry.id, entry);
}

export function getAgentProvider(id: string): IAgentProvider {
  const entry = registry.get(id);
  if (!entry) {
    throw new UnknownProviderError(id, [...registry.keys()]);
  }
  const provider = entry.factory();
  if (typeof provider.dispose === "function") {
    liveProviders.add(provider);
  }
  return provider;
}

// Drain every disposable provider instance handed out by getAgentProvider.
// Called from the server shutdown sequence and the in-process CLI exit so a
// warm subprocess is reaped deterministically rather than orphaned. One
// disposer throwing logs a warning and never blocks the rest.
export async function disposeAllProviders(): Promise<void> {
  const instances = [...liveProviders];
  liveProviders.clear();
  await Promise.allSettled(
    instances.map(async (p) => {
      try {
        await p.dispose?.();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[keelson] provider '${p.getType()}' dispose() threw: ${msg}`);
      }
    }),
  );
}

export function getRegistration(id: string): ProviderRegistration {
  const entry = registry.get(id);
  if (!entry) {
    throw new UnknownProviderError(id, [...registry.keys()]);
  }
  return entry;
}

export function getProviderInfoList(): ProviderInfo[] {
  return [...registry.values()].map(
    ({ id, displayName, capabilities, builtIn, credentialServiceId }) => {
      const info: ProviderInfo = { id, displayName, capabilities, builtIn };
      // Omit when absent — providerInfoSchema is .strict() with an optional
      // field; an explicit `undefined` value would fail validation.
      if (credentialServiceId !== undefined) {
        info.credentialServiceId = credentialServiceId;
      }
      return info;
    },
  );
}

export function isRegisteredProvider(id: string): boolean {
  return registry.has(id);
}

// Remove a registration so it can be replaced (gateways are added/edited at
// runtime). Returns false when nothing was registered under `id`. Built-in
// providers are registered once at boot and never unregistered through this.
export function unregisterProvider(id: string): boolean {
  return registry.delete(id);
}

/** @internal Test-only — clears the registry. Not for production use. */
export function clearRegistry(): void {
  registry.clear();
  liveProviders.clear();
}
