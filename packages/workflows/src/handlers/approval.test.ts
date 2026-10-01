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
import type { NodeContext } from "../executor.ts";
import type { DagNode, WorkflowDefinition } from "../schema/index.ts";
import { type AwaitApproval, makeApprovalHandler } from "./approval.ts";

function buildCtx(opts: { abortSignal?: AbortSignal; resolvedBody?: string }): NodeContext {
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
    expect(result.output.kind === "text" ? result.output.text : "").toBe("narrow the regex first");
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
    await handler.handle(approvalNode, buildCtx({ abortSignal: abort.signal }));
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
    const result = await handler.handle(approvalNode, buildCtx({ abortSignal: abort.signal }));
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
    const promise = handler.handle(approvalNode, buildCtx({ abortSignal: abort.signal }));
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
    await handler.handle(bareNode, buildCtx({ resolvedBody: "plz approve" }));
    expect(seenMessage).toBe("plz approve");
  });
});

// ---------------------------------------------------------------------------
// reviewer
// ---------------------------------------------------------------------------

import type { NodeHandler, NodeResult } from "../executor.ts";
import { parseReviewerVerdict } from "./approval.ts";

function reviewerNode(overrides: Record<string, unknown> = {}): DagNode {
  return {
    id: "review-plan",
    approval: {
      message: "Approve the plan at $ARTIFACTS_DIR/plan.md",
      reviewer: { prompt: "Check $plan.output against the issue.", ...overrides },
    },
  } as unknown as DagNode;
}

// A stand-in for the prompt handler: records what it was asked and replies
// with a canned result.
function stubPromptHandler(reply: NodeResult | (() => never)): {
  handler: NodeHandler;
  calls: { body: string; node: DagNode }[];
} {
  const calls: { body: string; node: DagNode }[] = [];
  return {
    calls,
    handler: {
      type: "prompt",
      async handle(node, ctx) {
        calls.push({ body: ctx.resolvedBody, node });
        if (typeof reply === "function") reply();
        return reply as NodeResult;
      },
    },
  };
}

function verdictReply(value: unknown): NodeResult {
  return {
    status: "succeeded",
    output: { kind: "structured", value },
    usage: { inputTokens: 12, outputTokens: 3 },
    provider: "stub",
    model: "stub-model",
  };
}

describe("makeApprovalHandler — reviewer", () => {
  test("approve at or above min_confidence resolves the gate without pausing", async () => {
    let paused = false;
    const await_: AwaitApproval = async () => {
      paused = true;
      return "human";
    };
    const { handler: prompt, calls } = stubPromptHandler(
      verdictReply({ decision: "approve", confidence: 90, reason: "every criterion is covered" }),
    );
    const answered: unknown[] = [];
    const handler = makeApprovalHandler({
      awaitApproval: await_,
      reviewer: { promptHandler: prompt, onAnswer: (...args) => answered.push(args) },
    });
    const ctx = buildCtx({});
    const result = await handler.handle(reviewerNode(), {
      ...ctx,
      artifactsDir: "/tmp/run-1",
      upstreamOutputs: new Map([["plan", { state: "completed", output: "PLAN TEXT" }]]),
    });
    expect(paused).toBe(false);
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({ kind: "text", text: "every criterion is covered" });
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
    expect(result.provider).toBe("stub");
    expect(answered).toEqual([
      [
        "run-1",
        "review-plan",
        { decision: "approve", confidence: 90, reason: "every criterion is covered" },
      ],
    ]);
    // The reviewer saw the substituted gate message and rubric, pinned to the verdict shape.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toContain("Approve the plan at /tmp/run-1/plan.md");
    expect(calls[0]?.body).toContain("Check PLAN TEXT against the issue.");
    expect(
      (calls[0]?.node as { output_format?: unknown } | undefined)?.output_format,
    ).toBeDefined();
  });

  test("approve below min_confidence pauses for the human with the verdict attached", async () => {
    let seen: unknown;
    const await_: AwaitApproval = async (_r, _n, _m, _s, review) => {
      seen = review;
      return "human says ok";
    };
    const { handler: prompt } = stubPromptHandler(
      verdictReply({ decision: "approve", confidence: 70, reason: "mostly there" }),
    );
    let answered = false;
    const handler = makeApprovalHandler({
      awaitApproval: await_,
      reviewer: {
        promptHandler: prompt,
        onAnswer: () => {
          answered = true;
        },
      },
    });
    const result = await handler.handle(reviewerNode({ min_confidence: 85 }), buildCtx({}));
    expect(answered).toBe(false);
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({ kind: "text", text: "human says ok" });
    expect(seen).toEqual({
      reviewerVerdict: { decision: "approve", confidence: 70, reason: "mostly there" },
    });
  });

  test("a changes decision pauses for the human even at full confidence", async () => {
    let seen: unknown;
    const await_: AwaitApproval = async (_r, _n, _m, _s, review) => {
      seen = review;
      return "fixed";
    };
    const { handler: prompt } = stubPromptHandler(
      verdictReply({
        decision: "changes",
        confidence: 100,
        reason: "criterion 3 has no step",
        changes: "add a step for the migration",
      }),
    );
    const handler = makeApprovalHandler({
      awaitApproval: await_,
      reviewer: { promptHandler: prompt },
    });
    const result = await handler.handle(reviewerNode(), buildCtx({}));
    expect(result.status).toBe("succeeded");
    expect(seen).toEqual({
      reviewerVerdict: {
        decision: "changes",
        confidence: 100,
        reason: "criterion 3 has no step",
        changes: "add a step for the migration",
      },
    });
  });

  test("a malformed verdict pauses for the human and never reads as approval", async () => {
    const seen: unknown[] = [];
    const warnings: string[] = [];
    const await_: AwaitApproval = async (_r, _n, _m, _s, review) => {
      seen.push(review);
      return "human";
    };
    const malformed: unknown[] = [
      { decision: "yes", confidence: 99, reason: "x" },
      { decision: "approve", confidence: 101, reason: "x" },
      { decision: "approve", confidence: 90.5, reason: "x" },
      { decision: "approve", confidence: 90, reason: "   " },
      { decision: "approve", reason: "x" },
      {},
      "approve",
    ];
    for (const value of malformed) {
      const { handler: prompt } = stubPromptHandler(verdictReply(value));
      const handler = makeApprovalHandler({
        awaitApproval: await_,
        reviewer: { promptHandler: prompt, onAnswer: () => warnings.push("ANSWERED") },
      });
      const ctx = buildCtx({});
      const result = await handler.handle(reviewerNode(), {
        ...ctx,
        emit: (event) => {
          if (event.type === "node_warning") warnings.push(event.message);
        },
      });
      expect(result.status).toBe("succeeded");
      expect(result.output).toEqual({ kind: "text", text: "human" });
    }
    expect(seen).toHaveLength(malformed.length);
    for (const review of seen as { reviewerError?: string; reviewerVerdict?: unknown }[]) {
      expect(review.reviewerVerdict).toBeUndefined();
      expect(typeof review.reviewerError).toBe("string");
    }
    expect(warnings).not.toContain("ANSWERED");
    expect(warnings.every((w) => w.startsWith("approval reviewer:"))).toBe(true);
  });

  test("an empty reply and a failed turn both pause for the human", async () => {
    const seen: unknown[] = [];
    const await_: AwaitApproval = async (_r, _n, _m, _s, review) => {
      seen.push(review);
      return "human";
    };
    const empty = stubPromptHandler({ status: "succeeded", output: { kind: "text", text: "" } });
    const failed = stubPromptHandler({
      status: "failed",
      output: { kind: "text", text: "" },
      error: "provider exploded",
    });
    const threw = stubPromptHandler(() => {
      throw new Error("handler threw");
    });
    for (const { handler: prompt } of [empty, failed, threw]) {
      const handler = makeApprovalHandler({
        awaitApproval: await_,
        reviewer: { promptHandler: prompt },
      });
      const result = await handler.handle(reviewerNode(), buildCtx({}));
      expect(result.status).toBe("succeeded");
      expect(result.output).toEqual({ kind: "text", text: "human" });
    }
    expect(seen).toEqual([
      { reviewerError: "reviewer reply was not a JSON verdict" },
      { reviewerError: "provider exploded" },
      { reviewerError: "reviewer turn threw: handler threw" },
    ]);
  });

  test("enabled: false never invokes the reviewer and passes no review to the gate", async () => {
    let seen: unknown = "unset";
    const await_: AwaitApproval = async (_r, _n, _m, _s, review) => {
      seen = review;
      return "human";
    };
    const { handler: prompt, calls } = stubPromptHandler(
      verdictReply({ decision: "approve", confidence: 100, reason: "x" }),
    );
    const handler = makeApprovalHandler({
      awaitApproval: await_,
      reviewer: { promptHandler: prompt, enabled: false },
    });
    const result = await handler.handle(reviewerNode(), buildCtx({}));
    expect(calls).toHaveLength(0);
    expect(seen).toBeUndefined();
    expect(result.output).toEqual({ kind: "text", text: "human" });
  });

  test("no reviewer wiring at all behaves like a plain gate", async () => {
    const await_: AwaitApproval = async () => "human";
    const handler = makeApprovalHandler({ awaitApproval: await_ });
    const result = await handler.handle(reviewerNode(), buildCtx({}));
    expect(result.output).toEqual({ kind: "text", text: "human" });
  });

  test("when: false skips the reviewer; when: true runs it", async () => {
    const { handler: prompt, calls } = stubPromptHandler(
      verdictReply({ decision: "approve", confidence: 95, reason: "fine" }),
    );
    const await_: AwaitApproval = async () => "human";
    const handler = makeApprovalHandler({
      awaitApproval: await_,
      reviewer: { promptHandler: prompt },
    });
    const node = reviewerNode({ when: "$gate-mode.output == 'true'" });
    const off = await handler.handle(node, {
      ...buildCtx({}),
      upstreamOutputs: new Map([["gate-mode", { state: "completed", output: "false\n" }]]),
    });
    expect(calls).toHaveLength(0);
    expect(off.output).toEqual({ kind: "text", text: "human" });

    const on = await handler.handle(node, {
      ...buildCtx({}),
      upstreamOutputs: new Map([["gate-mode", { state: "completed", output: "true\n" }]]),
    });
    expect(calls).toHaveLength(1);
    expect(on.output).toEqual({ kind: "text", text: "fine" });
  });

  test("a malformed when: skips the reviewer with a warning", async () => {
    const { handler: prompt, calls } = stubPromptHandler(
      verdictReply({ decision: "approve", confidence: 95, reason: "fine" }),
    );
    const await_: AwaitApproval = async () => "human";
    const warnings: string[] = [];
    const handler = makeApprovalHandler({
      awaitApproval: await_,
      reviewer: { promptHandler: prompt },
    });
    const result = await handler.handle(reviewerNode({ when: "not a condition" }), {
      ...buildCtx({}),
      emit: (event) => {
        if (event.type === "node_warning") warnings.push(event.message);
      },
    });
    expect(calls).toHaveLength(0);
    expect(result.output).toEqual({ kind: "text", text: "human" });
    expect(warnings).toEqual([
      "malformed reviewer.when: not a condition; the gate goes to the operator",
    ]);
  });

  test("a cancel during the reviewer turn fails the node as aborted", async () => {
    const abort = new AbortController();
    const prompt: NodeHandler = {
      type: "prompt",
      async handle() {
        abort.abort();
        return { status: "failed", output: { kind: "text", text: "" }, error: "cancelled" };
      },
    };
    let paused = false;
    const await_: AwaitApproval = async () => {
      paused = true;
      return "human";
    };
    const handler = makeApprovalHandler({
      awaitApproval: await_,
      reviewer: { promptHandler: prompt },
    });
    const result = await handler.handle(reviewerNode(), buildCtx({ abortSignal: abort.signal }));
    expect(paused).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.error).toBe("aborted");
  });
});

describe("parseReviewerVerdict", () => {
  test("accepts the exact shape and trims text", () => {
    expect(
      parseReviewerVerdict({
        decision: "changes",
        confidence: 60,
        reason: "  missing step ",
        changes: " add it ",
      }),
    ).toEqual({
      ok: true,
      verdict: { decision: "changes", confidence: 60, reason: "missing step", changes: "add it" },
    });
    expect(
      parseReviewerVerdict({ decision: "approve", confidence: 0, reason: "r", changes: "" }),
    ).toEqual({ ok: true, verdict: { decision: "approve", confidence: 0, reason: "r" } });
  });

  test("rejects every departure from the shape", () => {
    const rejected = [
      null,
      [],
      { decision: "approve", confidence: "90", reason: "r" },
      { decision: "approve", confidence: -1, reason: "r" },
      { decision: "approve", confidence: 50, reason: 7 },
      { decision: "escalate", confidence: 50, reason: "" },
      { decision: "approve", confidence: 50, reason: "r", changes: 3 },
    ];
    for (const value of rejected) {
      const parsed = parseReviewerVerdict(value);
      expect(parsed.ok).toBe(false);
    }
  });
});
