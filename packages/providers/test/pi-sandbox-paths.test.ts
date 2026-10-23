// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxProfile } from "@keelson/shared";
import { sandboxPathRefusal, withSandboxPathGate } from "../src/pi/sandbox-paths.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "keelson-pi-paths-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const cwd = join(root, "repo");
const docs = join(root, "docs");
const secrets = join(cwd, "secrets");
const outside = join(root, "elsewhere");
for (const dir of [cwd, docs, secrets, outside]) mkdirSync(dir, { recursive: true });

const profile: SandboxProfile = {
  enabled: true,
  filesystem: { readwrite: [cwd], readonly: [docs], denied: [secrets] },
  network: { outbound: "deny" },
  env: [],
};
const refuse = (tool: string, path?: string) =>
  sandboxPathRefusal(tool, path === undefined ? {} : { path }, profile, cwd);

describe("pi file tools under a sandboxed turn", () => {
  test("reads reach the writable and read-only roots, nothing else", () => {
    expect(refuse("read", "src/index.ts")).toBeUndefined();
    expect(refuse("read", join(docs, "guide.md"))).toBeUndefined();
    expect(refuse("ls")).toBeUndefined();
    expect(refuse("read", join(outside, "x"))).toContain("outside the sandbox's readable roots");
    expect(refuse("read", "../elsewhere/x")).toContain("outside the sandbox's readable roots");
  });

  test("a denied path stays unreadable even inside the project", () => {
    expect(refuse("read", "secrets/token")).toBe("path 'secrets/token' is denied by the sandbox");
    expect(refuse("grep", ".")).toContain("contains a path the sandbox denies");
    expect(refuse("find")).toContain("contains a path the sandbox denies");
    expect(refuse("grep", "src")).toBeUndefined();
  });

  test("writes land only in the writable roots", () => {
    expect(refuse("write", "out/new.txt")).toBeUndefined();
    expect(refuse("edit", join(docs, "guide.md"))).toBe(
      `path '${join(docs, "guide.md")}' is not writable in the sandbox`,
    );
    expect(refuse("write", "secrets/k")).toBe("path 'secrets/k' is denied by the sandbox");
  });

  test("a symlink out of the project is judged where it lands", () => {
    symlinkSync(outside, join(cwd, "link-out"));
    expect(refuse("write", "link-out/x")).toContain("not writable");
    expect(refuse("read", "link-out/x")).toContain("outside the sandbox's readable roots");
  });

  test("a '..'-prefixed name is an ordinary entry, so a denied directory still covers it", () => {
    expect(refuse("read", "secrets/..env")).toBe("path 'secrets/..env' is denied by the sandbox");
    expect(refuse("write", "..notes.md")).toBeUndefined();
  });

  test("a dangling link fails closed instead of reading as a new file", () => {
    symlinkSync(join(outside, "new.txt"), join(cwd, "dangling"));
    symlinkSync(join(outside, "missing-dir"), join(cwd, "dangling-dir"));
    expect(refuse("write", "dangling")).toBe(
      "path 'dangling' goes through a link the sandbox cannot resolve",
    );
    expect(refuse("write", "dangling-dir/new.txt")).toContain("cannot resolve");
    expect(refuse("read", "dangling")).toContain("cannot resolve");
  });

  test("other tools pass through to the wrapped gate", async () => {
    const seen: string[] = [];
    const gate = withSandboxPathGate(
      async ({ tool }) => {
        seen.push(tool);
        return { outcome: "allow" };
      },
      profile,
      cwd,
    );
    expect(await gate({ tool: "read", args: { path: "secrets/a" } })).toMatchObject({
      outcome: "deny",
    });
    expect(await gate({ tool: "web_search", args: { query: "x" } })).toEqual({ outcome: "allow" });
    expect(await gate({ tool: "read", args: { path: "a.ts" } })).toEqual({ outcome: "allow" });
    expect(seen).toEqual(["web_search", "read"]);
  });
});
