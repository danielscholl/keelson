// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isValidCommandName, resolveCommand, resolveScript } from "./discovery.ts";

async function makeTempRepo(): Promise<string> {
  return mkdtemp(join(tmpdir(), "keelson-discovery-"));
}

describe("isValidCommandName", () => {
  test("accepts simple identifiers", () => {
    expect(isValidCommandName("echo-args")).toBe(true);
    expect(isValidCommandName("my_command")).toBe(true);
  });

  test("rejects path traversal markers", () => {
    expect(isValidCommandName("../etc/passwd")).toBe(false);
    expect(isValidCommandName("foo/bar")).toBe(false);
    expect(isValidCommandName("foo\\bar")).toBe(false);
  });

  test("rejects empty + leading-dot names", () => {
    expect(isValidCommandName("")).toBe(false);
    expect(isValidCommandName(".hidden")).toBe(false);
  });
});

describe("resolveCommand", () => {
  test("loads a .md file from .keelson/commands at repo scope", async () => {
    const cwd = await makeTempRepo();
    await mkdir(join(cwd, ".keelson/commands"), { recursive: true });
    await writeFile(join(cwd, ".keelson/commands/hello.md"), "Hello, $1!");

    const res = await resolveCommand("hello", cwd);
    expect(res).not.toBeNull();
    expect(res?.content).toBe("Hello, $1!");
    expect(res?.path.endsWith(".keelson/commands/hello.md")).toBe(true);
  });

  test("walks 1 subdir deep", async () => {
    const cwd = await makeTempRepo();
    await mkdir(join(cwd, ".keelson/commands/triage"), { recursive: true });
    await writeFile(join(cwd, ".keelson/commands/triage/sweep.md"), "sweep body");

    const res = await resolveCommand("sweep", cwd);
    expect(res?.content).toBe("sweep body");
  });

  test("returns null when command file is empty", async () => {
    const cwd = await makeTempRepo();
    await mkdir(join(cwd, ".keelson/commands"), { recursive: true });
    await writeFile(join(cwd, ".keelson/commands/blank.md"), "   \n   ");
    expect(await resolveCommand("blank", cwd)).toBeNull();
  });

  test("returns null when no matching file exists", async () => {
    const cwd = await makeTempRepo();
    expect(await resolveCommand("nope", cwd)).toBeNull();
  });
});

describe("resolveScript", () => {
  test("matches a .ts script for runtime=bun", async () => {
    const cwd = await makeTempRepo();
    await mkdir(join(cwd, ".keelson/scripts"), { recursive: true });
    await writeFile(join(cwd, ".keelson/scripts/echo-args.ts"), "console.log('hi')");

    const res = await resolveScript("echo-args", "bun", cwd);
    expect(res?.runtime).toBe("bun");
    expect(res?.path.endsWith(".keelson/scripts/echo-args.ts")).toBe(true);
  });

  test("matches a .py script for runtime=uv", async () => {
    const cwd = await makeTempRepo();
    await mkdir(join(cwd, ".keelson/scripts"), { recursive: true });
    await writeFile(join(cwd, ".keelson/scripts/echo-py.py"), "print('hi')");

    const res = await resolveScript("echo-py", "uv", cwd);
    expect(res?.runtime).toBe("uv");
  });

  test("does not cross runtimes — .py file is invisible to runtime=bun", async () => {
    const cwd = await makeTempRepo();
    await mkdir(join(cwd, ".keelson/scripts"), { recursive: true });
    await writeFile(join(cwd, ".keelson/scripts/script.py"), "print(1)");
    expect(await resolveScript("script", "bun", cwd)).toBeNull();
  });

  test("returns null for unresolved name", async () => {
    const cwd = await makeTempRepo();
    expect(await resolveScript("missing", "bun", cwd)).toBeNull();
  });
});
