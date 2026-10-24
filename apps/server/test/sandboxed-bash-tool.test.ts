// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageChunk } from "@keelson/shared";
import { hostLauncher, type ProcessLauncher } from "@keelson/shared/launcher";
import {
  createSandboxPolicy,
  prepareSandboxScratch,
  type SandboxProfile,
} from "@keelson/workflows";
import { createSandboxedBashTool } from "../src/sandboxed-bash-tool.ts";

const POSIX = process.platform !== "win32";
const root = realpathSync(mkdtempSync(join(tmpdir(), "keelson-sbash-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function tool(
  runtime = true,
  launcher: ProcessLauncher = hostLauncher,
  extra: Partial<Parameters<typeof createSandboxedBashTool>[0]> = {},
) {
  const profiles: SandboxProfile[] = [];
  const policy = createSandboxPolicy({
    floor: false,
    defaultEnabled: false,
    home: join(root, "home"),
    dbPath: join(root, "home", "keelson.db"),
    bundledBinDir: join(root, "bin"),
    resolveGitCommonDir: () => undefined,
    ...(runtime
      ? {
          runtime: {
            backend: "fake",
            createLauncher: (profile: SandboxProfile) => {
              profiles.push(profile);
              return launcher;
            },
          },
        }
      : {}),
  });
  return {
    profiles,
    bash: createSandboxedBashTool({
      policy,
      scratchDir: prepareSandboxScratch(root, "conv-1"),
      baseEnv: { PATH: "/usr/bin:/bin", SECRET_TOKEN: "leak-me", GH_TOKEN: "gh-x" },
      defaultTimeoutSec: 30,
      ...extra,
    }),
  };
}

async function run(bash: ReturnType<typeof tool>["bash"], input: unknown) {
  const chunks: MessageChunk[] = [];
  await bash.execute(input, {
    cwd: root,
    emit: (c) => chunks.push(c),
    abortSignal: new AbortController().signal,
  });
  return chunks.find((c) => c.type === "tool_result") as
    | { type: "tool_result"; content: string; isError?: boolean }
    | undefined;
}

describe.skipIf(!POSIX)("createSandboxedBashTool", () => {
  test("keeps pi's bash name and parameters", () => {
    const { bash } = tool();
    expect(bash.name).toBe("bash");
    expect(bash.inputSchema.safeParse({ command: "ls", timeout: 5 }).success).toBe(true);
    expect(bash.inputSchema.safeParse({}).success).toBe(false);
  });

  test("runs under the bash default profile and folds stderr into the result", async () => {
    const { bash, profiles } = tool();
    const result = await run(bash, {
      command: 'echo out; echo err >&2; echo "secret=${SECRET_TOKEN:-none}"',
    });
    expect(result).toEqual({
      type: "tool_result",
      toolUseId: "",
      content: "out\nerr\nsecret=none",
    } as never);
    expect(profiles[0]?.filesystem.denied.length).toBeGreaterThan(0);
    expect(profiles[0]?.filesystem.readwrite).toContain(root);
    expect(profiles[0]?.network.outbound).toBe("deny");
  });

  test("a non-zero exit is an error ending in pi's status line", async () => {
    const result = await run(tool().bash, { command: "echo partial; exit 3" });
    expect(result?.isError).toBe(true);
    expect(result?.content).toBe("partial\n\nCommand exited with code 3");
  });

  test("a timeout is reported in seconds", async () => {
    const result = await run(tool().bash, { command: "sleep 5", timeout: 0.2 });
    expect(result?.isError).toBe(true);
    expect(result?.content).toBe("Command timed out after 0.2 seconds");
  });

  test("a runtime launch failure on stderr reaches the model before the status line", async () => {
    // What the MXC launcher's rewrite leaves on stderr when the executor refuses.
    const refusing: ProcessLauncher = {
      id: "mxc",
      spawn: (spec) =>
        hostLauncher.spawn({
          ...spec,
          cmd: "/bin/sh",
          args: ["-c", 'echo "sandbox launch failed: backend refused" >&2; exit 255'],
        }),
    };
    const result = await run(tool(true, refusing).bash, { command: "echo never" });
    expect(result).toMatchObject({
      isError: true,
      content: "sandbox launch failed: backend refused\n\nCommand exited with code 255",
    });
  });

  test("leaves no launch file in the conversation scratch a later command could plant over", async () => {
    const { bash } = tool();
    await run(bash, { command: "true" });
    const scratch = prepareSandboxScratch(root, "conv-1");
    const entries = await Array.fromAsync(
      new Bun.Glob("*").scan({ cwd: scratch, onlyFiles: true }),
    );
    expect(entries).toEqual([]);
  });

  test("a workflow node's and its workflow's sandbox blocks shape the shell, over the bash default", async () => {
    const { bash, profiles } = tool(true, hostLauncher, {
      workflowSandbox: { env: ["GH_TOKEN"] },
      nodeSandbox: { network: { outbound: "allow" } },
      artifactsDir: join(root, "artifacts"),
    });
    const result = await run(bash, { command: 'echo "gh=${GH_TOKEN:-none}"' });
    expect(result?.content).toBe("gh=gh-x");
    expect(profiles[0]?.network.outbound).toBe("allow");
    expect(profiles[0]?.filesystem.readwrite).toContain(join(root, "artifacts"));
    // Still the bash default underneath: credentials and keelson state denied.
    expect(profiles[0]?.filesystem.denied).toContain(join(root, "home", "keelson.db"));
  });

  test("a live-web workflow's shell may reach the network while staying confined", async () => {
    const { bash, profiles } = tool(true, hostLauncher, { webSearchLive: true });
    const result = await run(bash, { command: 'echo "gh=${GH_TOKEN:-none}"' });
    expect(result?.content).toBe("gh=none");
    expect(profiles[0]?.network.outbound).toBe("allow");
    expect(profiles[0]?.filesystem.denied).toContain(join(root, "home", "keelson.db"));
  });

  test("chat passes no blocks and keeps network off and extra env out", async () => {
    const { bash, profiles } = tool();
    const result = await run(bash, { command: 'echo "gh=${GH_TOKEN:-none}"' });
    expect(result?.content).toBe("gh=none");
    expect(profiles[0]?.network.outbound).toBe("deny");
  });

  test("with no runtime it refuses instead of running unconfined", async () => {
    const result = await run(tool(false).bash, { command: "echo nope" });
    expect(result?.isError).toBe(true);
    expect(result?.content).toContain("sandbox required but unavailable");
  });
});
