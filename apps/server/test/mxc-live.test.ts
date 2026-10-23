// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// The real Seatbelt executor, end to end through the workflow handlers. Opt in
// with KEELSON_LIVE_SANDBOX=1 on a macOS 15+ host where the executor resolves
// (`keelson sandbox install`, or KEELSON_MXC_EXEC).

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createMxcRuntime, resolveMxcExecutor } from "@keelson/shared/launcher";
import {
  createSandboxPolicy,
  type DagNode,
  makeBashHandler,
  makeScriptHandler,
  type NodeContext,
  type NodeStreamEvent,
  prepareSandboxScratch,
  type WorkflowDefinition,
} from "@keelson/workflows";
import { createSandboxedBashTool } from "../src/sandboxed-bash-tool.ts";

const executor = resolveMxcExecutor();
const LIVE = process.env.KEELSON_LIVE_SANDBOX === "1" && executor.ok;
const root = realpathSync(mkdtempSync(join(tmpdir(), "keelson-mxc-live-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function policy() {
  if (!executor.ok) throw new Error("no executor");
  return createSandboxPolicy({
    floor: true,
    defaultEnabled: false,
    home: join(root, "keelson-home"),
    dbPath: join(root, "keelson-home", "keelson.db"),
    bundledBinDir: join(root, "bin"),
    runtime: createMxcRuntime({ executorPath: executor.path }),
  });
}

function ctx(
  body: string,
  opts: { cwd?: string; signal?: AbortSignal; events?: NodeStreamEvent[] } = {},
): NodeContext {
  const artifactsDir = join(root, "artifacts", crypto.randomUUID());
  mkdirSync(artifactsDir, { recursive: true });
  return {
    runId: "live-run",
    nodeId: "n1",
    inputs: {},
    upstreamOutputs: new Map(),
    cwd: opts.cwd ?? root,
    abortSignal: opts.signal ?? new AbortController().signal,
    emit: (e) => opts.events?.push(e),
    resolvedBody: body,
    rawBody: body,
    workflow: { name: "live", description: "", nodes: [] } as unknown as WorkflowDefinition,
    artifactsDir,
  };
}

const bashNode = { id: "n1", bash: "" } as unknown as DagNode;
const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
};

describe.skipIf(!LIVE)("MXC Seatbelt runtime (live)", () => {
  test("outbound network is denied", async () => {
    const result = await makeBashHandler({ sandbox: policy() }).handle(
      bashNode,
      ctx("curl -sS -m 5 -o /dev/null https://example.com"),
    );
    expect(result).toMatchObject({ status: "failed", sandbox: "mxc", sandboxBackend: "seatbelt" });
  });

  test.skipIf(!existsSync(join(homedir(), ".ssh")))("~/.ssh is unreadable", async () => {
    const result = await makeBashHandler({ sandbox: policy() }).handle(
      bashNode,
      ctx(`ls "${join(homedir(), ".ssh")}"`),
    );
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Operation not permitted");
  });

  test("a commit inside a worktree lands in the main repository's .git", async () => {
    const repo = join(root, "repo");
    const worktree = join(root, "wt-parent", "wt");
    mkdirSync(repo, { recursive: true });
    mkdirSync(join(root, "wt-parent"), { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    git(
      repo,
      "-c",
      "user.email=t@e",
      "-c",
      "user.name=T",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    );
    git(repo, "worktree", "add", "-q", "-b", "feature", worktree);
    const result = await makeBashHandler({ sandbox: policy() }).handle(
      bashNode,
      ctx(
        "git -c user.email=t@e -c user.name=T commit -q --allow-empty -m sandboxed && git log --format=%s -1",
        { cwd: worktree },
      ),
    );
    expect(result).toMatchObject({
      status: "succeeded",
      output: { kind: "text", text: "sandboxed\n" },
    });
  });

  test("a sandboxed command cannot write beside its own launch files", async () => {
    const result = await makeBashHandler({ sandbox: policy() }).handle(
      bashNode,
      ctx('touch "$(dirname "$0")/planted" && echo planted'),
    );
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Operation not permitted");
  });

  test("an abort kills a sandboxed sleep 30 within 3 seconds", async () => {
    const ctrl = new AbortController();
    const started = Date.now();
    setTimeout(() => ctrl.abort(), 500);
    const result = await makeBashHandler({ sandbox: policy() }).handle(
      bashNode,
      ctx("sleep 30", { signal: ctrl.signal }),
    );
    expect(result.error).toBe("aborted");
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  test("lines stream live and a bare bun in bash draws the nested-bun warning", async () => {
    const events: NodeStreamEvent[] = [];
    await makeBashHandler({ sandbox: policy() }).handle(
      bashNode,
      ctx("echo one; echo two; true || bun --version", { events }),
    );
    expect(
      events.filter((e) => e.type === "node_log").map((e) => (e as { line: string }).line),
    ).toEqual(["one", "two"]);
    expect(events.some((e) => e.type === "node_warning")).toBe(true);
  });

  test("a sandboxed bun script node sees KEELSON_RUN_ID through the env shim", async () => {
    const node = { id: "n1", script: "x", runtime: "bun" } as unknown as DagNode;
    const result = await makeScriptHandler({ sandbox: policy() }).handle(
      node,
      ctx(
        "console.log(`run=${process.env.KEELSON_RUN_ID} home=${process.env.HOME?.includes('sandbox')}`)",
      ),
    );
    expect(result).toMatchObject({
      status: "succeeded",
      output: { kind: "text", text: "run=live-run home=true" },
    });
  });

  test("pi's sandboxed bash runs commands confined and reports like pi's own", async () => {
    const bash = createSandboxedBashTool({
      policy: policy(),
      scratchDir: prepareSandboxScratch(root, "conv-live"),
      baseEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin", SECRET_TOKEN: "leak-me" },
      defaultTimeoutSec: 30,
    });
    const results: Array<{ content: string; isError?: boolean }> = [];
    const toolCtx = {
      cwd: root,
      abortSignal: new AbortController().signal,
      emit: (c: { type: string }) => {
        if (c.type === "tool_result")
          results.push(c as unknown as { content: string; isError?: boolean });
      },
    };
    await bash.execute({ command: 'echo "secret=${SECRET_TOKEN:-none}"' }, toolCtx as never);
    await bash.execute(
      { command: "curl -sS -m 5 -o /dev/null https://example.com" },
      toolCtx as never,
    );
    expect(results[0]).toMatchObject({ content: "secret=none" });
    expect(results[1]?.isError).toBe(true);
    expect(results[1]?.content).toContain("Command exited with code");
  });
});
