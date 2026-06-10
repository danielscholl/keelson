// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
// biome-ignore lint/suspicious/noTsIgnore: Bun bundles Node built-ins at runtime.
// @ts-ignore
import * as fs from "node:fs";
// biome-ignore lint/suspicious/noTsIgnore: Bun bundles Node built-ins at runtime.
// @ts-ignore
import * as os from "node:os";
// biome-ignore lint/suspicious/noTsIgnore: Bun bundles Node built-ins at runtime.
// @ts-ignore
import * as path from "node:path";

import { isWorkflowYaml, seedStarterWorkflows } from "./seed.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "keelson-seed-"));
}

function makeSource(names: string[]): string {
  const dir = tmpDir();
  for (const name of names) {
    fs.writeFileSync(path.join(dir, name), `name: ${name}\n`);
  }
  return dir;
}

describe("seedStarterWorkflows", () => {
  test("seeds all YAMLs into a missing target dir", () => {
    const source = makeSource(["a.yaml", "b.yml"]);
    const target = path.join(tmpDir(), "workflows");

    const seeded = seedStarterWorkflows(target, source);

    expect(seeded).toEqual(["a.yaml", "b.yml"]);
    expect(fs.readdirSync(target).sort()).toEqual(["a.yaml", "b.yml"]);
    expect(fs.readFileSync(path.join(target, "a.yaml"), "utf8")).toBe("name: a.yaml\n");
  });

  test("seeds into an existing dir that holds no YAML", () => {
    const source = makeSource(["a.yaml"]);
    const target = tmpDir();
    fs.writeFileSync(path.join(target, "notes.txt"), "keep");

    expect(seedStarterWorkflows(target, source)).toEqual(["a.yaml"]);
    expect(fs.existsSync(path.join(target, "a.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(target, "notes.txt"))).toBe(true);
  });

  test("skips a target that already holds YAML — never resurrects starters", () => {
    const source = makeSource(["a.yaml", "b.yaml"]);
    const target = tmpDir();
    fs.writeFileSync(path.join(target, "mine.yaml"), "name: mine\n");

    expect(seedStarterWorkflows(target, source)).toEqual([]);
    expect(fs.readdirSync(target)).toEqual(["mine.yaml"]);
  });

  test("skips when the source dir does not exist", () => {
    const target = path.join(tmpDir(), "workflows");

    expect(seedStarterWorkflows(target, path.join(tmpDir(), "missing"))).toEqual([]);
    expect(fs.existsSync(target)).toBe(false);
  });

  test("skips when source and target are the same dir", () => {
    const dir = makeSource(["a.yaml"]);

    expect(seedStarterWorkflows(dir, dir)).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual(["a.yaml"]);
  });

  test("copies only YAML files from the source", () => {
    const source = makeSource(["a.yaml"]);
    fs.writeFileSync(path.join(source, "README.md"), "docs");
    const target = path.join(tmpDir(), "workflows");

    expect(seedStarterWorkflows(target, source)).toEqual(["a.yaml"]);
    expect(fs.readdirSync(target)).toEqual(["a.yaml"]);
  });

  test("a failed copy leaves the target retryable — no YAML, no staging litter", () => {
    const source = makeSource(["a.yaml"]);
    // A directory whose name matches isWorkflowYaml: copyFileSync(dir) throws
    // EISDIR mid-loop, standing in for a real failure (ENOSPC/EACCES/kill).
    fs.mkdirSync(path.join(source, "z.yaml"));
    const target = path.join(tmpDir(), "workflows");

    expect(() => seedStarterWorkflows(target, source)).toThrow();
    // No real workflow landed, so the next run is free to reseed the full set —
    // the "target holds YAML" guard never trips on a partial seed.
    const left = fs.readdirSync(target);
    expect(left.filter(isWorkflowYaml)).toEqual([]);
    expect(left.some((n) => n.endsWith(".seedtmp"))).toBe(false);
  });

  test("isWorkflowYaml matches .yaml/.yml only", () => {
    expect(isWorkflowYaml("a.yaml")).toBe(true);
    expect(isWorkflowYaml("a.yml")).toBe(true);
    expect(isWorkflowYaml("a.txt")).toBe(false);
    expect(isWorkflowYaml(".a.yaml.1234.seedtmp")).toBe(false);
  });
});
