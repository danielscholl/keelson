// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import "./test-setup.ts";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
