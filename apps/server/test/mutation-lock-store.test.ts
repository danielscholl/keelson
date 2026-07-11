// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import "./test-setup.ts";

import { describe, expect, test } from "bun:test";
import {
  createMutationLockStore,
  type MutationLockRecord,
} from "../src/mutation-lock-store.ts";

function lock(overrides: Partial<MutationLockRecord> = {}): MutationLockRecord {
  return {
    id: "lock-1",
    projectId: "project-1",
    purpose: "fix-issue",
    owner: "workflow:abc12345",
    acquiredAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("MutationLockStore", () => {
  test("insert, get, list, getByProject, and delete round-trip a lock", () => {
    const store = createMutationLockStore();
    const record = lock();

    store.insert(record);

    expect(store.get(record.id)).toEqual(record);
    expect(store.getByProject(record.projectId)).toEqual(record);
    expect(store.list()).toEqual([record]);
    expect(store.delete(record.id)).toBe(true);
    expect(store.delete(record.id)).toBe(false);
    expect(store.get(record.id)).toBeUndefined();
    expect(store.getByProject(record.projectId)).toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  test("single-holder project constraint throws on a second insert", () => {
    const store = createMutationLockStore();

    store.insert(lock({ id: "lock-a" }));

    expect(() => store.insert(lock({ id: "lock-b" }))).toThrow(
      "project project-1 already has a mutation lock",
    );
  });

  test("clear returns the count and empties the store", () => {
    const store = createMutationLockStore();
    store.insert(lock({ id: "lock-a", projectId: "project-a" }));
    store.insert(lock({ id: "lock-b", projectId: "project-b" }));

    expect(store.clear()).toBe(2);
    expect(store.list()).toEqual([]);
    expect(store.clear()).toBe(0);
  });
});
