// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NodeStreamEvent } from "../executor.ts";
import type { NodeOutput } from "../schema/index.ts";
import type { ProcessLauncher, SpawnHandle, SpawnSpec } from "./launcher.ts";
import {
  buildSubprocessEnv,
  ENV_VALUE_MAX_CHARS,
  killProcessTree,
  runSubprocess,
  SubprocessSpawnError,
} from "./subprocess.ts";

function upstreamOf(id: string, output: string): ReadonlyMap<string, NodeOutput> {
  return new Map<string, NodeOutput>([
    [
      id,
      {
        state: "completed",
        output,
        startedAt: "2026-05-22T00:00:00Z",
        completedAt: "2026-05-22T00:00:01Z",
        durationMs: 1000,
      },
    ],
  ]);
}

describe("killProcessTree", () => {
  test.skipIf(process.platform === "win32")("kills the process handle on POSIX", () => {
    let killCount = 0;
    killProcessTree({
      pid: 123,
      kill: () => {
        killCount++;
      },
    });
    expect(killCount).toBe(1);
  });

  test.skipIf(process.platform === "win32")("spawns nothing on POSIX", () => {
    const spawn = spyOn(Bun, "spawnSync");
    try {
      killProcessTree({ pid: 123, kill: () => {} });
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      spawn.mockRestore();
    }
  });

  test.skipIf(process.platform !== "win32")("tree-kills via taskkill on win32", () => {
    const spawn = spyOn(Bun, "spawnSync").mockReturnValue(
      undefined as unknown as ReturnType<typeof Bun.spawnSync>,
    );
    try {
      let killCount = 0;
      killProcessTree({ pid: 4242, kill: () => killCount++ });
      expect(spawn).toHaveBeenCalled();
      expect(spawn.mock.calls[0]?.[0]).toEqual(["taskkill", "/pid", "4242", "/t", "/f"]);
      expect(killCount).toBe(1);
    } finally {
      spawn.mockRestore();
    }
  });

  test.skipIf(process.platform !== "win32")("skips taskkill when the pid is gone", () => {
    const spawn = spyOn(Bun, "spawnSync");
    try {
      killProcessTree({ kill: () => {} });
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      spawn.mockRestore();
    }
  });

  // Spawn is stubbed so win32 can't fire a real taskkill at whatever owns this
  // pid on the runner.
  test("does not throw when the process already exited", () => {
    const spawn = spyOn(Bun, "spawnSync").mockReturnValue(
      undefined as unknown as ReturnType<typeof Bun.spawnSync>,
    );
    try {
      expect(() =>
        killProcessTree({
          pid: 123,
          kill: () => {
            throw new Error("already exited");
          },
        }),
      ).not.toThrow();
    } finally {
      spawn.mockRestore();
    }
  });
});

describe("buildSubprocessEnv", () => {
  test("layers inputs, run metadata, and upstream output provenance over PARENT_ENV", () => {
    const upstream = new Map<string, NodeOutput>([
      [
        "fetch-stats",
        {
          state: "completed",
          output: "ok",
          startedAt: "2026-05-22T00:00:00Z",
          completedAt: "2026-05-22T00:00:01Z",
          durationMs: 1000,
          provider: "copilot",
          model: "gpt-6-sol",
        },
      ],
    ]);
    const env = buildSubprocessEnv({ ARGUMENTS: "hi", flag: "yes" }, upstream, {
      runId: "run-123",
    });
    expect(env.KEELSON_ARGUMENTS).toBe("hi");
    expect(env.KEELSON_INPUTS_ARGUMENTS).toBe("hi");
    expect(env.KEELSON_INPUTS_flag).toBe("yes");
    expect(env.KEELSON_RUN_ID).toBe("run-123");
    expect(env.KEELSON_NODE_fetch_stats_OUTPUT).toBe("ok");
    expect(env.KEELSON_NODE_fetch_stats_STATE).toBe("completed");
    expect(env.KEELSON_NODE_fetch_stats_PROVIDER).toBe("copilot");
    expect(env.KEELSON_NODE_fetch_stats_MODEL).toBe("gpt-6-sol");
  });

  test("exposes failed output state and clears inherited provenance", () => {
    const upstream = new Map<string, NodeOutput>([
      [
        "review",
        {
          state: "failed",
          output: "partial",
          error: "provider stopped",
          provider: "claude",
          model: "claude-opus-5",
        },
      ],
    ]);
    const env = buildSubprocessEnv({}, upstream, {
      parentEnv: {
        KEELSON_RUN_ID: "stale-run",
        KEELSON_NODE_review_PROVIDER: "stale-provider",
        KEELSON_NODE_review_MODEL: "stale-model",
      },
    });
    expect(Object.hasOwn(env, "KEELSON_RUN_ID")).toBe(false);
    expect(env.KEELSON_NODE_review_STATE).toBe("failed");
    expect(env.KEELSON_NODE_review_ERROR).toBe("provider stopped");
    expect(env.KEELSON_NODE_review_PROVIDER).toBe("claude");
    expect(env.KEELSON_NODE_review_MODEL).toBe("claude-opus-5");
  });

  test("sets both KEELSON_ARTIFACTS_DIR and ARTIFACTS_DIR when options.artifactsDir is provided", () => {
    // Both vars carry the same value: KEELSON_ARTIFACTS_DIR matches our
    // prefixed-env contract; ARTIFACTS_DIR is the unprefixed name that
    // bash/script `ctx.rawBody` shells expand against — those handlers
    // skip executor substitution for command-injection safety, so the
    // unprefixed env var is the only way `cd "$ARTIFACTS_DIR"` resolves.
    const env = buildSubprocessEnv({}, new Map<string, NodeOutput>(), {
      artifactsDir: "/tmp/keelson-run-abc",
    });
    expect(env.KEELSON_ARTIFACTS_DIR).toBe("/tmp/keelson-run-abc");
    expect(env.ARTIFACTS_DIR).toBe("/tmp/keelson-run-abc");
  });

  test("sets the workflow run id without inheriting a stale value", () => {
    const env = buildSubprocessEnv({}, new Map<string, NodeOutput>(), {
      runId: "abcdef12-rest",
      parentEnv: { KEELSON_RUN_ID: "stale" },
    });
    expect(env.KEELSON_RUN_ID).toBe("abcdef12-rest");

    const withoutRun = buildSubprocessEnv({}, new Map<string, NodeOutput>(), {
      parentEnv: { KEELSON_RUN_ID: "stale" },
    });
    expect(Object.hasOwn(withoutRun, "KEELSON_RUN_ID")).toBe(false);
  });

  test("omits both ARTIFACTS_DIR vars when options.artifactsDir is undefined (no PARENT_ENV leak)", () => {
    // The implementation unconditionally deletes env.KEELSON_ARTIFACTS_DIR
    // and env.ARTIFACTS_DIR after spreading PARENT_ENV — so even if the
    // operator's shell had either set when the server booted, neither
    // can leak into a workflow subprocess that wasn't given a per-run
    // scratch dir.
    const env = buildSubprocessEnv({}, new Map<string, NodeOutput>());
    expect(Object.hasOwn(env, "KEELSON_ARTIFACTS_DIR")).toBe(false);
    expect(Object.hasOwn(env, "ARTIFACTS_DIR")).toBe(false);
  });

  test("omits both ARTIFACTS_DIR vars when options is provided but artifactsDir is undefined", () => {
    // The handler call site uses a conditional-spread to omit `artifactsDir`
    // when ctx.artifactsDir is undefined, but defensive: an empty options
    // object should not write either env var.
    const env = buildSubprocessEnv({}, new Map<string, NodeOutput>(), {});
    expect(Object.hasOwn(env, "KEELSON_ARTIFACTS_DIR")).toBe(false);
    expect(Object.hasOwn(env, "ARTIFACTS_DIR")).toBe(false);
  });

  test("ARGUMENTS defaults to '' when not provided in inputs", () => {
    const env = buildSubprocessEnv({}, new Map<string, NodeOutput>());
    expect(env.KEELSON_ARGUMENTS).toBe("");
  });

  test("projects effective provider and model for upstream agent nodes", () => {
    const upstream = new Map<string, NodeOutput>([
      [
        "verify-seat",
        {
          state: "completed",
          output: "ok",
          provider: "claude",
          model: "claude-sonnet-5",
        },
      ],
    ]);
    const env = buildSubprocessEnv({}, upstream);
    expect(env.KEELSON_NODE_verify_seat_PROVIDER).toBe("claude");
    expect(env.KEELSON_NODE_verify_seat_MODEL).toBe("claude-sonnet-5");
  });

  test("caps effective provider and model values", () => {
    const upstream = new Map<string, NodeOutput>([
      [
        "verify",
        {
          state: "completed",
          output: "ok",
          provider: "p".repeat(300),
          model: "m".repeat(300),
        },
      ],
    ]);
    const env = buildSubprocessEnv({}, upstream);
    expect(env.KEELSON_NODE_verify_PROVIDER).toBe("p".repeat(200));
    expect(env.KEELSON_NODE_verify_MODEL).toBe("m".repeat(200));
  });

  test("clears inherited provenance when the current upstream has none", () => {
    const env = buildSubprocessEnv({}, upstreamOf("verify", "ok"), {
      parentEnv: {
        KEELSON_NODE_verify_PROVIDER: "stale-provider",
        KEELSON_NODE_verify_MODEL: "stale-model",
      },
    });
    expect(Object.hasOwn(env, "KEELSON_NODE_verify_PROVIDER")).toBe(false);
    expect(Object.hasOwn(env, "KEELSON_NODE_verify_MODEL")).toBe(false);
  });
});

describe("buildSubprocessEnv — env value cap (issue #442)", () => {
  const big = `HEAD-MARKER\n${"x".repeat(ENV_VALUE_MAX_CHARS * 3)}\nTAIL-MARKER`;

  test("an inherited _FILE is cleared when the current output stays under the cap", () => {
    const exact = "y".repeat(ENV_VALUE_MAX_CHARS);
    const env = buildSubprocessEnv({}, upstreamOf("validate", exact), {
      parentEnv: { KEELSON_NODE_validate_OUTPUT_FILE: "/stale/path.txt" },
    });
    expect(env.KEELSON_NODE_validate_OUTPUT).toBe(exact);
    expect(Object.hasOwn(env, "KEELSON_NODE_validate_OUTPUT_FILE")).toBe(false);
  });

  test("an oversized node output is head+tail truncated with a marker carrying the full length", () => {
    const env = buildSubprocessEnv({}, upstreamOf("validate", big));
    const value = env.KEELSON_NODE_validate_OUTPUT as string;
    expect(value.startsWith("HEAD-MARKER")).toBe(true);
    expect(value.endsWith("TAIL-MARKER")).toBe(true);
    expect(value).toContain(`[keelson: output truncated — ${big.length} chars total`);
    // Bounded: head + tail + marker, nowhere near the original size.
    expect(value.length).toBeLessThan(ENV_VALUE_MAX_CHARS + 256);
  });

  test("without an artifacts dir the output is truncated but no _FILE var is set", () => {
    const env = buildSubprocessEnv({}, upstreamOf("validate", big));
    expect(Object.hasOwn(env, "KEELSON_NODE_validate_OUTPUT_FILE")).toBe(false);
    expect(env.KEELSON_NODE_validate_OUTPUT).not.toContain("_OUTPUT_FILE");
  });

  test("a genuine spill replaces an inherited _FILE with the fresh path", () => {
    const dir = mkdtempSync(join(tmpdir(), "keelson-envcap-"));
    try {
      const env = buildSubprocessEnv({}, upstreamOf("re-review", big), {
        artifactsDir: dir,
        parentEnv: { KEELSON_NODE_re_review_OUTPUT_FILE: "/stale/path.txt" },
      });
      const spillPath = env.KEELSON_NODE_re_review_OUTPUT_FILE as string;
      expect(spillPath).toBe(join(dir, "node-outputs", "re_review.txt"));
      expect(readFileSync(spillPath, "utf8")).toBe(big);
      expect(env.KEELSON_NODE_re_review_OUTPUT).toContain(
        "full output at $KEELSON_NODE_re_review_OUTPUT_FILE",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failed spill clears an inherited _FILE and degrades to truncation-only", () => {
    // A path nested under a regular FILE is un-mkdir-able on every platform
    // (ENOTDIR on POSIX, ERROR_DIRECTORY on Windows) — unlike /dev/null/...,
    // which Windows happily creates as D:\dev\null\... .
    const dir = mkdtempSync(join(tmpdir(), "keelson-envcap-"));
    try {
      const filePath = join(dir, "plain-file");
      writeFileSync(filePath, "x");
      const env = buildSubprocessEnv({}, upstreamOf("validate", big), {
        artifactsDir: join(filePath, "not-a-dir"),
        parentEnv: { KEELSON_NODE_validate_OUTPUT_FILE: "/stale/path.txt" },
      });
      expect(Object.hasOwn(env, "KEELSON_NODE_validate_OUTPUT_FILE")).toBe(false);
      const value = env.KEELSON_NODE_validate_OUTPUT as string;
      expect(value).toContain("[keelson: output truncated");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an under-cap output is still written to _FILE so a consumer can read it unconditionally", () => {
    const dir = mkdtempSync(join(tmpdir(), "keelson-envcap-"));
    try {
      const small = '{"failures":[]}';
      const env = buildSubprocessEnv({}, upstreamOf("run-tests", small), { artifactsDir: dir });
      const spillPath = env.KEELSON_NODE_run_tests_OUTPUT_FILE as string;
      expect(spillPath).toBe(join(dir, "node-outputs", "run_tests.txt"));
      expect(readFileSync(spillPath, "utf8")).toBe(small);
      expect(env.KEELSON_NODE_run_tests_OUTPUT).toBe(small);
      expect(env.KEELSON_NODE_run_tests_STATE).toBe("completed");
      expect(Object.hasOwn(env, "KEELSON_NODE_run_tests_OUTPUT_TRUNCATED")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an over-cap output flags _TRUNCATED while _FILE holds the whole text", () => {
    const dir = mkdtempSync(join(tmpdir(), "keelson-envcap-"));
    try {
      const env = buildSubprocessEnv({}, upstreamOf("validate", big), { artifactsDir: dir });
      expect(env.KEELSON_NODE_validate_OUTPUT_TRUNCATED).toBe("1");
      expect(readFileSync(env.KEELSON_NODE_validate_OUTPUT_FILE as string, "utf8")).toBe(big);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an inherited _TRUNCATED is cleared when the fresh output fits", () => {
    const env = buildSubprocessEnv({}, upstreamOf("validate", "short"), {
      parentEnv: { KEELSON_NODE_validate_OUTPUT_TRUNCATED: "1" },
    });
    expect(Object.hasOwn(env, "KEELSON_NODE_validate_OUTPUT_TRUNCATED")).toBe(false);
  });

  test("oversized inputs and ARGUMENTS are capped the same way (no file spill)", () => {
    const env = buildSubprocessEnv({ ARGUMENTS: big, notes: big }, new Map<string, NodeOutput>());
    for (const key of ["KEELSON_ARGUMENTS", "KEELSON_INPUTS_ARGUMENTS", "KEELSON_INPUTS_notes"]) {
      const value = env[key] as string;
      expect(value.length).toBeLessThan(ENV_VALUE_MAX_CHARS + 256);
      expect(value).toContain(`[keelson: input truncated — ${big.length} chars total]`);
      expect(value.startsWith("HEAD-MARKER")).toBe(true);
      expect(value.endsWith("TAIL-MARKER")).toBe(true);
    }
  });
});

// A pid no real process group can own, so the `-pid` group signal fails with
// ESRCH and runSubprocess falls through to the stub's own kill().
const UNOWNED_PID = 2_147_483_646;

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (text.length > 0) controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

interface StubLauncher extends ProcessLauncher {
  specs: SpawnSpec[];
  signals: (NodeJS.Signals | number | undefined)[];
}

// `exitCode` set: the child exits on its own. Unset: it runs until killed and
// exits 143, as a SIGTERM'd process reports.
function stubLauncher(opts: { stdout?: string; stderr?: string; exitCode?: number }): StubLauncher {
  const specs: SpawnSpec[] = [];
  const signals: (NodeJS.Signals | number | undefined)[] = [];
  return {
    id: "host",
    specs,
    signals,
    spawn(spec): SpawnHandle {
      specs.push(spec);
      let settle: (code: number) => void = () => {};
      const exited = new Promise<number>((resolve) => {
        settle = resolve;
      });
      if (opts.exitCode !== undefined) settle(opts.exitCode);
      return {
        pid: UNOWNED_PID,
        stdout: streamOf(opts.stdout ?? ""),
        stderr: streamOf(opts.stderr ?? ""),
        exited,
        kill(signal) {
          signals.push(signal);
          settle(143);
        },
      };
    },
  };
}

function subprocessOpts(launcher: ProcessLauncher, overrides: { timeoutMs?: number } = {}) {
  const events: NodeStreamEvent[] = [];
  const ctrl = new AbortController();
  return {
    events,
    ctrl,
    opts: {
      cmd: "bash",
      args: ["-c", "echo hi"],
      cwd: "/work",
      env: { KEELSON_RUN_ID: "run-1" },
      timeoutMs: overrides.timeoutMs ?? 60_000,
      abortSignal: ctrl.signal,
      emit: (event: NodeStreamEvent) => events.push(event),
      launcher,
    },
  };
}

describe("runSubprocess — launcher seam", () => {
  // Stubbed so win32's taskkill path never reaches a real process.
  const withSpawnSyncStubbed = async (fn: () => Promise<void>): Promise<void> => {
    const spawn = spyOn(Bun, "spawnSync").mockReturnValue(
      undefined as unknown as ReturnType<typeof Bun.spawnSync>,
    );
    try {
      await fn();
    } finally {
      spawn.mockRestore();
    }
  };

  test("hands the spec to the injected launcher and reads its streams and exit code", async () => {
    await withSpawnSyncStubbed(async () => {
      const launcher = stubLauncher({
        stdout: "first\nsecond\n",
        stderr: "warned\n",
        exitCode: 3,
      });
      const { events, opts } = subprocessOpts(launcher);
      const outcome = await runSubprocess({ ...opts, trimTrailingNewline: true });

      expect(launcher.specs).toEqual([
        { cmd: "bash", args: ["-c", "echo hi"], cwd: "/work", env: { KEELSON_RUN_ID: "run-1" } },
      ]);
      expect(events).toEqual([
        { type: "node_log", line: "first" },
        { type: "node_log", line: "second" },
      ]);
      expect(outcome).toEqual({
        stdoutText: "first\nsecond",
        stderrTail: "warned",
        exitCode: 3,
        killReason: null,
      });
    });
  });

  test("abort kills the launched handle and reports the abort", async () => {
    await withSpawnSyncStubbed(async () => {
      const launcher = stubLauncher({});
      const { ctrl, opts } = subprocessOpts(launcher);
      const pending = runSubprocess(opts);
      ctrl.abort();
      const outcome = await pending;

      expect(outcome.killReason).toBe("abort");
      expect(outcome.exitCode).toBe(143);
      expect(launcher.signals.length).toBeGreaterThan(0);
      if (process.platform !== "win32") expect(launcher.signals[0]).toBe("SIGTERM");
    });
  });

  test("timeout kills the launched handle and reports the timeout", async () => {
    await withSpawnSyncStubbed(async () => {
      const launcher = stubLauncher({});
      const { opts } = subprocessOpts(launcher, { timeoutMs: 10 });
      const outcome = await runSubprocess(opts);

      expect(outcome.killReason).toBe("timeout");
      expect(launcher.signals.length).toBeGreaterThan(0);
    });
  });

  test("a launcher that throws surfaces as SubprocessSpawnError", async () => {
    const cause = new Error("spawn mxc-exec-mac ENOENT");
    const launcher: ProcessLauncher = {
      id: "mxc",
      spawn() {
        throw cause;
      },
    };
    const { opts } = subprocessOpts(launcher);
    const err = await runSubprocess(opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SubprocessSpawnError);
    expect((err as SubprocessSpawnError).cause).toBe(cause);
    expect((err as SubprocessSpawnError).message).toBe("spawn mxc-exec-mac ENOENT");
  });

  test("defaults to the host launcher when none is injected", async () => {
    const { opts } = subprocessOpts(stubLauncher({ exitCode: 0 }));
    const outcome = await runSubprocess({
      ...opts,
      cmd: process.execPath,
      args: ["-e", "console.log('from-host')"],
      cwd: process.cwd(),
      env: { ...(process.env as Record<string, string>) },
      launcher: undefined,
      trimTrailingNewline: true,
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdoutText).toBe("from-host");
  });
});

describe("buildSubprocessEnv — sandbox provenance", () => {
  test("projects an upstream node's sandbox outcome and clears an inherited one", () => {
    const upstream = new Map<string, NodeOutput>([
      [
        "build",
        {
          state: "completed",
          output: "ok",
          sandbox: "mxc",
          startedAt: "2026-05-22T00:00:00Z",
          completedAt: "2026-05-22T00:00:01Z",
          durationMs: 1000,
        },
      ],
      ["plain", { state: "completed", output: "ok" }],
    ]);
    const env = buildSubprocessEnv({}, upstream, {
      parentEnv: { KEELSON_NODE_plain_SANDBOX: "stale" },
    });
    expect(env.KEELSON_NODE_build_SANDBOX).toBe("mxc");
    expect(env.KEELSON_NODE_plain_SANDBOX).toBeUndefined();
  });
});
