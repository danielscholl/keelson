// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// A workflow prompt node on codex, end to end through the real policy and the
// real CodexProvider (with a scripted thread): the built-in prompt default has
// nothing codex cannot enforce, while an operator deny makes it fail closed.

import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexProvider, type CodexThreadFactory } from "@keelson/providers";
import { resolveSandboxConfig } from "@keelson/shared/config";
import {
  createOperatorSandboxPolicy,
  type DagNode,
  makePromptHandler,
  type NodeContext,
  type PromptHandlerProvider,
  type WorkflowDefinition,
} from "@keelson/workflows";

const home = join(tmpdir(), "keelson-codex-sandbox-home");

function codexHandler(config: Parameters<typeof resolveSandboxConfig>[0]) {
  let threads = 0;
  const factory: CodexThreadFactory = {
    async createThread() {
      threads++;
      return {
        async runStreamed() {
          return (async function* () {
            yield { type: "item.completed", item: { id: "a1", type: "agent_message", text: "ok" } };
            yield { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } };
          })();
        },
      };
    },
  };
  const provider = new CodexProvider({ factory });
  const handler = makePromptHandler({
    getProvider: () => provider as unknown as PromptHandlerProvider,
    getRegisteredTools: () => [],
    sandbox: createOperatorSandboxPolicy(resolveSandboxConfig(config, {}), {
      home,
      dbPath: join(home, "keelson.db"),
      bundledBinDir: join(home, "bin"),
      resolveGitCommonDir: () => undefined,
    }),
  });
  return { handler, threads: () => threads };
}

function ctx(): NodeContext {
  return {
    runId: "r1",
    nodeId: "ask",
    inputs: {},
    upstreamOutputs: new Map(),
    cwd: process.cwd(),
    abortSignal: new AbortController().signal,
    emit: () => undefined,
    resolvedBody: "hi",
    rawBody: "hi",
    workflow: { name: "w", description: "", nodes: [] } as unknown as WorkflowDefinition,
  };
}

const sandboxedNode = { id: "ask", prompt: "hi", sandbox: { enabled: true } } as unknown as DagNode;

describe("codex prompt node under the sandbox", () => {
  test("the built-in prompt default runs on codex's own sandbox", async () => {
    const { handler, threads } = codexHandler({});
    const result = await handler.handle(sandboxedNode, ctx());
    expect(result).toMatchObject({
      status: "succeeded",
      sandbox: "provider",
      sandboxBackend: "codex",
    });
    expect(threads()).toBe(1);
  });

  test("an operator-configured deny makes it fail closed before a thread starts", async () => {
    const { handler, threads } = codexHandler({
      sandbox: { filesystem: { denied: [join(tmpdir(), "keelson-codex-secret")] } },
    });
    const result = await handler.handle(sandboxedNode, ctx());
    expect(result.status).toBe("failed");
    expect(result.error).toContain("codex cannot enforce denied paths");
    expect(threads()).toBe(0);
  });
});
