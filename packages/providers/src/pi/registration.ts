// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { resolveKeelsonHome } from "@keelson/shared/paths";
import { isRegisteredProvider, registerProvider } from "../registry.ts";
import { PiVendorSlots } from "./concurrency.ts";
import { checkPiAuth, type PiAuthStatus } from "./factory.ts";
import { PiProvider, type PiProviderOptions, piCapabilities } from "./provider.ts";

// Reports whether pi has a usable credential (auth.json or a vendor env key).
// Self-managed, so unlike Copilot/Claude there is no keelson sign-in surface.
export type PiAuthProbe = () => PiAuthStatus;

export interface RegisterPiProviderResult {
  checkAuthStatus: PiAuthProbe;
}

export interface RegisterPiProviderOptions extends PiProviderOptions {
  // Max concurrent turns per pi vendor (e.g. { rec: 1 } for a single-slot
  // local engine). Vendors not listed are unlimited.
  concurrency?: Readonly<Record<string, number>>;
  // pi extension packages (config `pi.extensions`): an absolute path, or a
  // package name installed in the keelson home's node_modules.
  extensions?: readonly string[];
}

export function resolvePiExtensionPaths(
  specs: readonly string[],
  home: string = resolveKeelsonHome(),
): string[] {
  const out: string[] = [];
  for (const spec of specs) {
    const path = isAbsolute(spec) ? spec : join(home, "node_modules", spec);
    if (existsSync(path)) out.push(path);
    else console.warn(`[pi] extension '${spec}' not found at ${path}; skipping`);
  }
  return out;
}

export function registerPiProvider(
  options: RegisterPiProviderOptions = {},
): RegisterPiProviderResult {
  if (!isRegisteredProvider("pi")) {
    const { concurrency, extensions, ...providerOptions } = options;
    const slots = providerOptions.slots ?? new PiVendorSlots(concurrency);
    if (extensions !== undefined && extensions.length > 0) {
      providerOptions.extensionPaths = resolvePiExtensionPaths(extensions);
    }
    registerProvider({
      id: "pi",
      displayName: "Pi (community)",
      factory: () => new PiProvider({ ...providerOptions, slots }),
      capabilities: piCapabilities(providerOptions.defaultModel, providerOptions.sandboxSupport),
      builtIn: true,
      // No credentialServiceId: pi owns its own ~/.pi/agent/auth.json + vendor
      // env keys, so there is nothing in the keelson keychain to surface.
    });
  }
  return { checkAuthStatus: () => checkPiAuth() };
}
