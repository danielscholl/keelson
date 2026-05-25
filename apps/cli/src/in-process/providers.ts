// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

// In-process provider + rib bootstrap. Mirrors apps/server/src/bootstrap.ts
// so the CLI's --server-down chat path can drive copilot / claude with the
// same keyring-backed credentials.
//
// Keelson v0 ships no in-tree ribs — the in-process tool catalog is empty
// by default. Operators that want chat-side tools register them by setting
// KEELSON_RIBS and embedding their rib packages from a custom entry point.

import {
  getProviderInfoList,
  isRegisteredProvider,
  registerClaudeProvider,
  registerCopilotProvider,
  registerStubProvider,
} from "@keelson/providers";

const KEYRING_SERVICE = "keelson" as const;
const BUILT_IN_IDS = ["stub", "copilot", "claude"] as const;
type BuiltInId = (typeof BUILT_IN_IDS)[number];

function isBuiltIn(id: string): id is BuiltInId {
  return (BUILT_IN_IDS as readonly string[]).includes(id);
}

function parseProviderList(raw: string | undefined): BuiltInId[] {
  if (!raw || raw.trim() === "") return [...BUILT_IN_IDS];
  const out: BuiltInId[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const id = part.trim().toLowerCase();
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    if (isBuiltIn(id)) out.push(id);
  }
  return out;
}

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

async function getCredential(serviceId: string): Promise<string | undefined> {
  try {
    const mod = await loadKeyring();
    const entry = new mod.Entry(KEYRING_SERVICE, serviceId);
    return entry.getPassword() ?? undefined;
  } catch (err) {
    if (noEntry(err)) return undefined;
    throw new Error(
      `keyring get failed for '${serviceId}': ${(err as Error).message}`,
    );
  }
}

export interface BootstrapResult {
  registered: string[];
}

// Register the set of providers requested by KEELSON_PROVIDERS (or all
// built-ins when unset), each with the keyring-backed credential getter.
// Idempotent — re-registration is a no-op inside the registry.
export function bootstrapCliProviders(): BootstrapResult {
  const requested = parseProviderList(process.env.KEELSON_PROVIDERS);
  const registered: string[] = [];
  for (const id of requested) {
    if (id === "stub") {
      registerStubProvider();
      registered.push("stub");
      continue;
    }
    if (id === "copilot") {
      registerCopilotProvider({ getCredential });
      registered.push("copilot");
      continue;
    }
    if (id === "claude") {
      registerClaudeProvider({ getCredential });
      registered.push("claude");
      continue;
    }
  }
  return { registered };
}

// Pick a default provider when --provider is omitted. Mirrors the SPA's
// pickInitialRef and the HTTP fallback path: copilot → stub → first
// registered non-workflow. Same invocation routes to the same provider
// whether or not `keelson serve` is running.
export function pickDefaultProvider(): string {
  const providers = getProviderInfoList();
  const ids = new Set(providers.map((p) => p.id));
  if (ids.has("copilot")) return "copilot";
  if (ids.has("stub")) return "stub";
  const fallback = providers.find((p) => p.id !== "workflow");
  if (fallback) return fallback.id;
  throw new Error(
    "no chat-capable provider registered; set KEELSON_PROVIDERS to include stub, copilot, or claude",
  );
}

export { isRegisteredProvider };

// In-process rib bootstrap. v0 ships no in-tree ribs, so the registered
// set is always empty. The function returns the same shape as
// bootstrapCliProviders so future versions can introduce dynamic rib
// loading without changing callers.
export function bootstrapCliTools(): BootstrapResult {
  return { registered: [] };
}
