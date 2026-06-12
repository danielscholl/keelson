// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { isRegisteredProvider, registerProvider } from "../registry.ts";
import { type CodexAuthStatus, checkCodexAuth } from "./factory.ts";
import { CODEX_CAPABILITIES, CodexProvider, type CodexProviderOptions } from "./provider.ts";

// Reports whether codex has a usable credential (~/.codex/auth.json or an
// OPENAI_API_KEY / CODEX_API_KEY env key). Self-managed, so — like pi — there is
// no keelson sign-in surface.
export type CodexAuthProbe = () => CodexAuthStatus;

export interface RegisterCodexProviderResult {
  checkAuthStatus: CodexAuthProbe;
}

export function registerCodexProvider(
  options: CodexProviderOptions = {},
): RegisterCodexProviderResult {
  if (!isRegisteredProvider("codex")) {
    registerProvider({
      id: "codex",
      displayName: "Codex",
      factory: () => new CodexProvider(options),
      capabilities: CODEX_CAPABILITIES,
      builtIn: true,
      // No credentialServiceId: codex owns its own ~/.codex/auth.json + env
      // keys, so there is nothing in the keelson keychain to surface.
    });
  }
  return { checkAuthStatus: () => checkCodexAuth() };
}
