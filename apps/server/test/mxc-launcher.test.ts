// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// The MXC launcher and runtime against a fake executor: a script that records
// the config it was handed, runs its commandLine under /bin/sh with only the
// config's env, and proxies the exit code, as mxc-exec-mac does.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMxcLauncher, createMxcRuntime } from "@keelson/shared/launcher";
import {
  createSandboxPolicy,
  type DagNode,
  makeScriptHandler,
  type NodeContext,
  runSubprocess,
  type SandboxProfile,
  SubprocessSpawnError,
  type WorkflowDefinition,
} from "@keelson/workflows";

const POSIX = process.platform !== "win32";
let root: string;
let fakeExec: string;
let stripEnvExec: string;
let failingExec: string;

// `stripEnv` reproduces Seatbelt's bun quirk: the child starts with no env at all.
function writeFake(name: string, opts: { stripEnv?: boolean; envelope?: string } = {}): string {
  const script = join(root, `${name}.ts`);
  writeFileSync(
    script,
    `
const fs = require("node:fs");
const configPath = process.argv[2];
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
fs.writeFileSync(configPath + ".seen", JSON.stringify(config));
${opts.envelope ? `process.stderr.write(${JSON.stringify(opts.envelope)} + "\\n"); process.exit(255);` : ""}
const env = Object.fromEntries(config.process.env.map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
const child = Bun.spawn(["/bin/sh", "-c", config.process.commandLine], {
  cwd: config.process.cwd,
  env: ${opts.stripEnv ? "{ PATH: env.PATH }" : "env"},
  stdout: "inherit",
  stderr: "inherit",
  stdin: "ignore",
});
process.exit(await child.exited);
`,
  );
  const wrapper = join(root, name);
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  return wrapper;
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keelson-mxc-fake-")));
  fakeExec = writeFake("mxc-fake");
  stripEnvExec = writeFake("mxc-fake-strip", { stripEnv: true });
  failingExec = writeFake("mxc-fake-fail", {
    envelope: '{"error":{"code":"backend_error","message":"failed to spawn sandboxed process"}}',
  });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const profile = (): SandboxProfile => ({
  enabled: true,
  filesystem: { readwrite: [root], readonly: [], denied: [] },
  network: { outbound: "deny" },
  env: [],
});

function subprocess(
  launcherExec: string,
  commandLine: string,
  signal = new AbortController().signal,
) {
  const scratch = mkdtempSync(join(root, "scratch-"));
  return runSubprocess({
    cmd: "/bin/sh",
    args: ["-c", commandLine],
    cwd: root,
    env: { PATH: "/usr/bin:/bin", KEELSON_RUN_ID: "r1" },
    timeoutMs: 30_000,
    abortSignal: signal,
    emit: () => undefined,
    trimTrailingNewline: true,
    launcher: createMxcLauncher({
      executorPath: launcherExec,
      scratchDir: scratch,
      profile: profile(),
    }),
  });
}

describe.skipIf(!POSIX)("createMxcLauncher through runSubprocess", () => {
  test("the child gets only the spawn env: a host secret in keelson's env never reaches it", async () => {
    process.env.SECRET_TOKEN = "leak-me";
    try {
      const outcome = await subprocess(
        fakeExec,
        'echo "run=$KEELSON_RUN_ID secret=${SECRET_TOKEN:-none}"',
      );
      expect(outcome.stdoutText).toBe("run=r1 secret=none");
      expect(outcome.exitCode).toBe(0);
    } finally {
      delete process.env.SECRET_TOKEN;
    }
  });

  test("cwd is honored and the exit code propagates", async () => {
    const outcome = await subprocess(fakeExec, "pwd; exit 7");
    expect(outcome.stdoutText).toBe(root);
    expect(outcome.exitCode).toBe(7);
  });

  test("the config is written as a 0600 file, is a seatbelt request, and is removed after exit", async () => {
    const scratch = mkdtempSync(join(root, "scratch-"));
    const handle = createMxcLauncher({
      executorPath: fakeExec,
      scratchDir: scratch,
      profile: profile(),
    }).spawn({ cmd: "true", args: [], cwd: root, env: { PATH: "/usr/bin:/bin" } });
    expect(await handle.exited).toBe(0);
    const files = (await Array.fromAsync(new Bun.Glob("mxc-*").scan(scratch))).sort();
    expect(files.filter((f) => f.endsWith(".json"))).toEqual([]);
    const seen = JSON.parse(readFileSync(join(scratch, files[0] ?? ""), "utf8"));
    expect(seen).toMatchObject({ version: "1.0.0", containment: "seatbelt" });
    expect(seen.process.timeout).toBeUndefined();
  });

  test("an abort kills a sandboxed sleep 30 within 3 seconds", async () => {
    const ctrl = new AbortController();
    const started = Date.now();
    const pending = subprocess(fakeExec, "sleep 30", ctrl.signal);
    setTimeout(() => ctrl.abort(), 300);
    const outcome = await pending;
    expect(outcome.killReason).toBe("abort");
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  test("a missing executor surfaces as SubprocessSpawnError", async () => {
    await expect(subprocess(join(root, "no-such-executor"), "true")).rejects.toBeInstanceOf(
      SubprocessSpawnError,
    );
  });

  test("an executor failure reads as a sandbox launch failure in the stderr tail", async () => {
    const outcome = await subprocess(failingExec, "true");
    expect(outcome.exitCode).toBe(255);
    expect(outcome.stderrTail).toBe("sandbox launch failed: failed to spawn sandboxed process");
  });
});

describe.skipIf(!POSIX)("createMxcRuntime with the script handler", () => {
  function ctx(artifactsDir: string): NodeContext {
    return {
      runId: "run-mxc",
      nodeId: "s",
      inputs: {},
      upstreamOutputs: new Map(),
      cwd: root,
      abortSignal: new AbortController().signal,
      emit: () => undefined,
      resolvedBody: "",
      rawBody:
        "console.log(`run=${process.env.KEELSON_RUN_ID} secret=${process.env.SECRET_TOKEN ?? 'none'}`)",
      workflow: { name: "w", description: "", nodes: [] } as unknown as WorkflowDefinition,
      artifactsDir,
    };
  }

  test("a sandboxed bun script whose env the executor strips still sees KEELSON_RUN_ID, not a host secret", async () => {
    const artifacts = join(root, "artifacts");
    mkdirSync(artifacts, { recursive: true });
    const home = join(root, "home");
    const policy = createSandboxPolicy({
      floor: true,
      defaultEnabled: false,
      home,
      dbPath: join(home, "keelson.db"),
      bundledBinDir: join(home, "bin"),
      resolveGitCommonDir: () => undefined,
      runtime: createMxcRuntime({ executorPath: stripEnvExec }),
    });
    process.env.SECRET_TOKEN = "leak-me";
    try {
      const node = { id: "s", script: "x", runtime: "bun" } as unknown as DagNode;
      const result = await makeScriptHandler({ sandbox: policy }).handle(node, ctx(artifacts));
      expect(result).toMatchObject({
        status: "succeeded",
        output: { kind: "text", text: "run=run-mxc secret=none" },
        sandbox: "mxc",
        sandboxBackend: "seatbelt",
      });
    } finally {
      delete process.env.SECRET_TOKEN;
    }
  });
});
