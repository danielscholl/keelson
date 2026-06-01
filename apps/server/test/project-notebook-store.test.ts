// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db/init.ts";
import {
  appendEntryToSection,
  createProjectNotebookStore,
  DEFAULT_NOTEBOOK_SECTION,
  injectionView,
  NOTEBOOK_CONTENT_LIMIT,
  NOTEBOOK_INJECTION_BUDGET,
  tidyNotebook,
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

describe("injectionView", () => {
  test("returns the whole doc (normalized) when there is no archive", () => {
    expect(injectionView("## Log\n- a\n- b\n")).toBe("## Log\n- a\n- b");
  });

  test("strips a trailing ## Archive section", () => {
    const doc = "## Log\n- recent\n\n## Archive\n- old1\n- old2\n";
    expect(injectionView(doc)).toBe("## Log\n- recent");
  });

  test("strips an ## Archive section that precedes another section", () => {
    const doc = "## Archive\n- old\n\n## Log\n- recent\n";
    expect(injectionView(doc)).toBe("## Log\n- recent");
  });

  test("empty content yields an empty view", () => {
    expect(injectionView("")).toBe("");
  });
});

describe("tidyNotebook", () => {
  test("within-budget notebook is returned unchanged", () => {
    const doc = "## Log\n- 2026-01-01: a\n";
    expect(tidyNotebook(doc, { budget: 1000, minRecent: 1 })).toEqual({
      content: doc,
      archivedCount: 0,
    });
  });

  test("moves the oldest bullet under ## Archive with a clean seam", () => {
    const doc = "## Log\n- 2026-01-01: a\n- 2026-01-02: b\n";
    const { content, archivedCount } = tidyNotebook(doc, { budget: 20, minRecent: 1 });
    expect(archivedCount).toBe(1);
    expect(content).toBe("## Log\n- 2026-01-02: b\n\n## Archive\n- 2026-01-01: a\n");
  });

  test("appends to an existing ## Archive, keeping it chronological", () => {
    const doc =
      "## Log\n- 2026-02-01: new\n- 2026-02-02: newer\n\n## Archive\n- 2026-01-01: ancient\n";
    const { content, archivedCount } = tidyNotebook(doc, { budget: 25, minRecent: 1 });
    expect(archivedCount).toBeGreaterThanOrEqual(1);
    expect(content.match(/^## Archive$/gm)?.length).toBe(1);
    const ancientIdx = content.indexOf("ancient");
    const newIdx = content.indexOf("2026-02-01: new");
    expect(ancientIdx).toBeGreaterThan(content.indexOf("## Archive"));
    expect(newIdx).toBeGreaterThan(ancientIdx);
  });

  test("keeps the recent floor even when curated sections exceed the budget", () => {
    const doc = `## Conventions\n- ${"x".repeat(100)}\n\n## Log\n- 2026-03-01: a\n- 2026-03-02: b\n- 2026-03-03: c\n`;
    const { content, archivedCount } = tidyNotebook(doc, { budget: 10, minRecent: 2 });
    expect(archivedCount).toBe(1);
    const view = injectionView(content);
    expect(view).toContain("2026-03-02: b");
    expect(view).toContain("2026-03-03: c");
    expect(view).not.toContain("2026-03-01: a");
    expect(content).toContain("## Conventions");
    expect(content).toContain("## Archive");
  });

  test("no ## Log section → no-op even when over budget", () => {
    const doc = `## Conventions\n- ${"x".repeat(100)}\n`;
    expect(tidyNotebook(doc, { budget: 10, minRecent: 1 })).toEqual({
      content: doc,
      archivedCount: 0,
    });
  });

  test("running tidy twice is a no-op the second time", () => {
    const opts = { budget: 20, minRecent: 1 };
    const doc = "## Log\n- 2026-01-01: a\n- 2026-01-02: b\n";
    const once = tidyNotebook(doc, opts);
    const twice = tidyNotebook(once.content, opts);
    expect(twice.archivedCount).toBe(0);
    expect(twice.content).toBe(once.content);
  });

  test("preserves content from every existing ## Archive section", () => {
    const doc =
      "## Log\n- 2026-03-01: a\n- 2026-03-02: b\n\n## Archive\n- old1\n\n## Notes\n- keep\n\n## Archive\n- old2\n";
    const { content, archivedCount } = tidyNotebook(doc, { budget: 15, minRecent: 1 });
    expect(archivedCount).toBeGreaterThanOrEqual(1);
    expect(content).toContain("old1");
    expect(content).toContain("old2");
    expect(content).toContain("## Notes\n- keep");
    expect(content.match(/^## Archive$/gm)?.length).toBe(1);
  });

  test("archives a multi-line log entry as a whole block, counting it as one entry", () => {
    const doc = "## Log\n- 2026-03-01: title\n  detail line\n  more detail\n- 2026-03-02: recent\n";
    const { content, archivedCount } = tidyNotebook(doc, { budget: 20, minRecent: 1 });
    expect(archivedCount).toBe(1);
    const view = injectionView(content);
    expect(view).not.toContain("title");
    expect(view).not.toContain("detail line");
    expect(view).not.toContain("more detail");
    expect(content).toContain("- 2026-03-01: title\n  detail line\n  more detail");
    expect(view).toContain("2026-03-02: recent");
  });
});

describe("project notebook store — tidy", () => {
  test("archives oldest log entries, returns previousContent + archivedCount, and persists", () => {
    const { notebooks, project } = setup();
    const body = Array.from(
      { length: 50 },
      (_, i) => `- 2026-06-${String(i + 1).padStart(2, "0")}: ${"y".repeat(200)}`,
    ).join("\n");
    const big = `## Log\n${body}\n`;
    notebooks.upsert(project.id, big);

    const res = notebooks.tidy(project.id);
    expect(res.archivedCount).toBeGreaterThan(0);
    expect(res.previousContent).toBe(big);
    expect(res.notebook.content).toContain("## Archive");
    expect(injectionView(res.notebook.content).length).toBeLessThanOrEqual(
      NOTEBOOK_INJECTION_BUDGET,
    );
    expect(notebooks.get(project.id)?.content).toBe(res.notebook.content);
  });

  test("within-budget notebook is left unchanged with archivedCount 0", () => {
    const { notebooks, project } = setup();
    notebooks.upsert(project.id, "## Log\n- 2026-06-01: small\n");
    const res = notebooks.tidy(project.id);
    expect(res.archivedCount).toBe(0);
    expect(res.notebook.content).toBe("## Log\n- 2026-06-01: small\n");
  });
});
