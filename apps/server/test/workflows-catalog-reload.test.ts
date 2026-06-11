// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import "./test-setup.ts";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { WorkflowDefinition } from "@keelson/workflows";
import { bootstrapWorkflows } from "../src/bootstrap.ts";

let wfDir: string;

beforeEach(() => {
  wfDir = mkdtempSync(join(tmpdir(), "keelson-catalog-reload-"));
});

afterEach(() => {
  rmSync(wfDir, { recursive: true, force: true });
});

function writeWorkflow(filename: string, body: string): void {
  writeFileSync(join(wfDir, filename), body);
}

function workflow(name: string, description: string, echo: string): string {
  return `name: ${name}\ndescription: ${description}\nnodes:\n  - id: step\n    bash: echo ${echo}\n`;
}

describe("bootstrapWorkflows re-scan", () => {
  test("reflects YAML edits on the next access without rebuilding the catalog", () => {
    writeWorkflow("alpha.yaml", workflow("alpha", "original", "original"));
    const catalog = bootstrapWorkflows({ workflowDir: wfDir });

    expect(catalog.get("alpha")?.description).toBe("original");

    writeWorkflow("alpha.yaml", workflow("alpha", "edited-and-clearly-longer", "edited"));

    expect(catalog.get("alpha")?.description).toBe("edited-and-clearly-longer");
  });

  test("serves a cached definition (no re-parse) while the dir is unchanged", () => {
    writeWorkflow("alpha.yaml", workflow("alpha", "original", "original"));
    const catalog = bootstrapWorkflows({ workflowDir: wfDir });

    const first = catalog.get("alpha");
    const second = catalog.get("alpha");
    // Same object identity proves the unchanged fingerprint short-circuited
    // re-parsing; an edit (next assertion) yields a fresh object.
    expect(first).toBe(second);

    writeWorkflow("alpha.yaml", workflow("alpha", "edited-and-clearly-longer", "edited"));
    expect(catalog.get("alpha")).not.toBe(first);
  });

  test("picks up an added workflow file", () => {
    writeWorkflow("alpha.yaml", workflow("alpha", "first", "first"));
    const catalog = bootstrapWorkflows({ workflowDir: wfDir });
    expect(catalog.list().map((w) => w.name)).toEqual(["alpha"]);

    writeWorkflow("beta.yaml", workflow("beta", "second", "second"));
    expect(
      catalog
        .list()
        .map((w) => w.name)
        .sort(),
    ).toEqual(["alpha", "beta"]);
    expect(catalog.get("beta")?.description).toBe("second");
  });

  test("drops a removed workflow file", () => {
    writeWorkflow("alpha.yaml", workflow("alpha", "first", "first"));
    writeWorkflow("beta.yaml", workflow("beta", "second", "second"));
    const catalog = bootstrapWorkflows({ workflowDir: wfDir });
    expect(
      catalog
        .list()
        .map((w) => w.name)
        .sort(),
    ).toEqual(["alpha", "beta"]);

    unlinkSync(join(wfDir, "beta.yaml"));
    expect(catalog.list().map((w) => w.name)).toEqual(["alpha"]);
    expect(catalog.get("beta")).toBeUndefined();
  });

  test("re-parses after a broken file is fixed", () => {
    writeWorkflow("alpha.yaml", "name: alpha\nnodes: not-a-list\n");
    const catalog = bootstrapWorkflows({ workflowDir: wfDir });
    expect(catalog.get("alpha")).toBeUndefined();
    expect(catalog.discoveryNotices().some((n) => n.filename.endsWith("alpha.yaml"))).toBe(true);

    writeWorkflow("alpha.yaml", workflow("alpha", "fixed", "fixed"));
    expect(catalog.get("alpha")?.description).toBe("fixed");
    expect(catalog.discoveryNotices()).toHaveLength(0);
  });

  test("returns an empty catalog without throwing when the dir is missing", () => {
    const catalog = bootstrapWorkflows({ workflowDir: join(wfDir, "does-not-exist") });
    expect(catalog.list()).toEqual([]);
    expect(catalog.get("anything")).toBeUndefined();
    // A missing dir is not an unreadable dir — no read_error notice.
    expect(catalog.discoveryNotices()).toHaveLength(0);
  });

  test("re-scans to an empty catalog when the last workflow is removed", () => {
    writeWorkflow("alpha.yaml", workflow("alpha", "only", "only"));
    const catalog = bootstrapWorkflows({ workflowDir: wfDir });
    expect(catalog.list().map((w) => w.name)).toEqual(["alpha"]);

    unlinkSync(join(wfDir, "alpha.yaml"));
    expect(catalog.list()).toEqual([]);
    expect(catalog.get("alpha")).toBeUndefined();
  });
});

describe("bootstrapWorkflows project scoping", () => {
  let projectRoot: string;

  function writeProjectWorkflow(filename: string, body: string): void {
    const file = join(projectRoot, ".keelson", "workflows", filename);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
  }

  function project(id: string, name: string, rootPath: string = projectRoot) {
    return { id, name, rootPath };
  }

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "keelson-project-root-"));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  test("a project workflow is visible only under that project's scope", () => {
    writeWorkflow("alpha.yaml", workflow("alpha", "global", "global"));
    writeProjectWorkflow("beta.yaml", workflow("beta", "project-only", "beta"));
    const catalog = bootstrapWorkflows({
      workflowDir: wfDir,
      listProjects: () => [project("p1", "demo")],
    });

    expect(catalog.list().map((w) => w.name)).toEqual(["alpha"]);
    expect(catalog.get("beta")).toBeUndefined();
    expect(
      catalog
        .list({ projectId: "p1" })
        .map((w) => w.name)
        .sort(),
    ).toEqual(["alpha", "beta"]);
    expect(catalog.get("beta", { projectId: "p1" })?.description).toBe("project-only");
    expect(catalog.provenance("beta", { projectId: "p1" }).source).toEqual({
      kind: "project",
      projectId: "p1",
      projectName: "demo",
    });
  });

  test("a project workflow shadows a same-named global one in scope only", () => {
    writeWorkflow("alpha.yaml", workflow("alpha", "global-copy", "global"));
    writeProjectWorkflow("alpha.yaml", workflow("alpha", "project-copy", "project"));
    const catalog = bootstrapWorkflows({
      workflowDir: wfDir,
      listProjects: () => [project("p1", "demo")],
    });

    expect(catalog.get("alpha")?.description).toBe("global-copy");
    expect(catalog.get("alpha", { projectId: "p1" })?.description).toBe("project-copy");
    expect(catalog.provenance("alpha").source.kind).toBe("local");
    expect(catalog.provenance("alpha", { projectId: "p1" }).source.kind).toBe("project");
    // The overlay replaces, not duplicates.
    expect(catalog.list({ projectId: "p1" }).filter((w) => w.name === "alpha")).toHaveLength(1);
  });

  test("an unknown projectId falls back to the global view", () => {
    writeWorkflow("alpha.yaml", workflow("alpha", "global", "global"));
    writeProjectWorkflow("beta.yaml", workflow("beta", "project", "beta"));
    const catalog = bootstrapWorkflows({
      workflowDir: wfDir,
      listProjects: () => [project("p1", "demo")],
    });
    expect(catalog.list({ projectId: "nope" }).map((w) => w.name)).toEqual(["alpha"]);
  });

  test("project add, remove, and rename land on the next access without a rebootstrap", () => {
    writeWorkflow("alpha.yaml", workflow("alpha", "global", "global"));
    writeProjectWorkflow("beta.yaml", workflow("beta", "project", "beta"));
    const projects: Array<{ id: string; name: string; rootPath: string }> = [];
    const catalog = bootstrapWorkflows({ workflowDir: wfDir, listProjects: () => projects });

    expect(catalog.list({ projectId: "p1" }).map((w) => w.name)).toEqual(["alpha"]);

    projects.push(project("p1", "demo"));
    expect(catalog.get("beta", { projectId: "p1" })?.description).toBe("project");

    projects[0] = project("p1", "renamed");
    expect(catalog.provenance("beta", { projectId: "p1" }).source).toMatchObject({
      projectName: "renamed",
    });

    projects.length = 0;
    expect(catalog.get("beta", { projectId: "p1" })).toBeUndefined();
  });

  test("skips a project whose workflows dir is the global dir (dev repo registered as project)", () => {
    writeWorkflow("alpha.yaml", workflow("alpha", "global", "global"));
    // wfDir plays the role of <root>/.keelson/workflows for this project.
    const devRoot = dirname(dirname(wfDir));
    const catalog = bootstrapWorkflows({
      workflowDir: wfDir,
      listProjects: () => [{ id: "p1", name: "dev", rootPath: devRoot }],
    });
    const scoped = catalog.list({ projectId: "p1" });
    expect(scoped.filter((w) => w.name === "alpha")).toHaveLength(1);
    expect(catalog.provenance("alpha", { projectId: "p1" }).source.kind).toBe("local");
  });

  test("rib definitions keep object identity across re-scans and are shadowed per scope", () => {
    const ribWorkflow: WorkflowDefinition = {
      name: "rib-flow",
      description: "from a rib",
      nodes: [{ id: "step", bash: "echo rib" }],
    } as WorkflowDefinition;
    writeProjectWorkflow("rib-flow.yaml", workflow("rib-flow", "project-copy", "project"));
    const catalog = bootstrapWorkflows({
      workflowDir: wfDir,
      listProjects: () => [project("p1", "demo")],
      extra: [ribWorkflow],
    });

    // Unscoped: the rib definition itself, by reference (snapshot bindings
    // are keyed on object identity).
    expect(catalog.get("rib-flow")).toBe(ribWorkflow);
    // Force a re-scan and confirm identity survives.
    writeWorkflow("other.yaml", workflow("other", "new file", "other"));
    expect(catalog.get("rib-flow")).toBe(ribWorkflow);
    // In project scope the project copy wins.
    expect(catalog.get("rib-flow", { projectId: "p1" })?.description).toBe("project-copy");
    expect(catalog.provenance("rib-flow", { projectId: "p1" }).source.kind).toBe("project");
  });

  test("getWithSource returns the backing file for file-backed entries only", () => {
    const ribWorkflow: WorkflowDefinition = {
      name: "rib-flow",
      description: "from a rib",
      nodes: [{ id: "step", bash: "echo rib" }],
    } as WorkflowDefinition;
    writeWorkflow("alpha.yaml", workflow("alpha", "global", "global"));
    writeProjectWorkflow("beta.yaml", workflow("beta", "project", "beta"));
    const catalog = bootstrapWorkflows({
      workflowDir: wfDir,
      listProjects: () => [project("p1", "demo")],
      extra: [ribWorkflow],
    });

    expect(catalog.getWithSource("alpha")?.path).toBe(join(wfDir, "alpha.yaml"));
    expect(catalog.getWithSource("alpha")?.source).toBe("global");
    expect(catalog.getWithSource("beta", { projectId: "p1" })?.path).toBe(
      join(projectRoot, ".keelson", "workflows", "beta.yaml"),
    );
    expect(catalog.getWithSource("beta", { projectId: "p1" })?.source).toBe("project");
    expect(catalog.getWithSource("beta")).toBeUndefined();
    expect(catalog.getWithSource("rib-flow")).toBeUndefined();
  });

  test("project-dir notices surface only under that project's scope", () => {
    writeProjectWorkflow("broken.yaml", "name: broken\nnodes: not-a-list\n");
    const catalog = bootstrapWorkflows({
      workflowDir: wfDir,
      listProjects: () => [project("p1", "demo")],
    });

    expect(catalog.discoveryNotices()).toHaveLength(0);
    const scoped = catalog.discoveryNotices({ projectId: "p1" });
    expect(scoped.some((n) => n.filename.endsWith("broken.yaml"))).toBe(true);
  });
});
