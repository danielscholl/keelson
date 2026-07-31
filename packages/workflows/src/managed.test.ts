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

import { readManagedManifest, sha256, writeManagedManifest } from "./managed.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "keelson-managed-"));
}

describe("readManagedManifest", () => {
  test("returns an empty manifest when no file exists", () => {
    const dir = tmpDir();
    expect(readManagedManifest(dir)).toEqual({});
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Reading damaged content as empty would let the next write replace it with
  // only the current bundle, discarding the provenance that makes a retired
  // overlay recognizable. Throwing keeps the file — and the caller reports it.
  test.each([
    ["truncated JSON", "{"],
    ["a JSON array", "[]"],
    ["a JSON scalar", '"nope"'],
    ["null", "null"],
    ["a non-digest value", '{"a.yaml":"not-a-sha"}'],
    ["a non-string value", '{"a.yaml":42}'],
  ])("throws rather than reporting %s as empty", (_label: string, raw: string) => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, ".managed.json"), raw);
    expect(() => readManagedManifest(dir)).toThrow();
    expect(fs.existsSync(path.join(dir, ".managed.json"))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("round-trips a written manifest", () => {
    const dir = tmpDir();
    const manifest = { "b.yaml": sha256("b\n"), "a.yaml": sha256("a\n") };
    writeManagedManifest(dir, manifest);

    expect(readManagedManifest(dir)).toEqual(manifest);
    expect(
      Object.keys(JSON.parse(fs.readFileSync(path.join(dir, ".managed.json"), "utf8"))),
    ).toEqual(["a.yaml", "b.yaml"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
