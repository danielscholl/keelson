// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { isRegisteredProvider, registerProvider } from "../registry.ts";
import { type CopilotAuthStatus, CopilotClientFactory } from "./factory.ts";
import {
  COPILOT_CAPABILITIES,
  COPILOT_CREDENTIAL_SERVICE_ID,
  CopilotProvider,
  type CopilotProviderOptions,
  type GetCredentialFn,
} from "./provider.ts";

export interface RegisterCopilotProviderOptions {
  getCredential: GetCredentialFn;
  clientFactory?: CopilotClientFactory;
}

// Probe used by the credentials handler to render the Copilot SignIn
// surface. Reads any saved paste-token via the same getCredential channel
// the provider uses, then asks the SDK whether either auth path is live.
// `cwd` is forwarded to the SDK so the answer matches the workspace
// sendQuery would target.
export type CopilotAuthProbe = (cwd: string) => Promise<CopilotAuthStatus>;

export interface RegisterCopilotProviderResult {
  checkAuthStatus: CopilotAuthProbe;
}

export function registerCopilotProvider(
  options: RegisterCopilotProviderOptions,
): RegisterCopilotProviderResult {
  // Share one factory between the provider and the probe so the SDK module
  // is loaded once and tests can inject a mock loader via a single hook.
  const clientFactory = options.clientFactory ?? new CopilotClientFactory();
  const factoryOptions: CopilotProviderOptions = {
    getCredential: options.getCredential,
    clientFactory,
  };
  if (!isRegisteredProvider("copilot")) {
    registerProvider({
      id: "copilot",
      displayName: "GitHub Copilot",
      factory: () => new CopilotProvider(factoryOptions),
      capabilities: COPILOT_CAPABILITIES,
      builtIn: true,
      credentialServiceId: COPILOT_CREDENTIAL_SERVICE_ID,
    });
  }
  return {
    checkAuthStatus: async (cwd) => {
      const token = await options.getCredential(COPILOT_CREDENTIAL_SERVICE_ID);
      return clientFactory.checkAuthStatus(token, cwd);
    },
  };
}
