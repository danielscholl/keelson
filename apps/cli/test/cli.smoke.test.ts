// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { spawnEnv } from "./spawn-env.ts";

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
    env: spawnEnv(envOverrides),
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
    for (const cmd of [
      "version",
      "start",
      "stop",
      "status",
      "workflow",
      "chat",
      "doctor",
      "project",
      "rib",
      "worktree",
    ]) {
      expect(stdout).toContain(cmd);
    }
    expect(stdout).toContain("-p, --prompt <message>");
  });

  test("doctor --json emits a structured report envelope", async () => {
    // Doctor probes the real environment so the exit code depends on the
    // runner's setup. The contract under test is the envelope shape — the six
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
    expect(categories).toEqual(["auth", "db", "ribs", "server", "toolchain", "workflows"]);
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

  // `chat` with no message opens the interactive TUI on a TTY; spawned with
  // pipes (no TTY) or under --json the entry must reject instead of hanging
  // on a TUI that can't render.
  test("chat with no message in JSON mode exits 2 (interactive is TTY-only)", async () => {
    const { stdout, exitCode } = await runCli(["--json", "chat"]);
    expect(exitCode).toBe(2);
    const envelope = JSON.parse(stdout.trim());
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("BAD_INPUTS");
    expect(envelope.error).toContain("interactive mode is TTY-only");
  });

  test("chat with no message without a TTY exits 2", async () => {
    const { stderr, exitCode } = await runCli(["chat"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("chat <message> is required");
  });

  test("chat with a blank message still exits 2", async () => {
    const { exitCode } = await runCli(["chat", "   "]);
    expect(exitCode).toBe(2);
  });

  test("--json with no command emits a structured help envelope", async () => {
    const { stdout, exitCode } = await runCli(["--json"]);
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout.trim());
    expect(envelope.ok).toBe(true);
    expect(envelope.data.name).toBe("@keelson/cli");
    const names = (envelope.data.commands as Array<{ name: string }>).map((c) => c.name);
    for (const expected of ["start", "stop", "status", "workflow", "chat", "doctor", "version"]) {
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

  test("-p is an alias for chat with full option parity", async () => {
    const { stdout, exitCode } = await runCli(["-p", "hello world", "--provider", "stub"], {
      KEELSON_PROVIDERS: "stub",
      KEELSON_USE_STUBS: "1",
    });
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("hello world");
  });

  test("chat options before -p still reach chat", async () => {
    const { stdout, exitCode } = await runCli(["--provider", "stub", "-p", "hello world"], {
      KEELSON_PROVIDERS: "stub",
      KEELSON_USE_STUBS: "1",
    });
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("hello world");
  });

  test("attached short form -p<message> works", async () => {
    const { stdout, exitCode } = await runCli(["-phello world", "--provider", "stub"], {
      KEELSON_PROVIDERS: "stub",
      KEELSON_USE_STUBS: "1",
    });
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("hello world");
  });

  test("--prompt long form composes with --json", async () => {
    const { stdout, exitCode } = await runCli(
      ["--json", "--prompt", "hello world", "--provider", "stub"],
      { KEELSON_PROVIDERS: "stub", KEELSON_USE_STUBS: "1" },
    );
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout.trim());
    expect(envelope.ok).toBe(true);
    expect(envelope.data.text).toContain("hello world");
  });

  test("-p with no message exits 2 like chat does", async () => {
    const { stdout, exitCode } = await runCli(["--json", "-p"]);
    expect(exitCode).toBe(2);
    const envelope = JSON.parse(stdout.trim());
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("BAD_INPUTS");
  });

  test("-p after a subcommand exits 2 instead of being silently swallowed", async () => {
    const { stdout, exitCode } = await runCli(["--json", "chat", "hi", "-p", "second message"]);
    expect(exitCode).toBe(2);
    const envelope = JSON.parse(stdout.trim());
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("BAD_INPUTS");
    expect(envelope.error).toContain("before any subcommand");
  });

  test("start/stop/status are top-level; service/serve remain hidden aliases", async () => {
    for (const cmd of ["start", "stop", "status"]) {
      const res = await runCli(["--json", cmd, "--help"]);
      expect(res.exitCode).toBe(0);
      expect(JSON.parse(res.stdout.trim()).data.command).toBe(cmd);
    }
    // The deprecated `service` group (alias `serve`) still resolves for back-compat.
    for (const alias of ["service", "serve"]) {
      const res = await runCli(["--json", alias, "--help"]);
      expect(res.exitCode).toBe(0);
      expect(JSON.parse(res.stdout.trim()).data.command).toBe("service");
    }
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

  test("chat --project requires the server (in-process has no project store)", async () => {
    const { stdout, exitCode } = await runCli([
      "--json",
      "chat",
      "hi",
      "--provider",
      "stub",
      "--project",
      "keelson",
    ]);
    expect(exitCode).toBe(3);
    const envelope = JSON.parse(stdout.trim());
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("NO_SERVER");
  });

  test("chat --project conflicts with --conversation (binding is creation-time)", async () => {
    const { stdout, exitCode } = await runCli([
      "--json",
      "chat",
      "hi",
      "--project",
      "keelson",
      "--conversation",
      "some-conv-id",
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

  test("workflow run --project requires the server (named projects live in the catalog)", async () => {
    // Probe fails (no server in CI), so the in-process path would otherwise
    // silently target process.cwd() — wrong tree for a mutating workflow.
    const { stdout, exitCode } = await runCli([
      "--json",
      "workflow",
      "run",
      "any-workflow",
      "--project",
      "work-mono",
    ]);
    expect(exitCode).toBe(3);
    const envelope = JSON.parse(stdout.trim());
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("NO_SERVER");
    expect(envelope.error).toContain("--project");
  });
});
