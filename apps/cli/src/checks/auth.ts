// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { checkPiAuth, type PiAuthStatus } from "@keelson/providers";
import {
  BUILT_IN_PROVIDER_IDS,
  loadKeelsonConfig,
  resolveDefaultProvider,
  resolveEnabledProviders,
} from "@keelson/shared/config";
import type { RunText } from "./toolchain.ts";
import type { CategoryResult, CheckResult } from "./types.ts";

const KEYRING_SERVICE = "keelson";
const KEYRING_PROBE_ACCOUNT_PREFIX = "doctor-probe";
const KEYRING_PROBE_VALUE = "ok";

export interface KeyringProbe {
  roundTrip(): Promise<{ ok: boolean; error?: string }>;
}

// Lazy import: top-level `import` of @napi-rs/keyring would crash unrelated
// commands (`keelson version`, `help`, `chat`) on systems where the native
// binding fails to load, because main.ts statically imports runDoctor.
type KeyringModule = typeof import("@napi-rs/keyring");
let keyringPromise: Promise<KeyringModule> | null = null;
function loadKeyring(): Promise<KeyringModule> {
  if (!keyringPromise) keyringPromise = import("@napi-rs/keyring");
  return keyringPromise;
}

const defaultKeyring: KeyringProbe = {
  async roundTrip() {
    let mod: KeyringModule;
    try {
      mod = await loadKeyring();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `keyring binding failed to load: ${message}` };
    }
    // Use a unique per-run account so we never overwrite or destroy a
    // pre-existing entry (doctor is documented as side-effect-free).
    const account = `${KEYRING_PROBE_ACCOUNT_PREFIX}-${crypto.randomUUID()}`;
    let entry: InstanceType<KeyringModule["Entry"]>;
    try {
      entry = new mod.Entry(KEYRING_SERVICE, account);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
    try {
      entry.setPassword(KEYRING_PROBE_VALUE);
      const got = entry.getPassword();
      if (got !== KEYRING_PROBE_VALUE) {
        const seen = got === null ? "<null>" : got;
        return {
          ok: false,
          error: `roundtrip mismatch: stored '${KEYRING_PROBE_VALUE}', read '${seen}'`,
        };
      }
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    } finally {
      try {
        entry.deletePassword();
      } catch {
        // ignore — best-effort cleanup; the unique UUID account makes orphans
        // harmless even if delete fails.
      }
    }
  },
};

// Which providers boot will register and where that decision came from. Pure
// over config.json + KEELSON_PROVIDERS, so doctor reports it without booting.
export interface ProviderSummary {
  enabled: string[];
  defaultProvider?: string;
  source: "KEELSON_PROVIDERS" | "config.json" | "defaults";
}

function defaultProviderSummary(): ProviderSummary {
  const config = loadKeelsonConfig();
  const enabled = resolveEnabledProviders({
    config,
    envProviders: process.env.KEELSON_PROVIDERS,
    known: BUILT_IN_PROVIDER_IDS,
  });
  const source = process.env.KEELSON_PROVIDERS?.trim()
    ? "KEELSON_PROVIDERS"
    : config.providers || config.defaultProvider
      ? "config.json"
      : "defaults";
  return { enabled, defaultProvider: resolveDefaultProvider(config, enabled), source };
}

export interface AuthDeps {
  runText?: RunText;
  keyring?: KeyringProbe;
  providerSummary?: () => ProviderSummary;
  // Defaults to the real pi credential probe; injected in tests.
  piAuth?: () => PiAuthStatus;
}

export async function runAuthCheck(deps: AuthDeps = {}): Promise<CategoryResult> {
  const keyring = deps.keyring ?? defaultKeyring;
  const keyringResult = await keyring.roundTrip();
  const checks: CheckResult[] = [
    keyringResult.ok
      ? { name: "keyring round-trip", status: "ok", detail: `service=${KEYRING_SERVICE}` }
      : {
          name: "keyring round-trip",
          // Provider credentials (Copilot / Claude API tokens) live in the OS
          // keychain — a broken keyring leaves chat without auth.
          status: "fail",
          detail: keyringResult.error,
          hint: "unlock the OS keychain (macOS Keychain Access / Linux Secret Service) — provider credentials won't load otherwise",
        },
  ];

  const summary = (deps.providerSummary ?? defaultProviderSummary)();
  checks.push(
    summary.enabled.length > 0
      ? {
          name: "providers",
          status: "ok",
          detail: `enabled=${summary.enabled.join(", ")}; default=${summary.defaultProvider ?? "none"} (source: ${summary.source})`,
        }
      : {
          name: "providers",
          status: "warn",
          detail: `none enabled (source: ${summary.source})`,
          hint: 'enable a provider in ~/.keelson/config.json ("providers": { "copilot": true }) or set KEELSON_PROVIDERS',
        },
  );

  // pi is self-managed (no keelson keychain), so report its own credential
  // presence separately — only when pi is actually enabled.
  if (summary.enabled.includes("pi")) {
    const pi = (deps.piAuth ?? checkPiAuth)();
    checks.push(
      pi.authenticated
        ? { name: "pi auth", status: "ok", detail: `credential found (${pi.source})` }
        : {
            name: "pi auth",
            status: "warn",
            detail: "no pi credential found",
            hint: "run pi's own login or set a vendor key (e.g. ANTHROPIC_API_KEY); pi reads ~/.pi/agent/auth.json",
          },
    );
  }

  return { category: "auth", checks };
}
