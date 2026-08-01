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
  mode: "exclusive" | "shared";
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
  const locks = new Map<string, MutationLockRecord[]>();

  return {
    list() {
      return Array.from(locks.values())
        .flat()
        .map(copyRecord)
        .sort((a, b) => b.acquiredAt.localeCompare(a.acquiredAt) || a.id.localeCompare(b.id));
    },
    getByProject(projectId) {
      const projectLocks = locks.get(projectId);
      const record =
        projectLocks?.find((candidate) => candidate.mode === "exclusive") ?? projectLocks?.[0];
      return record ? copyRecord(record) : undefined;
    },
    get(id) {
      for (const projectLocks of locks.values()) {
        const record = projectLocks.find((candidate) => candidate.id === id);
        if (record) {
          return copyRecord(record);
        }
      }
      return undefined;
    },
    insert(record) {
      const projectLocks = locks.get(record.projectId) ?? [];
      if (
        (record.mode === "exclusive" && projectLocks.length > 0) ||
        projectLocks.some((candidate) => candidate.mode === "exclusive")
      ) {
        throw new Error(`project ${record.projectId} already has a mutation lock`);
      }
      projectLocks.push(copyRecord(record));
      locks.set(record.projectId, projectLocks);
    },
    delete(id) {
      for (const [projectId, projectLocks] of locks) {
        const index = projectLocks.findIndex((record) => record.id === id);
        if (index !== -1) {
          projectLocks.splice(index, 1);
          if (projectLocks.length === 0) {
            locks.delete(projectId);
          }
          return true;
        }
      }
      return false;
    },
    clear() {
      const count = Array.from(locks.values()).reduce(
        (total, projectLocks) => total + projectLocks.length,
        0,
      );
      locks.clear();
      return count;
    },
  };
}
