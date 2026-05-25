// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { isRegisteredProvider, registerProvider } from "../registry.ts";
import {
  ClaudeQueryFactory,
  type ClaudeCliAuthResult,
} from "./factory.ts";
import {
  CLAUDE_CAPABILITIES,
  CLAUDE_CREDENTIAL_SERVICE_ID,
  ClaudeProvider,
  type ClaudeProviderOptions,
  type GetCredentialFn,
} from "./provider.ts";

export interface RegisterClaudeProviderOptions {
  getCredential: GetCredentialFn;
  queryFactory?: ClaudeQueryFactory;
}

// Probe used by the credentials handler to render the Claude SignIn UI.
// Mirrors CopilotAuthProbe but with a Claude-shaped result. Stateless — the
// CLI maintains its own auth, so no token is needed here.
export type ClaudeAuthProbe = () => Promise<ClaudeCliAuthResult>;

export interface RegisterClaudeProviderResult {
  checkAuthStatus: ClaudeAuthProbe;
}

export function registerClaudeProvider(
  options: RegisterClaudeProviderOptions,
): RegisterClaudeProviderResult {
  // Share one factory between provider and probe so the SDK + CLI runner
  // are loaded/configured once. Tests inject either via factory options.
  const queryFactory = options.queryFactory ?? new ClaudeQueryFactory();
  const factoryOptions: ClaudeProviderOptions = {
    getCredential: options.getCredential,
    queryFactory,
  };
  if (!isRegisteredProvider("claude")) {
    registerProvider({
      id: "claude",
      displayName: "Claude",
      factory: () => new ClaudeProvider(factoryOptions),
      capabilities: CLAUDE_CAPABILITIES,
      builtIn: true,
      credentialServiceId: CLAUDE_CREDENTIAL_SERVICE_ID,
    });
  }
  return {
    checkAuthStatus: () => queryFactory.checkAuthStatus(),
  };
}
