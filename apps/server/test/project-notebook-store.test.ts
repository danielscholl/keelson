// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db/init.ts";
import { createProjectNotebookStore } from "../src/project-notebook-store.ts";
import { createProjectsStore } from "../src/projects-store.ts";

function setup() {
  const db = openDatabase({ path: ":memory:" });
  const projects = createProjectsStore(db);
  const notebooks = createProjectNotebookStore(db);
  const project = projects.create({ name: "p", rootPath: "/tmp/p" });
  return { projects, notebooks, project };
}

describe("project notebook store", () => {
  test("get returns undefined before any upsert", () => {
    const { notebooks, project } = setup();
    expect(notebooks.get(project.id)).toBeUndefined();
  });

  test("upsert creates content that get returns", () => {
    const { notebooks, project } = setup();
    const saved = notebooks.upsert(project.id, "## Gotchas\n- cwd defaults to ~/keelson");
    expect(saved.projectId).toBe(project.id);
    expect(notebooks.get(project.id)?.content).toBe("## Gotchas\n- cwd defaults to ~/keelson");
  });

  test("upsert overwrites existing content", () => {
    const { notebooks, project } = setup();
    notebooks.upsert(project.id, "first");
    notebooks.upsert(project.id, "second");
    expect(notebooks.get(project.id)?.content).toBe("second");
  });

  test("notebook is removed when its project is deleted (cascade)", () => {
    const { projects, notebooks, project } = setup();
    notebooks.upsert(project.id, "x");
    projects.delete(project.id);
    expect(notebooks.get(project.id)).toBeUndefined();
  });
});
