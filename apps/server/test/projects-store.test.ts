// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import "./test-setup.ts";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/init.ts";
import { createProjectsStore, DuplicateProjectNameError } from "../src/projects-store.ts";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keelson-projects-store-"));
  dbPath = join(tmpDir, "test.db");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
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
});
