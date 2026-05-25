// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

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

export interface AuthDeps {
  runText?: RunText;
  keyring?: KeyringProbe;
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

  return { category: "auth", checks };
}
