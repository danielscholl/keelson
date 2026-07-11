// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NodeContext, NodeHandler, NodeResult } from "../executor.ts";
import type { DagNode, WorkflowDefinition } from "../schema/index.ts";
import { makeCommandHandler } from "./command.ts";

interface RecordedCall {
  node: DagNode;
  ctx: NodeContext;
}

function makeRecorderHandler(returnText = "ok"): {
  handler: NodeHandler;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const handler: NodeHandler = {
    type: "prompt",
    async handle(node, ctx): Promise<NodeResult> {
      calls.push({ node, ctx });
      return { status: "succeeded", output: { kind: "text", text: returnText } };
    },
  };
  return { handler, calls };
}

function buildCtx(cwd: string): NodeContext {
  return {
    runId: "run-cmd-1",
    nodeId: "echo-cmd",
    inputs: {},
    upstreamOutputs: new Map(),
    cwd,
    abortSignal: new AbortController().signal,
    emit: () => undefined,
    resolvedBody: "echo-cmd-name", // the command name; the handler replaces this
    rawBody: "echo-cmd-name",
    workflow: { name: "t", description: "", nodes: [] } as unknown as WorkflowDefinition,
  };
}

describe("makeCommandHandler", () => {
  test("loads the resolved file and delegates to prompt handler with prompt=content", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "keelson-cmd-"));
    await mkdir(join(cwd, ".keelson/commands"), { recursive: true });
    await writeFile(join(cwd, ".keelson/commands/hello.md"), "Greet the user.");

    const { handler: promptHandler, calls } = makeRecorderHandler();
    const handler = makeCommandHandler({ promptHandler });
    const node = {
      id: "greet",
      command: "hello",
      model: "copilot/gpt-5-mini",
    } as unknown as DagNode;
    const result = await handler.handle(node, buildCtx(cwd));

    expect(result.status).toBe("succeeded");
    expect(calls).toHaveLength(1);
    expect((calls[0].node as { prompt?: string }).prompt).toBe("Greet the user.");
    expect(calls[0].ctx.resolvedBody).toBe("Greet the user.");
    expect((calls[0].node as { model?: string }).model).toBe("copilot/gpt-5-mini");
  });

  test("rejects invalid command names without touching the prompt handler", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "keelson-cmd-"));
    const { handler: promptHandler, calls } = makeRecorderHandler();
    const handler = makeCommandHandler({ promptHandler });
    const node = { id: "bad", command: "../etc/passwd" } as unknown as DagNode;
    const result = await handler.handle(node, buildCtx(cwd));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("invalid command name");
    expect(calls).toHaveLength(0);
  });

  test("fails clearly when the command file does not exist", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "keelson-cmd-"));
    const { handler: promptHandler, calls } = makeRecorderHandler();
    const handler = makeCommandHandler({ promptHandler });
    const node = { id: "missing", command: "nope" } as unknown as DagNode;
    const result = await handler.handle(node, buildCtx(cwd));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("not found");
    expect(calls).toHaveLength(0);
  });

  test("propagates a prompt handler failure verbatim", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "keelson-cmd-"));
    await mkdir(join(cwd, ".keelson/commands"), { recursive: true });
    await writeFile(join(cwd, ".keelson/commands/echo.md"), "say hi");
    const promptHandler: NodeHandler = {
      type: "prompt",
      async handle() {
        return {
          status: "failed",
          output: { kind: "text", text: "" },
          error: "provider rate limit",
        };
      },
    };
    const handler = makeCommandHandler({ promptHandler });
    const node = { id: "echo", command: "echo" } as unknown as DagNode;
    const result = await handler.handle(node, buildCtx(cwd));
    expect(result.status).toBe("failed");
    expect(result.error).toBe("provider rate limit");
  });

  test("substitutes $ARGUMENTS / $inputs.* / $X.output inside the command file body", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "keelson-cmd-"));
    await mkdir(join(cwd, ".keelson/commands"), { recursive: true });
    await writeFile(
      join(cwd, ".keelson/commands/echoer.md"),
      "args=$ARGUMENTS lane=$inputs.lane prior=$producer.output",
    );
    const { handler: promptHandler, calls } = makeRecorderHandler();
    const handler = makeCommandHandler({ promptHandler });
    const ctx: NodeContext = {
      ...buildCtx(cwd),
      inputs: { ARGUMENTS: "from-user", lane: "stable" },
      upstreamOutputs: new Map([
        [
          "producer",
          {
            state: "completed",
            output: "upstream-text",
            startedAt: "2026-01-01T00:00:00.000Z",
            completedAt: "2026-01-01T00:00:00.000Z",
            durationMs: 0,
          },
        ],
      ]),
    };
    const node = { id: "cmd", command: "echoer" } as unknown as DagNode;
    await handler.handle(node, ctx);
    expect(calls).toHaveLength(1);
    expect((calls[0].node as { prompt?: string }).prompt).toBe(
      "args=from-user lane=stable prior=upstream-text",
    );
    expect(calls[0].ctx.resolvedBody).toBe("args=from-user lane=stable prior=upstream-text");
  });

  test("substitutes $converge.round inside the command file body", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "keelson-cmd-"));
    await mkdir(join(cwd, ".keelson/commands"), { recursive: true });
    await writeFile(join(cwd, ".keelson/commands/round.md"), "round=$converge.round");
    const { handler: promptHandler, calls } = makeRecorderHandler();
    const handler = makeCommandHandler({ promptHandler });
    const ctx: NodeContext = { ...buildCtx(cwd), convergeRound: 3 };
    const node = { id: "cmd", command: "round" } as unknown as DagNode;
    await handler.handle(node, ctx);
    expect(calls).toHaveLength(1);
    expect((calls[0].node as { prompt?: string }).prompt).toBe("round=3");
    expect(calls[0].ctx.resolvedBody).toBe("round=3");
  });
});
