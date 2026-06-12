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
  isRegisteredProvider,
  registerClaudeProvider,
  registerCodexProvider,
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

// Register the set of providers requested by KEELSON_PROVIDERS (or all
// built-ins when unset), each with the keyring-backed credential getter.
// Idempotent — re-registration is a no-op inside the registry.
export function bootstrapCliProviders(): BootstrapResult {
  const config = loadKeelsonConfig();
  const requested = resolveEnabledProviders({
    config,
    envProviders: process.env.KEELSON_PROVIDERS,
    known: BUILT_IN_PROVIDER_IDS,
  });
  const registered: string[] = [];
  for (const id of requested) {
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
  return { registered };
}

// Pick a default provider when --provider is omitted. Shares resolveDefaultProvider
// with the server and the SPA picker: config.defaultProvider → copilot → first
// real provider → stub. Same invocation routes to the same provider whether or
// not `keelson service` is running.
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
