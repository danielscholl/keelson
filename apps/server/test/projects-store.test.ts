// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import "./test-setup.ts";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/init.ts";
import {
  createProjectsStore,
  DuplicateProjectNameError,
  isPathInside,
} from "../src/projects-store.ts";
import { rmTemp } from "./temp.ts";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keelson-projects-store-"));
  dbPath = join(tmpDir, "test.db");
});

afterEach(() => {
  rmTemp(tmpDir);
});

describe("ProjectsStore", () => {
  test("create then list returns the new project", () => {
    const db = openDatabase({ path: dbPath });
    const store = createProjectsStore(db);
    const created = store.create({ name: "work-mono", rootPath: "/tmp/work" });
    expect(created.id.length).toBeGreaterThan(0);
    expect(created.name).toBe("work-mono");
    expect(created.rootPath).toBe("/tmp/work");

    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual(created);
  });

  test("create rejects duplicate names with DuplicateProjectNameError", () => {
    const db = openDatabase({ path: dbPath });
    const store = createProjectsStore(db);
    store.create({ name: "work", rootPath: "/tmp/a" });
    expect(() => store.create({ name: "work", rootPath: "/tmp/b" })).toThrow(
      DuplicateProjectNameError,
    );
  });

  test("get returns the project by id; getByName by name", () => {
    const db = openDatabase({ path: dbPath });
    const store = createProjectsStore(db);
    const p = store.create({ name: "alpha", rootPath: "/tmp/alpha" });
    expect(store.get(p.id)?.name).toBe("alpha");
    expect(store.getByName("alpha")?.id).toBe(p.id);
    expect(store.get("missing")).toBeUndefined();
    expect(store.getByName("missing")).toBeUndefined();
  });

  test("delete removes the project and returns false on second delete", () => {
    const db = openDatabase({ path: dbPath });
    const store = createProjectsStore(db);
    const p = store.create({ name: "ephemeral", rootPath: "/tmp/e" });
    expect(store.delete(p.id)).toBe(true);
    expect(store.delete(p.id)).toBe(false);
    expect(store.list()).toHaveLength(0);
  });

  test("list orders by name ASC", () => {
    const db = openDatabase({ path: dbPath });
    const store = createProjectsStore(db);
    store.create({ name: "charlie", rootPath: "/tmp/c" });
    store.create({ name: "alpha", rootPath: "/tmp/a" });
    store.create({ name: "bravo", rootPath: "/tmp/b" });
    const list = store.list();
    expect(list.map((p) => p.name)).toEqual(["alpha", "bravo", "charlie"]);
  });

  test("update changes name in place", () => {
    const db = openDatabase({ path: dbPath });
    const store = createProjectsStore(db);
    const p = store.create({ name: "before", rootPath: "/tmp/p" });
    const after = store.update(p.id, { name: "after" });
    expect(after?.name).toBe("after");
    expect(store.get(p.id)?.name).toBe("after");
    expect(store.getByName("before")).toBeUndefined();
    expect(store.getByName("after")?.id).toBe(p.id);
  });

  test("update rejects rename to a name already in use", () => {
    const db = openDatabase({ path: dbPath });
    const store = createProjectsStore(db);
    store.create({ name: "taken", rootPath: "/tmp/a" });
    const other = store.create({ name: "other", rootPath: "/tmp/b" });
    expect(() => store.update(other.id, { name: "taken" })).toThrow(DuplicateProjectNameError);
  });

  test("findByPathPrefix returns the longest-prefix match", () => {
    const db = openDatabase({ path: dbPath });
    const store = createProjectsStore(db);
    const outer = store.create({ name: "outer", rootPath: "/tmp/work" });
    const inner = store.create({ name: "inner", rootPath: "/tmp/work/repo" });
    expect(store.findByPathPrefix("/tmp/work/repo/src/a.ts")?.id).toBe(inner.id);
    expect(store.findByPathPrefix("/tmp/work/other/file")?.id).toBe(outer.id);
    expect(store.findByPathPrefix("/elsewhere/x")).toBeUndefined();
  });

  test("findByPathPrefix does not false-match sibling prefixes", () => {
    const db = openDatabase({ path: dbPath });
    const store = createProjectsStore(db);
    store.create({ name: "ab", rootPath: "/tmp/ab" });
    expect(store.findByPathPrefix("/tmp/abc")).toBeUndefined();
    expect(store.findByPathPrefix("/tmp/ab")?.name).toBe("ab");
    expect(store.findByPathPrefix("/tmp/ab/")?.name).toBe("ab");
    expect(store.findByPathPrefix("/tmp/ab/x")?.name).toBe("ab");
  });
});

describe("isPathInside", () => {
  test("equal paths and subdirectories are inside; siblings are not", () => {
    expect(isPathInside("/tmp/work", "/tmp/work")).toBe(true);
    expect(isPathInside("/tmp/work", "/tmp/work/repo/a.ts")).toBe(true);
    expect(isPathInside("/tmp/work", "/tmp/work/")).toBe(true);
    expect(isPathInside("/tmp/work", "/tmp/workshop")).toBe(false);
    expect(isPathInside("/tmp/work", "/tmp")).toBe(false);
  });

  test("a project rooted at the filesystem root contains every absolute path", () => {
    expect(isPathInside("/", "/")).toBe(true);
    expect(isPathInside("/", "/repo")).toBe(true);
    expect(isPathInside("/", "/repo/src/a.ts")).toBe(true);
  });
});
