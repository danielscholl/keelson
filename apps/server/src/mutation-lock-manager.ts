// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { MutationLockRecord, MutationLockStore } from "./mutation-lock-store.ts";

export class MutationLockConflictError extends Error {
  constructor(
    public readonly projectId: string,
    public readonly holderOwner: string,
    public readonly holderPurpose: string,
  ) {
    super(`project ${projectId} is locked by ${holderOwner} for "${holderPurpose}"`);
    this.name = "MutationLockConflictError";
  }
}

export interface AcquireMutationLockManagerRequest {
  projectId: string;
  purpose: string;
  owner: string;
}

export interface MutationLockHandle {
  id: string;
  release: () => void;
}

export type MutationLockSummary = MutationLockRecord;

export interface MutationLockManager {
  acquire(req: AcquireMutationLockManagerRequest): MutationLockHandle;
  release(id: string): void;
  list(): MutationLockSummary[];
  reconcile(): void;
}

export function mutationLockDisabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = env.KEELSON_DISABLE_MUTATION_LOCK?.trim();
  return (
    value !== undefined && value.length > 0 && value !== "0" && value.toLowerCase() !== "false"
  );
}

export function createMutationLockManager({
  store,
}: {
  store: MutationLockStore;
}): MutationLockManager {
  const manager: MutationLockManager = {
    acquire(req) {
      if (mutationLockDisabled()) {
        return { id: "disabled", release: () => {} };
      }

      const id = crypto.randomUUID();
      try {
        store.insert({
          id,
          projectId: req.projectId,
          purpose: req.purpose,
          owner: req.owner,
          acquiredAt: new Date().toISOString(),
        });
      } catch (err) {
        const holder = store.getByProject(req.projectId);
        if (holder) {
          throw new MutationLockConflictError(req.projectId, holder.owner, holder.purpose);
        }
        throw err;
      }

      return {
        id,
        release: () => manager.release(id),
      };
    },
    release(id) {
      store.delete(id);
    },
    list() {
      return store.list();
    },
    reconcile() {
      const count = store.clear();
      if (count > 0) {
        console.warn(`[mutation-lock] cleared ${count} stale lock(s) at boot`);
      }
    },
  };

  return manager;
}
