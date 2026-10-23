// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// A sandboxed pi prompt node, through the workflow prompt handler and the real
// PiProvider (with a fake session factory), gets the host's sandboxed bash.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PiCreateSessionParams, PiProvider, type PiSessionFactory } from "@keelson/providers";
import { hostLauncher } from "@keelson/shared/launcher";
import {
  createSandboxPolicy,
  type DagNode,
  makePromptHandler,
  type NodeContext,
  type PromptHandlerProvider,
  type WorkflowDefinition,
} from "@keelson/workflows";
import { createSandboxedBashTool } from "../src/sandboxed-bash-tool.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "keelson-wf-pi-sandbox-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const policy = createSandboxPolicy({
  floor: false,
  defaultEnabled: true,
  home: join(root, "home"),
  dbPath: join(root, "home", "keelson.db"),
  bundledBinDir: join(root, "bin"),
  resolveGitCommonDir: () => undefined,
  runtime: { backend: "fake", createLauncher: () => hostLauncher },
});

function piWith(sessions: PiCreateSessionParams[]): PromptHandlerProvider {
  const factory: PiSessionFactory = {
    async createSession(params) {
      sessions.push(params);
      let listener: ((e: unknown) => void) | null = null;
      return {
        subscribe(l) {
          listener = l as (e: unknown) => void;
          return () => {
            listener = null;
          };
        },
        async prompt() {
          listener?.({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "done" },
          });
          listener?.({ type: "agent_end" });
        },
      };
    },
  };
  return new PiProvider({ factory, sandboxSupport: "tool" }) as unknown as PromptHandlerProvider;
}

function ctx(): NodeContext {
  const artifactsDir = mkdtempSync(join(root, "artifacts-"));
  return {
    runId: "r1",
    nodeId: "n1",
    inputs: {},
    upstreamOutputs: new Map(),
    cwd: root,
    abortSignal: new AbortController().signal,
    emit: () => undefined,
    resolvedBody: "list the files",
    rawBody: "list the files",
    workflow: { name: "w", description: "", nodes: [], provider: "pi" } as WorkflowDefinition,
    artifactsDir,
  };
}

function handler(sessions: PiCreateSessionParams[]) {
  const provider = piWith(sessions);
  return makePromptHandler({
    getProvider: () => provider,
    getRegisteredTools: () => [],
    sandbox: policy,
    sandboxBashTool: ({ scratchDir }) =>
      createSandboxedBashTool({ policy, scratchDir, defaultTimeoutSec: 30 }) as unknown as {
        name: string;
        [k: string]: unknown;
      },
  });
}

describe("a sandboxed pi prompt node in a workflow", () => {
  test("reports provider and runs with the host's bash in place of pi's own", async () => {
    const sessions: PiCreateSessionParams[] = [];
    const result = await handler(sessions).handle({ id: "n1", prompt: "x" } as DagNode, ctx());
    expect(result).toMatchObject({
      status: "succeeded",
      sandbox: "provider",
      sandboxBackend: "pi",
    });
    expect(sessions[0]?.excludeBuiltinTools).toEqual(["bash"]);
    expect(sessions[0]?.customTools?.map((t) => t.name)).toEqual(["bash"]);
  });

  test("a node that denies bash has no shell at all and still runs", async () => {
    const sessions: PiCreateSessionParams[] = [];
    const node = { id: "n1", prompt: "x", denied_tools: ["Bash"] } as unknown as DagNode;
    const result = await handler(sessions).handle(node, ctx());
    expect(result).toMatchObject({ status: "succeeded", sandbox: "provider" });
    expect(sessions[0]?.excludeBuiltinTools).toEqual(["bash"]);
    expect(sessions[0]?.customTools ?? []).toEqual([]);
  });
});
