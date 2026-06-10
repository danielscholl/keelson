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

import { isWorkflowYaml, seedStarterAssets, seedStarterWorkflows } from "./seed.ts";

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

// A bundle root with the three starter-asset dirs populated, mirroring how
// build-release.ts stages them next to the cli bundle.
function makeBundle(): string {
  const root = tmpDir();
  for (const [kind, name] of [
    ["workflows", "smoke-test.yaml"],
    ["commands", "e2e-echo-command.md"],
    ["scripts", "echo-args.js"],
  ]) {
    fs.mkdirSync(path.join(root, kind));
    fs.writeFileSync(path.join(root, kind, name), `// ${name}\n`);
  }
  return root;
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

describe("seedStarterAssets", () => {
  test("seeds workflows, commands, and scripts into a fresh home", () => {
    const bundle = makeBundle();
    const home = path.join(tmpDir(), "home");

    const seeded = seedStarterAssets(home, path.join(home, "workflows"), bundle);

    expect(seeded).toEqual({
      workflows: ["smoke-test.yaml"],
      commands: ["e2e-echo-command.md"],
      scripts: ["echo-args.js"],
    });
    expect(fs.readdirSync(path.join(home, "workflows"))).toEqual(["smoke-test.yaml"]);
    expect(fs.readdirSync(path.join(home, "commands"))).toEqual(["e2e-echo-command.md"]);
    expect(fs.readdirSync(path.join(home, "scripts"))).toEqual(["echo-args.js"]);
  });

  test("honors a workflowsDir override while commands/scripts stay under home", () => {
    const bundle = makeBundle();
    const home = path.join(tmpDir(), "home");
    const customWorkflows = path.join(tmpDir(), "elsewhere");

    seedStarterAssets(home, customWorkflows, bundle);

    expect(fs.existsSync(path.join(customWorkflows, "smoke-test.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(home, "workflows"))).toBe(false);
    expect(fs.existsSync(path.join(home, "commands", "e2e-echo-command.md"))).toBe(true);
    expect(fs.existsSync(path.join(home, "scripts", "echo-args.js"))).toBe(true);
  });

  test("skips a populated kind without affecting the others", () => {
    const bundle = makeBundle();
    const home = path.join(tmpDir(), "home");
    fs.mkdirSync(path.join(home, "commands"), { recursive: true });
    fs.writeFileSync(path.join(home, "commands", "mine.md"), "# mine\n");

    const seeded = seedStarterAssets(home, path.join(home, "workflows"), bundle);

    expect(seeded.commands).toEqual([]);
    expect(fs.readdirSync(path.join(home, "commands"))).toEqual(["mine.md"]);
    expect(seeded.workflows).toEqual(["smoke-test.yaml"]);
    expect(seeded.scripts).toEqual(["echo-args.js"]);
  });

  test("no-ops cleanly when the bundle root has no asset dirs", () => {
    const home = path.join(tmpDir(), "home");

    const seeded = seedStarterAssets(
      home,
      path.join(home, "workflows"),
      path.join(tmpDir(), "empty"),
    );

    expect(seeded).toEqual({ workflows: [], commands: [], scripts: [] });
    expect(fs.existsSync(path.join(home, "workflows"))).toBe(false);
  });
});
