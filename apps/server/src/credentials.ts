// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { credentialServiceIdSchema } from "@keelson/shared";

export const KEYRING_SERVICE = "keelson" as const;

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
  const parsed = credentialServiceIdSchema.safeParse(serviceId);
  if (!parsed.success) {
    throw new Error(`invalid serviceId '${serviceId}'`);
  }
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
        throw new Error(
          `keyring get failed for '${serviceId}': ${(err as Error).message}`,
        );
      }
    },
    async set(serviceId, value) {
      assertServiceId(serviceId);
      const mod = await loadKeyring();
      try {
        const entry = new mod.Entry(KEYRING_SERVICE, serviceId);
        entry.setPassword(value);
      } catch (err) {
        throw new Error(
          `keyring set failed for '${serviceId}': ${(err as Error).message}`,
        );
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
        throw new Error(
          `keyring delete failed for '${serviceId}': ${(err as Error).message}`,
        );
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
export function setCredential(serviceId: string, value: string): Promise<void> {
  return defaultStore().set(serviceId, value);
}
export function deleteCredential(serviceId: string): Promise<boolean> {
  return defaultStore().delete(serviceId);
}
