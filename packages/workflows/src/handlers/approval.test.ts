// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";

import { makeApprovalHandler, type AwaitApproval } from "./approval.ts";
import type { NodeContext } from "../executor.ts";
import type { DagNode, WorkflowDefinition } from "../schema/index.ts";

function buildCtx(opts: {
  abortSignal?: AbortSignal;
  resolvedBody?: string;
}): NodeContext {
  return {
    runId: "run-1",
    nodeId: "review-plan",
    inputs: {},
    upstreamOutputs: new Map(),
    cwd: process.cwd(),
    abortSignal: opts.abortSignal ?? new AbortController().signal,
    emit: () => undefined,
    resolvedBody: opts.resolvedBody ?? "",
    rawBody: opts.resolvedBody ?? "",
    workflow: {
      name: "t",
      description: "",
      nodes: [],
    } as unknown as WorkflowDefinition,
  };
}

const approvalNode = {
  id: "review-plan",
  approval: { message: "Review the plan above." },
} as unknown as DagNode;

describe("makeApprovalHandler", () => {
  test("returns the resolver's reply as the node output", async () => {
    const await_: AwaitApproval = async (_runId, _nodeId, message) => {
      expect(message).toBe("Review the plan above.");
      return "approve";
    };
    const handler = makeApprovalHandler({ awaitApproval: await_ });
    const result = await handler.handle(approvalNode, buildCtx({}));
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({ kind: "text", text: "approve" });
  });

  test("free-form reply lands verbatim as output text", async () => {
    const await_: AwaitApproval = async () => "narrow the regex first";
    const handler = makeApprovalHandler({ awaitApproval: await_ });
    const result = await handler.handle(approvalNode, buildCtx({}));
    expect(result.status).toBe("succeeded");
    expect(result.output.kind === "text" ? result.output.text : "").toBe(
      "narrow the regex first",
    );
  });

  test("propagates the runId / nodeId / abortSignal into the resolver", async () => {
    const abort = new AbortController();
    const captured: {
      runId?: string;
      nodeId?: string;
      sig?: AbortSignal;
    } = {};
    const await_: AwaitApproval = async (runId, nodeId, _msg, sig) => {
      captured.runId = runId;
      captured.nodeId = nodeId;
      captured.sig = sig;
      return "ok";
    };
    const handler = makeApprovalHandler({ awaitApproval: await_ });
    await handler.handle(
      approvalNode,
      buildCtx({ abortSignal: abort.signal }),
    );
    expect(captured.runId).toBe("run-1");
    expect(captured.nodeId).toBe("review-plan");
    expect(captured.sig).toBe(abort.signal);
  });

  test("aborted-on-entry short-circuits without invoking awaitApproval", async () => {
    const abort = new AbortController();
    abort.abort();
    let called = false;
    const await_: AwaitApproval = async () => {
      called = true;
      return "should-not-happen";
    };
    const handler = makeApprovalHandler({ awaitApproval: await_ });
    const result = await handler.handle(
      approvalNode,
      buildCtx({ abortSignal: abort.signal }),
    );
    expect(called).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.error).toBe("aborted");
  });

  test("rejection during pause surfaces as failed; abort wins error label", async () => {
    const abort = new AbortController();
    const await_: AwaitApproval = async (_r, _n, _m, sig) =>
      new Promise<string>((_resolve, reject) => {
        sig.addEventListener("abort", () => reject(new Error("cancelled")));
      });
    const handler = makeApprovalHandler({ awaitApproval: await_ });
    const promise = handler.handle(
      approvalNode,
      buildCtx({ abortSignal: abort.signal }),
    );
    abort.abort("cancelled via DELETE");
    const result = await promise;
    expect(result.status).toBe("failed");
    // ctx.abortSignal.aborted is true → error normalizes to "aborted" so the
    // run-status compute treats this as a clean cancellation rather than a
    // generic handler crash.
    expect(result.error).toBe("aborted");
  });

  test("non-abort rejection surfaces the resolver's error text", async () => {
    const await_: AwaitApproval = async () => {
      throw new Error("resolver exploded");
    };
    const handler = makeApprovalHandler({ awaitApproval: await_ });
    const result = await handler.handle(approvalNode, buildCtx({}));
    expect(result.status).toBe("failed");
    expect(result.error).toBe("resolver exploded");
  });

  test("falls back to resolvedBody when node.approval is absent (defensive)", async () => {
    let seenMessage = "";
    const await_: AwaitApproval = async (_r, _n, msg) => {
      seenMessage = msg;
      return "ok";
    };
    const handler = makeApprovalHandler({ awaitApproval: await_ });
    // A node without an `approval` block shouldn't reach the handler in
    // practice (loader rejects malformed nodes), but the defensive fallback
    // surfaces the executor's resolvedBody so test rigs don't need to build
    // a full ApprovalNode just to exercise the resolver wiring.
    const bareNode = { id: "review" } as unknown as DagNode;
    await handler.handle(
      bareNode,
      buildCtx({ resolvedBody: "plz approve" }),
    );
    expect(seenMessage).toBe("plz approve");
  });
});
