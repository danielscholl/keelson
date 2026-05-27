// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const BIN = resolve(import.meta.dir, "..", "bin", "keelson.ts");
const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(
  args: readonly string[],
  envOverrides: Record<string, string> = {},
): Promise<RunResult> {
  const proc = Bun.spawn(["bun", BIN, ...args], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...envOverrides } as Record<string, string>,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("keelson CLI smoke", () => {
  test("version --json emits a parseable success envelope", async () => {
    const { stdout, exitCode } = await runCli(["version", "--json"]);
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout.trim());
    expect(envelope.ok).toBe(true);
    expect(typeof envelope.data?.version).toBe("string");
    expect(typeof envelope.data?.bunVersion).toBe("string");
    expect(typeof envelope.data?.schemaVersion).toBe("string");
    expect(envelope.data?.name).toBe("@keelson/cli");
  });

  test("version prints human-readable output by default", async () => {
    const { stdout, exitCode } = await runCli(["version"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("version:");
    expect(stdout).toContain("bunVersion:");
    expect(stdout).toContain("schemaVersion:");
  });

  test("help lists every v0 subcommand", async () => {
    const { stdout, exitCode } = await runCli(["--help"]);
    expect(exitCode).toBe(0);
    for (const cmd of ["version", "serve", "workflow", "chat", "doctor", "project", "worktree"]) {
      expect(stdout).toContain(cmd);
    }
  });

  test("doctor --json emits a structured report envelope", async () => {
    // Doctor probes the real environment so the exit code depends on the
    // runner's setup. The contract under test is the envelope shape — five
    // categories, a summary, and the strict flag — not that any particular
    // check passes.
    const { stdout } = await runCli(["--json", "doctor"]);
    const envelope = JSON.parse(stdout.trim());
    expect(envelope.ok).toBe(true);
    const data = envelope.data as {
      categories: Array<{ category: string; checks: unknown[] }>;
      summary: { ok: number; warn: number; fail: number; skip: number; total: number };
      strict: boolean;
    };
    expect(data.strict).toBe(false);
    const categories = data.categories.map((c) => c.category).sort();
    expect(categories).toEqual(["auth", "db", "server", "toolchain", "workflows"]);
    const summed = data.summary.ok + data.summary.warn + data.summary.fail + data.summary.skip;
    expect(summed).toBe(data.summary.total);
  });

  test("unknown command exits 2 with bad-args envelope in JSON mode", async () => {
    const { stdout, exitCode } = await runCli(["--json", "nope"]);
    expect(exitCode).toBe(2);
    const envelope = JSON.parse(stdout.trim());
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("commander.unknownCommand");
  });

  test("missing required arg exits 2 with bad-args envelope in JSON mode", async () => {
    const { stdout, exitCode } = await runCli(["--json", "chat"]);
    expect(exitCode).toBe(2);
    const envelope = JSON.parse(stdout.trim());
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("commander.missingArgument");
  });

  test("missing required arg in human mode still exits 2", async () => {
    const { stderr, exitCode } = await runCli(["chat"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("missing required argument");
  });

  test("--json with no command emits a structured help envelope", async () => {
    const { stdout, exitCode } = await runCli(["--json"]);
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout.trim());
    expect(envelope.ok).toBe(true);
    expect(envelope.data.name).toBe("@keelson/cli");
    const names = (envelope.data.commands as Array<{ name: string }>).map((c) => c.name);
    for (const expected of ["serve", "workflow", "chat", "doctor", "version"]) {
      expect(names).toContain(expected);
    }
  });

  test("--json --help emits the same help envelope", async () => {
    const { stdout, exitCode } = await runCli(["--json", "--help"]);
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout.trim());
    expect(envelope.ok).toBe(true);
    expect(envelope.data.commands).toBeDefined();
  });

  test("--json --version emits a version envelope", async () => {
    const { stdout, exitCode } = await runCli(["--json", "--version"]);
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout.trim());
    expect(envelope.ok).toBe(true);
    expect(envelope.data.schemaVersion).toBeDefined();
    expect(envelope.data.bunVersion).toBeDefined();
  });

  test("trailing operands on fixed-arity commands exit 2", async () => {
    const { stdout, exitCode } = await runCli(["--json", "version", "extra"]);
    expect(exitCode).toBe(2);
    const envelope = JSON.parse(stdout.trim());
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("commander.excessArguments");
  });

  test("trailing operands on subcommand groups exit 2", async () => {
    const { stdout, exitCode } = await runCli(["--json", "chat", "hi", "extra"]);
    expect(exitCode).toBe(2);
    const envelope = JSON.parse(stdout.trim());
    expect(envelope.code).toBe("commander.excessArguments");
  });

  test("--json help <cmd> returns the requested command's envelope", async () => {
    const { stdout, exitCode } = await runCli(["--json", "help", "workflow"]);
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout.trim());
    expect(envelope.ok).toBe(true);
    expect(envelope.data.command).toBe("workflow");
    const subs = (envelope.data.commands as Array<{ name: string }>).map((c) => c.name);
    expect(subs).toContain("list");
    expect(subs).toContain("run");
  });

  test("--json <cmd> --help returns the requested command's envelope", async () => {
    const { stdout, exitCode } = await runCli(["--json", "chat", "--help"]);
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout.trim());
    expect(envelope.data.command).toBe("chat");
    expect(envelope.data.usage).toContain("message");
  });

  test("--json <group> help <sub> walks the full subcommand path", async () => {
    const { stdout, exitCode } = await runCli(["--json", "workflow", "help", "run"]);
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout.trim());
    expect(envelope.data.command).toBe("run");
    expect(envelope.data.usage).toContain("name");
  });

  test("--json <group> help returns the group's envelope", async () => {
    const { stdout, exitCode } = await runCli(["--json", "workflow", "help"]);
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout.trim());
    expect(envelope.data.command).toBe("workflow");
  });

  test("chat with stub provider on a pipe emits only the assistant text", async () => {
    // Non-TTY + no --json must produce just the answer so pipes like
    // `keelson chat ... | pbcopy` copy the response, not metadata.
    const { stdout, exitCode } = await runCli(["chat", "hello world", "--provider", "stub"], {
      KEELSON_PROVIDERS: "stub",
      KEELSON_USE_STUBS: "1",
    });
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("hello world");
    // No metadata leak: no "mode:" or "providerId:" lines.
    expect(stdout).not.toContain("mode:");
    expect(stdout).not.toContain("providerId");
  });

  test("--reasoning-effort with an unknown tier exits 2 with BAD_INPUTS", async () => {
    // Validate before any server round-trip so a bad tier doesn't create an
    // orphan conversation row mid-stream.
    const { stdout, exitCode } = await runCli([
      "--json",
      "chat",
      "hi",
      "--provider",
      "stub",
      "--reasoning-effort",
      "ultra",
    ]);
    expect(exitCode).toBe(2);
    const envelope = JSON.parse(stdout.trim());
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("BAD_INPUTS");
    expect(envelope.error).toContain("ultra");
  });

  test("empty-string chat options exit 2 with BAD_INPUTS", async () => {
    // `$VAR` expansions that resolve to "" must trip BAD_INPUTS rather
    // than silently dropping the option and routing to the default
    // provider / fresh conversation.
    const cases: Array<[string, string]> = [
      ["--provider", "--provider must not be empty"],
      ["--model", "--model must not be empty"],
      ["--conversation", "--conversation must not be empty"],
      ["--base-url", "--base-url must not be empty"],
    ];
    for (const [flag, expectedError] of cases) {
      const { stdout, exitCode } = await runCli(["--json", "chat", "hi", flag, ""]);
      expect(exitCode).toBe(2);
      const envelope = JSON.parse(stdout.trim());
      expect(envelope.ok).toBe(false);
      expect(envelope.code).toBe("BAD_INPUTS");
      expect(envelope.error).toBe(expectedError);
    }
  });

  test("--reasoning-effort with an empty string exits 2 with BAD_INPUTS", async () => {
    // An empty string commonly arrives from `--reasoning-effort "$VAR"` with
    // VAR unset; must trip the enum validator, not silently bypass it.
    const { stdout, exitCode } = await runCli([
      "--json",
      "chat",
      "hi",
      "--provider",
      "stub",
      "--reasoning-effort",
      "",
    ]);
    expect(exitCode).toBe(2);
    const envelope = JSON.parse(stdout.trim());
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("BAD_INPUTS");
  });

  test("chat --conversation requires the server (in-process has no store)", async () => {
    // No server is running in CI, so the probe fails. The conversation arg
    // makes no sense in the in-process path; surface NO_SERVER cleanly.
    const { stdout, exitCode } = await runCli([
      "--json",
      "chat",
      "hi",
      "--provider",
      "stub",
      "--conversation",
      "doesnt-matter",
    ]);
    expect(exitCode).toBe(3);
    const envelope = JSON.parse(stdout.trim());
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("NO_SERVER");
  });
});
