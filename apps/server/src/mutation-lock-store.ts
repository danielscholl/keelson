// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

export interface MutationLockRecord {
  id: string;
  projectId: string;
  purpose: string;
  owner: string;
  acquiredAt: string;
}

export interface MutationLockStore {
  list(): MutationLockRecord[];
  getByProject(projectId: string): MutationLockRecord | undefined;
  get(id: string): MutationLockRecord | undefined;
  insert(record: MutationLockRecord): void;
  delete(id: string): boolean;
  clear(): number;
}

function copyRecord(record: MutationLockRecord): MutationLockRecord {
  return { ...record };
}

export function createMutationLockStore(): MutationLockStore {
  const locks = new Map<string, MutationLockRecord>();

  return {
    list() {
      return Array.from(locks.values())
        .map(copyRecord)
        .sort((a, b) => b.acquiredAt.localeCompare(a.acquiredAt) || a.id.localeCompare(b.id));
    },
    getByProject(projectId) {
      const record = locks.get(projectId);
      return record ? copyRecord(record) : undefined;
    },
    get(id) {
      for (const record of locks.values()) {
        if (record.id === id) {
          return copyRecord(record);
        }
      }
      return undefined;
    },
    insert(record) {
      if (locks.has(record.projectId)) {
        throw new Error(`project ${record.projectId} already has a mutation lock`);
      }
      locks.set(record.projectId, copyRecord(record));
    },
    delete(id) {
      for (const [projectId, record] of locks) {
        if (record.id === id) {
          return locks.delete(projectId);
        }
      }
      return false;
    },
    clear() {
      const count = locks.size;
      locks.clear();
      return count;
    },
  };
}
