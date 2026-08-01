// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

// In-process provider + rib bootstrap. Mirrors apps/server/src/bootstrap.ts
// so the CLI's --server-down chat path can drive copilot / claude with the
// same keyring-backed credentials.
//
// No in-tree ribs ship — the in-process tool catalog is empty by default.
// Operators that want chat-side tools register them by setting KEELSON_RIBS
// and embedding their rib packages from a custom entry point.

import {
  getProviderInfoList,
  isOnDemandProvider,
  isProviderSdkInstalled,
  isRegisteredProvider,
  providerNotInstalledMessage,
  registerClaudeProvider,
  registerCodexProvider,
  registerConfiguredGateways,
  registerCopilotProvider,
  registerPiProvider,
  registerStubProvider,
} from "@keelson/providers";
import {
  BUILT_IN_PROVIDER_IDS,
  loadKeelsonConfig,
  resolveDefaultProvider,
  resolveEnabledProviders,
} from "@keelson/shared/config";

const KEYRING_SERVICE = "keelson" as const;

type KeyringModule = typeof import("@napi-rs/keyring");
let keyringPromise: Promise<KeyringModule> | null = null;
function loadKeyring(): Promise<KeyringModule> {
  if (!keyringPromise) keyringPromise = import("@napi-rs/keyring");
  return keyringPromise;
}

function noEntry(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message.toLowerCase();
  return m.includes("no entry") || m.includes("not found");
}

let keyringWarned = false;

// An unavailable OS keychain (headless runner, no Secret Service) reads as "no
// stored credential" so providers fall through to their env API keys instead of
// failing the whole turn. The `loader` parameter exists for tests.
export async function getCliCredential(
  serviceId: string,
  loader: () => Promise<KeyringModule> = loadKeyring,
): Promise<string | undefined> {
  try {
    const mod = await loader();
    const entry = new mod.Entry(KEYRING_SERVICE, serviceId);
    return entry.getPassword() ?? undefined;
  } catch (err) {
    if (noEntry(err)) return undefined;
    if (!keyringWarned) {
      keyringWarned = true;
      console.warn(
        `[keelson] OS keychain unavailable (${(err as Error).message}); using environment credentials only`,
      );
    }
    return undefined;
  }
}

export interface BootstrapResult {
  registered: string[];
}

export interface ProviderBootstrapResult extends BootstrapResult {
  // Enabled providers left unregistered because their vendor SDK is absent.
  notInstalled: string[];
}

// Register the set of providers requested by KEELSON_PROVIDERS (or all
// built-ins when unset), each with the keyring-backed credential getter.
// Idempotent — re-registration is a no-op inside the registry.
export function bootstrapCliProviders(): ProviderBootstrapResult {
  const config = loadKeelsonConfig();
  const requested = resolveEnabledProviders({
    config,
    envProviders: process.env.KEELSON_PROVIDERS,
    known: BUILT_IN_PROVIDER_IDS,
  });
  const registered: string[] = [];
  const notInstalled: string[] = [];
  for (const id of requested) {
    // Same floor the server applies: a provider whose vendor SDK is absent must
    // not reach the picker, or the turn dies on a dynamic import instead of
    // falling back to one that can actually run.
    if (isOnDemandProvider(id) && !isProviderSdkInstalled(id)) {
      notInstalled.push(id);
      console.warn(`[keelson] ${providerNotInstalledMessage(id)}`);
      continue;
    }
    if (id === "stub") {
      registerStubProvider();
      registered.push("stub");
      continue;
    }
    if (id === "copilot") {
      registerCopilotProvider({ getCredential: getCliCredential });
      registered.push("copilot");
      continue;
    }
    if (id === "claude") {
      registerClaudeProvider({
        getCredential: getCliCredential,
        ...(config.claude?.auth !== undefined ? { authPreference: config.claude.auth } : {}),
      });
      registered.push("claude");
      continue;
    }
    if (id === "pi") {
      // Self-managed auth — no keyring credential to pass.
      registerPiProvider();
      registered.push("pi");
      continue;
    }
    if (id === "codex") {
      // Self-managed auth — no keyring credential to pass.
      registerCodexProvider({
        ...(config.codex?.sandbox !== undefined ? { sandboxMode: config.codex.sandbox } : {}),
        ...(config.codex?.network !== undefined
          ? { networkAccessEnabled: config.codex.network }
          : {}),
      });
      registered.push("codex");
    }
  }
  // Configured OpenAI-compatible gateways, each registered as a provider named
  // for the gateway, so the server-down chat/workflow path can drive them too.
  registered.push(
    ...registerConfiguredGateways({
      gateways: config.gateways ?? [],
      getApiKey: getCliCredential,
    }),
  );
  return { registered, notInstalled };
}

// Pick a default provider when --provider is omitted. Shares resolveDefaultProvider
// with the server and the SPA picker: config.defaultProvider → copilot → first
// real provider → stub. Same invocation routes to the same provider whether or
// not `keelson start` is running.
export function pickDefaultProvider(): string {
  const ids = getProviderInfoList().map((p) => p.id);
  const id = resolveDefaultProvider(loadKeelsonConfig(), ids);
  if (!id) {
    throw new Error(
      "no chat-capable provider registered; set KEELSON_PROVIDERS to include stub, copilot, or claude",
    );
  }
  return id;
}

export { isRegisteredProvider };

// In-process rib bootstrap. No in-tree ribs ship, so the registered set is
// always empty. The function returns the same shape as bootstrapCliProviders
// so future versions can introduce dynamic rib loading without changing callers.
export function bootstrapCliTools(): BootstrapResult {
  return { registered: [] };
}
