// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const BIN = resolve(import.meta.dir, "..", "bin", "keelson.ts");
const FIXTURES = resolve(import.meta.dir, "fixtures");

async function runCli(args: readonly string[]): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", BIN, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { stdout, exitCode };
}

describe("workflow list (in-process)", () => {
  test("returns the fixture workflows in --json mode", async () => {
    const { stdout, exitCode } = await runCli(["--json", "workflow", "list"]);
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout.trim());
    expect(envelope.ok).toBe(true);
    expect(Array.isArray(envelope.data.workflows)).toBe(true);
  });

  test("--dir reads an explicit workflows directory", async () => {
    const { stdout, exitCode } = await runCli(["--json", "workflow", "list", "--dir", FIXTURES]);
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout.trim());
    expect(envelope.ok).toBe(true);
    const names = envelope.data.workflows.map((w: { name: string }) => w.name);
    expect(names).toContain("smoke-bash");
  });
});
