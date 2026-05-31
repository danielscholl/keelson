// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { credentialServiceIdSchema, ribIdSchema } from "@keelson/shared";
import { z } from "zod";

export const KEYRING_SERVICE = "keelson" as const;

// A rib's credentials are stored under a namespaced keyring account
// (`rib_<ribId>_<serviceId>`). The `_` separator can't appear in a kebab-case
// id, so the split is unambiguous — rib `osdu-prod` reading `token` and rib
// `osdu` reading `prod-token` resolve to distinct accounts, preserving per-rib
// isolation. The composed account can exceed the 64-char public service id
// ceiling, so it has its own (still traversal-safe) bound.
const ribCredentialAccountSchema = z
  .string()
  .min(1)
  .max(191)
  .regex(/^[a-z][a-z0-9_-]*$/);

// Interface kept Promise-returning so the underlying backend can be swapped
// for an async implementation later without changing call sites.
export interface CredentialStore {
  get(serviceId: string): Promise<string | undefined>;
  set(serviceId: string, value: string): Promise<void>;
  delete(serviceId: string): Promise<boolean>;
}

type KeyringModule = typeof import("@napi-rs/keyring");
let keyringMod: KeyringModule | null = null;
async function loadKeyring(): Promise<KeyringModule> {
  if (!keyringMod) keyringMod = await import("@napi-rs/keyring");
  return keyringMod;
}

function assertServiceId(serviceId: string): void {
  // Accept either a public service id or a namespaced rib account — widening
  // only; never rejects a value the public schema already accepted.
  if (credentialServiceIdSchema.safeParse(serviceId).success) return;
  if (ribCredentialAccountSchema.safeParse(serviceId).success) return;
  throw new Error(`invalid serviceId '${serviceId}'`);
}

// @napi-rs/keyring's NoEntry / NotFound errors come back as opaque `Error`
// instances with a message. Detect by message substring since the binding
// does not expose typed error codes.
function isNoEntryError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message.toLowerCase();
  return m.includes("no entry") || m.includes("not found");
}

export function createKeyringStore(): CredentialStore {
  return {
    async get(serviceId) {
      assertServiceId(serviceId);
      const mod = await loadKeyring();
      try {
        const entry = new mod.Entry(KEYRING_SERVICE, serviceId);
        const value = entry.getPassword();
        return value ?? undefined;
      } catch (err) {
        if (isNoEntryError(err)) return undefined;
        throw new Error(`keyring get failed for '${serviceId}': ${(err as Error).message}`);
      }
    },
    async set(serviceId, value) {
      assertServiceId(serviceId);
      const mod = await loadKeyring();
      try {
        const entry = new mod.Entry(KEYRING_SERVICE, serviceId);
        entry.setPassword(value);
      } catch (err) {
        throw new Error(`keyring set failed for '${serviceId}': ${(err as Error).message}`);
      }
    },
    async delete(serviceId) {
      assertServiceId(serviceId);
      const mod = await loadKeyring();
      try {
        const entry = new mod.Entry(KEYRING_SERVICE, serviceId);
        return entry.deleteCredential();
      } catch (err) {
        if (isNoEntryError(err)) return false;
        throw new Error(`keyring delete failed for '${serviceId}': ${(err as Error).message}`);
      }
    },
  };
}

// Process-singleton wrappers — for use by future F5 Copilot factory.
let singleton: CredentialStore | null = null;
function defaultStore(): CredentialStore {
  if (!singleton) singleton = createKeyringStore();
  return singleton;
}

export function getCredential(serviceId: string): Promise<string | undefined> {
  return defaultStore().get(serviceId);
}

// Build a read-only credential reader scoped to one rib's namespace. The rib
// passes a bare serviceId; the accessor resolves it under `rib_<ribId>_<serviceId>`
// so a rib reads only the secrets stored for it.
//
// Injectivity (no two distinct (ribId, serviceId) pairs share an account):
// both components are validated kebab-case — `^[a-z][a-z0-9-]*$`, which cannot
// contain `_` — so `_` is a delimiter that appears *only* between the three
// fixed parts. The explicit `_`-guards below make that property local rather
// than dependent on the shared schemas staying strict.
export function createRibCredentialAccessor(
  store: CredentialStore,
  ribId: string,
): (serviceId: string) => Promise<string | undefined> {
  ribIdSchema.parse(ribId);
  if (ribId.includes("_")) throw new Error(`rib id '${ribId}' must not contain '_'`);
  return (serviceId: string) => {
    if (!credentialServiceIdSchema.safeParse(serviceId).success || serviceId.includes("_")) {
      return Promise.reject(new Error(`invalid rib credential serviceId '${serviceId}'`));
    }
    return store.get(`rib_${ribId}_${serviceId}`);
  };
}
export function setCredential(serviceId: string, value: string): Promise<void> {
  return defaultStore().set(serviceId, value);
}
export function deleteCredential(serviceId: string): Promise<boolean> {
  return defaultStore().delete(serviceId);
}
