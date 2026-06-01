// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db/init.ts";
import {
  appendEntryToSection,
  createProjectNotebookStore,
  DEFAULT_NOTEBOOK_SECTION,
  NOTEBOOK_CONTENT_LIMIT,
} from "../src/project-notebook-store.ts";
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

describe("appendEntryToSection", () => {
  const D = "2026-06-01";

  test("empty notebook creates the section", () => {
    expect(appendEntryToSection("", "Log", "first note", D)).toBe(
      "## Log\n- 2026-06-01: first note\n",
    );
  });

  test("absent section is appended at the end with a blank-line seam", () => {
    const out = appendEntryToSection("## Conventions\n- terse\n", "Log", "new", D);
    expect(out).toBe("## Conventions\n- terse\n\n## Log\n- 2026-06-01: new\n");
  });

  test("existing section gets the bullet before the next ## header", () => {
    const out = appendEntryToSection("## Log\n- old\n\n## Other\n- x\n", "Log", "new", D);
    expect(out).toBe("## Log\n- old\n- 2026-06-01: new\n\n## Other\n- x\n");
  });

  test("bullet lands at EOF when the section is the last block", () => {
    const out = appendEntryToSection("## Log\n- old\n", "Log", "new", D);
    expect(out).toBe("## Log\n- old\n- 2026-06-01: new\n");
  });

  test("deeper ### headers are content within the section, not a boundary", () => {
    const out = appendEntryToSection("## Log\n### Sub\n- a\n", "Log", "new", D);
    expect(out).toBe("## Log\n### Sub\n- a\n- 2026-06-01: new\n");
  });

  test("newlines in the entry are flattened to one bullet line", () => {
    const out = appendEntryToSection("", "Log", "line one\n  line two", D);
    expect(out).toBe("## Log\n- 2026-06-01: line one line two\n");
  });

  test("newlines in the section name are folded so no extra header is injected", () => {
    const out = appendEntryToSection("", "Log\n## Injected", "x", D);
    expect(out).toBe("## Log ## Injected\n- 2026-06-01: x\n");
  });

  test("strict H2 match — ## Logger does not absorb a Log append", () => {
    const out = appendEntryToSection("## Logger\n- a\n", "Log", "new", D);
    expect(out).toBe("## Logger\n- a\n\n## Log\n- 2026-06-01: new\n");
  });

  test("always ends with a single trailing newline", () => {
    expect(appendEntryToSection("## Log\n- a", "Log", "b", D).endsWith("\n")).toBe(true);
  });
});

describe("project notebook store — appendEntry", () => {
  test("defaults to the Log section and returns previousContent", () => {
    const { notebooks, project } = setup();
    notebooks.upsert(project.id, "## Conventions\n- terse\n");
    const result = notebooks.appendEntry(project.id, "a durable fact");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.previousContent).toBe("## Conventions\n- terse\n");
    expect(result.notebook.content).toContain(`## ${DEFAULT_NOTEBOOK_SECTION}`);
    expect(result.notebook.content).toContain("a durable fact");
    expect(notebooks.get(project.id)?.content).toBe(result.notebook.content);
  });

  test("routes to an explicit section", () => {
    const { notebooks, project } = setup();
    const result = notebooks.appendEntry(project.id, "two spaces over tabs", "Conventions");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.notebook.content).toContain("## Conventions");
  });

  test("over-limit append is rejected and leaves the notebook unchanged", () => {
    const { notebooks, project } = setup();
    const big = "x".repeat(NOTEBOOK_CONTENT_LIMIT);
    notebooks.upsert(project.id, big);
    const result = notebooks.appendEntry(project.id, "tips over the edge");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("notebook_full");
    expect(notebooks.get(project.id)?.content).toBe(big);
  });
});
