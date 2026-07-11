// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import "./test-setup.ts";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createMutationLockManager,
  MutationLockConflictError,
  mutationLockDisabled,
} from "../src/mutation-lock-manager.ts";
import { createMutationLockStore } from "../src/mutation-lock-store.ts";

let savedDisableMutationLock: string | undefined;

beforeEach(() => {
  savedDisableMutationLock = process.env.KEELSON_DISABLE_MUTATION_LOCK;
  delete process.env.KEELSON_DISABLE_MUTATION_LOCK;
});

afterEach(() => {
  if (savedDisableMutationLock === undefined) delete process.env.KEELSON_DISABLE_MUTATION_LOCK;
  else process.env.KEELSON_DISABLE_MUTATION_LOCK = savedDisableMutationLock;
});

describe("MutationLockManager", () => {
  test("acquire conflicts name the current holder and purpose", () => {
    const store = createMutationLockStore();
    const manager = createMutationLockManager({ store });
    manager.acquire({
      projectId: "project-1",
      purpose: "review",
      owner: "workflow:abc12345",
    });

    let thrown: unknown;
    try {
      manager.acquire({
        projectId: "project-1",
        purpose: "squad",
        owner: "workflow:def67890",
      });
    } catch (err) {
      thrown = err;
    }

    if (!(thrown instanceof MutationLockConflictError)) {
      throw new Error("expected MutationLockConflictError");
    }
    expect(thrown.projectId).toBe("project-1");
    expect(thrown.holderOwner).toBe("workflow:abc12345");
    expect(thrown.holderPurpose).toBe("review");
    expect(thrown.message).toBe('project project-1 is locked by workflow:abc12345 for "review"');
  });

  test("release frees a project so it can be acquired again", () => {
    const store = createMutationLockStore();
    const manager = createMutationLockManager({ store });
    const first = manager.acquire({
      projectId: "project-1",
      purpose: "review",
      owner: "workflow:abc12345",
    });

    first.release();
    const second = manager.acquire({
      projectId: "project-1",
      purpose: "squad",
      owner: "workflow:def67890",
    });

    expect(second.id).not.toBe(first.id);
    expect(manager.list()).toHaveLength(1);
    expect(manager.list()[0]?.owner).toBe("workflow:def67890");
  });

  test("different projects lock independently", () => {
    const store = createMutationLockStore();
    const manager = createMutationLockManager({ store });

    manager.acquire({ projectId: "project-a", purpose: "review", owner: "workflow:a" });
    manager.acquire({ projectId: "project-b", purpose: "review", owner: "workflow:b" });

    expect(manager.list().map((record) => record.projectId).sort()).toEqual([
      "project-a",
      "project-b",
    ]);
  });

  test("reconcile clears stale records and warns when non-empty", () => {
    const store = createMutationLockStore();
    const manager = createMutationLockManager({ store });
    store.insert({
      id: "stale-lock",
      projectId: "project-1",
      purpose: "review",
      owner: "workflow:abc12345",
      acquiredAt: "2026-01-01T00:00:00.000Z",
    });
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown, ...optionalParams: unknown[]) => {
      warnings.push([message, ...optionalParams].map(String).join(" "));
    };
    try {
      manager.reconcile();
    } finally {
      console.warn = originalWarn;
    }

    expect(manager.list()).toEqual([]);
    expect(warnings).toEqual(["[mutation-lock] cleared 1 stale lock(s) at boot"]);
  });

  test("escape hatch disables acquisition and writes no rows", () => {
    process.env.KEELSON_DISABLE_MUTATION_LOCK = "1";
    const store = createMutationLockStore();
    const manager = createMutationLockManager({ store });

    const first = manager.acquire({
      projectId: "project-1",
      purpose: "review",
      owner: "workflow:abc12345",
    });
    const second = manager.acquire({
      projectId: "project-1",
      purpose: "squad",
      owner: "workflow:def67890",
    });

    expect(first.id).toBe("disabled");
    expect(second.id).toBe("disabled");
    expect(manager.list()).toEqual([]);
    first.release();
    second.release();
  });

  test("mutationLockDisabled treats empty, zero, and false as disabled-off", () => {
    expect(mutationLockDisabled({})).toBe(false);
    expect(mutationLockDisabled({ KEELSON_DISABLE_MUTATION_LOCK: "" })).toBe(false);
    expect(mutationLockDisabled({ KEELSON_DISABLE_MUTATION_LOCK: "0" })).toBe(false);
    expect(mutationLockDisabled({ KEELSON_DISABLE_MUTATION_LOCK: "false" })).toBe(false);
    expect(mutationLockDisabled({ KEELSON_DISABLE_MUTATION_LOCK: "1" })).toBe(true);
  });
});
