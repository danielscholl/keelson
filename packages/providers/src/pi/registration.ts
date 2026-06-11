// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { isRegisteredProvider, registerProvider } from "../registry.ts";
import { checkPiAuth, type PiAuthStatus } from "./factory.ts";
import { PI_CAPABILITIES, PiProvider, type PiProviderOptions } from "./provider.ts";

// Reports whether pi has a usable credential (auth.json or a vendor env key).
// Self-managed, so unlike Copilot/Claude there is no keelson sign-in surface.
export type PiAuthProbe = () => PiAuthStatus;

export interface RegisterPiProviderResult {
  checkAuthStatus: PiAuthProbe;
}

export function registerPiProvider(options: PiProviderOptions = {}): RegisterPiProviderResult {
  if (!isRegisteredProvider("pi")) {
    registerProvider({
      id: "pi",
      displayName: "Pi (community)",
      factory: () => new PiProvider(options),
      capabilities: PI_CAPABILITIES,
      builtIn: true,
      // No credentialServiceId: pi owns its own ~/.pi/agent/auth.json + vendor
      // env keys, so there is nothing in the keelson keychain to surface.
    });
  }
  return { checkAuthStatus: () => checkPiAuth() };
}
