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

  // A manifest entry authorizes deleting the overlay file it names, so every
  // unreadable form must degrade to "not tracked" rather than to a stale hash.
  test.each([
    ["truncated JSON", "{"],
    ["a JSON array", "[]"],
    ["a JSON scalar", '"nope"'],
    ["null", "null"],
  ])("treats %s as an empty manifest", (_label: string, raw: string) => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, ".managed.json"), raw);
    expect(readManagedManifest(dir)).toEqual({});
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("drops entries whose value is not a sha256 digest, keeping valid siblings", () => {
    const dir = tmpDir();
    const good = sha256("shipped\n");
    fs.writeFileSync(
      path.join(dir, ".managed.json"),
      JSON.stringify({
        "bad-short.yaml": "not-a-sha",
        "bad-type.yaml": 42,
        "bad-case.yaml": good.toUpperCase(),
        "good.yaml": good,
      }),
    );

    expect(readManagedManifest(dir)).toEqual({ "good.yaml": good });
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
