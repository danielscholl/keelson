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
import type { NodeContext, NodeStreamEvent } from "../executor.ts";
import type { DagNode, NodeOutput, WorkflowDefinition } from "../schema/index.ts";
import {
  DEFAULT_TOOL_DENYLIST,
  makePromptHandler,
  type PromptHandlerProvider,
  type PromptHandlerSendOptions,
} from "./prompt.ts";

interface SpyCall {
  prompt: string;
  cwd: string;
  options: PromptHandlerSendOptions | undefined;
}

interface SpyProviderOptions {
  chunks?: unknown[];
  throwAt?: number;
  throwError?: Error;
  chunkDelayMs?: number;
  // Slice 4 — when set, makeSpyProvider exposes `getType()` returning this
  // string so the handler's provider-mismatch check has a value to inspect.
  // Omit to keep the structural-subset behavior used by existing tests.
  type?: string;
}

function makeSpyProvider(opts: SpyProviderOptions = {}): {
  provider: PromptHandlerProvider;
  calls: SpyCall[];
} {
  const calls: SpyCall[] = [];
  const provider: PromptHandlerProvider = {
    ...(opts.type !== undefined ? { getType: () => opts.type! } : {}),
    async *sendQuery(prompt, cwd, _resume, options) {
      calls.push({ prompt, cwd, options });
      const chunks = opts.chunks ?? [];
      for (let i = 0; i < chunks.length; i++) {
        if (opts.throwAt !== undefined && i === opts.throwAt) {
          throw opts.throwError ?? new Error("spy: synthetic provider failure");
        }
        if (opts.chunkDelayMs && opts.chunkDelayMs > 0) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, opts.chunkDelayMs);
            options?.abortSignal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(new DOMException("aborted", "AbortError"));
              },
              { once: true },
            );
          });
        }
        if (options?.abortSignal?.aborted) {
          throw new DOMException("aborted", "AbortError");
        }
        yield chunks[i];
      }
    },
  };
  return { provider, calls };
}

interface BuildCtxOptions {
  resolvedBody?: string;
  abortSignal?: AbortSignal;
  onEvent?: (event: NodeStreamEvent) => void;
  runId?: string;
  nodeId?: string;
  workflowProvider?: string;
}

function buildCtx(opts: BuildCtxOptions = {}): NodeContext {
  const body = opts.resolvedBody ?? "say hi";
  const workflow = {
    name: "test",
    description: "",
    nodes: [],
    ...(opts.workflowProvider !== undefined ? { provider: opts.workflowProvider } : {}),
  } as unknown as WorkflowDefinition;
  return {
    runId: opts.runId ?? "test-run",
    nodeId: opts.nodeId ?? "n1",
    inputs: {},
    upstreamOutputs: new Map<string, NodeOutput>(),
    cwd: process.cwd(),
    abortSignal: opts.abortSignal ?? new AbortController().signal,
    emit: (event) => opts.onEvent?.(event),
    resolvedBody: body,
    rawBody: body,
    workflow,
  };
}

const stubNode = { id: "n1", prompt: "" } as unknown as DagNode;

describe("makePromptHandler", () => {
  test("returns succeeded with accumulated text from a chunk stream", async () => {
    const { provider } = makeSpyProvider({
      chunks: [
        { type: "text", content: "Hello " },
        { type: "text", content: "world" },
        { type: "done" },
      ],
    });
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [],
    });
    const result = await handler.handle(stubNode, buildCtx());
    expect(result.status).toBe("succeeded");
    expect(result.output.kind === "text" ? result.output.text : "").toBe("Hello world");
  });

  test("emits node_chunk events for every non-done chunk", async () => {
    const chunks = [
      { type: "text", content: "a" },
      { type: "tool_use", id: "t1", toolName: "x" },
      { type: "tool_result", toolUseId: "t1", content: "ok" },
      { type: "done" },
    ];
    const { provider } = makeSpyProvider({ chunks });
    const emitted: NodeStreamEvent[] = [];
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [],
    });
    await handler.handle(stubNode, buildCtx({ onEvent: (e) => emitted.push(e) }));
    // `done` is the provider's end-of-turn sentinel and not user-visible
    // content — matches chat-handler.ts which also drops it before
    // emitting. text / tool_use / tool_result are forwarded.
    const chunkEvents = emitted.filter((e) => e.type === "node_chunk");
    expect(chunkEvents).toHaveLength(3);
    expect((chunkEvents[0] as { chunk: { type: string } }).chunk.type).toBe("text");
    expect((chunkEvents[1] as { chunk: { type: string } }).chunk.type).toBe("tool_use");
    expect((chunkEvents[2] as { chunk: { type: string } }).chunk.type).toBe("tool_result");
  });

  test("default denylist is empty — all registered tools pass through to the provider", async () => {
    // Keelson core has no built-in tools; the default denylist is empty so
    // every registered tool reaches the model. Operators install a denylist
    // via KEELSON_WORKFLOW_TOOL_DENYLIST or the `denylist` constructor opt.
    const { provider, calls } = makeSpyProvider({
      chunks: [{ type: "text", content: "" }, { type: "done" }],
    });
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [
        { name: "kube_delete_cluster" },
        { name: "secrets_reveal" },
        { name: "repo_get_kube" },
        { name: "gitlab_list_mrs" },
      ],
    });
    await handler.handle(stubNode, buildCtx());
    expect(calls).toHaveLength(1);
    const toolNames = (calls[0]!.options?.tools ?? []).map((t) => t.name);
    expect(toolNames).toContain("repo_get_kube");
    expect(toolNames).toContain("gitlab_list_mrs");
    expect(toolNames).toContain("kube_delete_cluster");
    expect(toolNames).toContain("secrets_reveal");
    expect(DEFAULT_TOOL_DENYLIST).toEqual([]);
  });

  test("denylist=[] allows all tools through (identical to the default)", async () => {
    const { provider, calls } = makeSpyProvider({
      chunks: [{ type: "text", content: "" }, { type: "done" }],
    });
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [{ name: "kube_delete_cluster" }],
      denylist: [],
    });
    await handler.handle(stubNode, buildCtx());
    const toolNames = (calls[0]!.options?.tools ?? []).map((t) => t.name);
    expect(toolNames).toContain("kube_delete_cluster");
  });

  test("explicit denylist drops named tools from the MCP projection", async () => {
    const { provider, calls } = makeSpyProvider({
      chunks: [{ type: "text", content: "" }, { type: "done" }],
    });
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [{ name: "kube_delete_cluster" }, { name: "repo_get_state" }],
      denylist: ["kube_delete_cluster"],
    });
    await handler.handle(stubNode, buildCtx());
    const toolNames = (calls[0]!.options?.tools ?? []).map((t) => t.name);
    expect(toolNames).not.toContain("kube_delete_cluster");
    expect(toolNames).toContain("repo_get_state");
  });

  test("node.denied_tools unions with the global denylist for MCP filtering and forwards as disallowedTools", async () => {
    const { provider, calls } = makeSpyProvider({
      chunks: [{ type: "text", content: "" }, { type: "done" }],
    });
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [
        { name: "kube_delete_cluster" },
        { name: "repo_get_kube" },
        { name: "repo_get_state" },
        { name: "gitlab_list_mrs" },
      ],
      denylist: ["kube_delete_cluster"],
    });
    const node = {
      id: "n1",
      prompt: "",
      denied_tools: ["repo_get_state"],
    } as unknown as DagNode;
    await handler.handle(node, buildCtx());
    const toolNames = (calls[0]!.options?.tools ?? []).map((t) => t.name);
    // Global denylist drops kube_delete_cluster AND the per-node denial
    // drops repo_get_state from the MCP projection. Everything else passes.
    expect(toolNames).not.toContain("kube_delete_cluster");
    expect(toolNames).not.toContain("repo_get_state");
    expect(toolNames).toContain("repo_get_kube");
    expect(toolNames).toContain("gitlab_list_mrs");
    // SDK-level disallowedTools surfaces verbatim so the SDK can also gate
    // its built-in tools (Read/Write/Bash/…) by the same names.
    expect(calls[0]!.options?.disallowedTools).toEqual(["repo_get_state"]);
    expect(calls[0]!.options?.allowedTools).toBeUndefined();
  });

  test("node.allowed_tools intersects with the global denylist for MCP filtering (operator safety floor wins) and forwards as allowedTools", async () => {
    const { provider, calls } = makeSpyProvider({
      chunks: [{ type: "text", content: "" }, { type: "done" }],
    });
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [
        { name: "kube_delete_cluster" },
        { name: "repo_get_kube" },
        { name: "gitlab_list_mrs" },
      ],
      denylist: ["kube_delete_cluster"],
    });
    // Author lists kube_delete_cluster in allowed_tools but the global
    // denylist is the operator safety floor — it always wins. The MCP
    // projection drops kube_delete_cluster despite the author's allow-list;
    // the SDK-level allowedTools still receives the author-declared set
    // as-is so the SDK can enforce the whitelist on its built-in tools.
    const node = {
      id: "n1",
      prompt: "",
      allowed_tools: ["kube_delete_cluster", "repo_get_kube"],
    } as unknown as DagNode;
    await handler.handle(node, buildCtx());
    const toolNames = (calls[0]!.options?.tools ?? []).map((t) => t.name);
    expect(toolNames).not.toContain("kube_delete_cluster");
    expect(toolNames).toContain("repo_get_kube");
    expect(toolNames).not.toContain("gitlab_list_mrs");
    expect(calls[0]!.options?.allowedTools).toEqual(["kube_delete_cluster", "repo_get_kube"]);
    expect(calls[0]!.options?.disallowedTools).toBeUndefined();
  });

  test("node.allowed_tools = [] forwards an empty whitelist (model gets no tools)", async () => {
    const { provider, calls } = makeSpyProvider({
      chunks: [{ type: "text", content: "" }, { type: "done" }],
    });
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [{ name: "repo_get_kube" }, { name: "gitlab_list_mrs" }],
    });
    const node = {
      id: "n1",
      prompt: "",
      allowed_tools: [],
    } as unknown as DagNode;
    await handler.handle(node, buildCtx());
    // `tools` is omitted entirely when the filtered MCP set is empty — the
    // SDK whitelist below is what enforces "no tools" semantics.
    expect(calls[0]!.options?.tools).toBeUndefined();
    expect(calls[0]!.options?.allowedTools).toEqual([]);
  });

  test("node.allowed_tools accepts SDK-wrapped MCP names (mcp__keelson__X) and still filters the MCP catalog", async () => {
    // Regression: previously the MCP catalog filter compared against the
    // bare registered name, so an author writing the SDK-qualified form
    // would see filteredTools empty and the registered tool would not
    // reach the SDK as an MCP server. We strip the wrapper before the
    // set membership check.
    const { provider, calls } = makeSpyProvider({
      chunks: [{ type: "text", content: "" }, { type: "done" }],
    });
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [{ name: "repo_get_kube" }, { name: "gitlab_list_mrs" }],
    });
    const node = {
      id: "n1",
      prompt: "",
      allowed_tools: ["mcp__keelson__repo_get_kube"],
    } as unknown as DagNode;
    await handler.handle(node, buildCtx());
    const toolNames = (calls[0]!.options?.tools ?? []).map((t) => t.name);
    expect(toolNames).toEqual(["repo_get_kube"]);
    // SDK-side allowedTools keeps the author's literal list — the factory
    // then expands bare names to include the wrapped form; for already-
    // wrapped names there's nothing to expand. (Tested in claude.test.ts.)
    expect(calls[0]!.options?.allowedTools).toEqual(["mcp__keelson__repo_get_kube"]);
  });

  test("node.denied_tools also accepts SDK-wrapped MCP names", async () => {
    const { provider, calls } = makeSpyProvider({
      chunks: [{ type: "text", content: "" }, { type: "done" }],
    });
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [{ name: "repo_get_kube" }, { name: "gitlab_list_mrs" }],
    });
    const node = {
      id: "n1",
      prompt: "",
      denied_tools: ["mcp__keelson__repo_get_kube"],
    } as unknown as DagNode;
    await handler.handle(node, buildCtx());
    const toolNames = (calls[0]!.options?.tools ?? []).map((t) => t.name);
    expect(toolNames).not.toContain("repo_get_kube");
    expect(toolNames).toContain("gitlab_list_mrs");
  });

  test("node.hooks forwards to options.hooks verbatim", async () => {
    const { provider, calls } = makeSpyProvider({
      chunks: [{ type: "text", content: "" }, { type: "done" }],
    });
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [],
    });
    const yamlHooks = {
      PostToolUse: [
        {
          matcher: "Read",
          response: {
            hookSpecificOutput: {
              hookEventName: "PostToolUse",
              additionalContext: "assess what you just read",
            },
          },
        },
      ],
      PreToolUse: [
        {
          matcher: "Bash",
          response: {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: "no shell here",
            },
          },
        },
      ],
    };
    const node = {
      id: "n1",
      prompt: "",
      hooks: yamlHooks,
    } as unknown as DagNode;
    await handler.handle(node, buildCtx());
    // Prompt handler is structurally type-erased on hooks (the projection
    // happens inside the claude provider). It just hands the shape over.
    expect(calls[0]!.options?.hooks).toEqual(yamlHooks);
  });

  test("both allowed_tools and denied_tools set: allow-set wins for MCP, both forwarded to SDK", async () => {
    const { provider, calls } = makeSpyProvider({
      chunks: [{ type: "text", content: "" }, { type: "done" }],
    });
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [{ name: "Read" }, { name: "Write" }, { name: "Bash" }],
    });
    const node = {
      id: "n1",
      prompt: "",
      allowed_tools: ["Read", "Write"],
      denied_tools: ["Write"],
    } as unknown as DagNode;
    await handler.handle(node, buildCtx());
    const toolNames = (calls[0]!.options?.tools ?? []).map((t) => t.name);
    // At the MCP-projection layer the allow-set is sole — denied_tools does
    // not subtract from it here. SDK-side disallowedTools below handles
    // the intersection.
    expect(toolNames).toEqual(["Read", "Write"]);
    expect(calls[0]!.options?.allowedTools).toEqual(["Read", "Write"]);
    expect(calls[0]!.options?.disallowedTools).toEqual(["Write"]);
  });

  test("emits a node_warning when a non-claude provider sees per-node config", async () => {
    const { provider } = makeSpyProvider({
      chunks: [{ type: "text", content: "" }, { type: "done" }],
      type: "stub",
    });
    const emitted: NodeStreamEvent[] = [];
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [],
    });
    const node = {
      id: "n1",
      prompt: "",
      denied_tools: ["Bash"],
      hooks: {
        PostToolUse: [{ matcher: "Read", response: { ok: true } }],
      },
    } as unknown as DagNode;
    await handler.handle(node, buildCtx({ onEvent: (e) => emitted.push(e) }));
    const warnings = emitted.filter(
      (e): e is { type: "node_warning"; message: string } => e.type === "node_warning",
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain("stub");
    expect(warnings[0]!.message).toContain("denied_tools");
    expect(warnings[0]!.message).toContain("hooks");
    // allowed_tools wasn't set on this node — make sure the warning only
    // lists the fields that actually appear.
    expect(warnings[0]!.message).not.toContain("allowed_tools");
  });

  test("does NOT emit a node_warning when provider type is claude", async () => {
    const { provider } = makeSpyProvider({
      chunks: [{ type: "text", content: "" }, { type: "done" }],
      type: "claude",
    });
    const emitted: NodeStreamEvent[] = [];
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [],
    });
    const node = {
      id: "n1",
      prompt: "",
      denied_tools: ["Bash"],
    } as unknown as DagNode;
    await handler.handle(node, buildCtx({ onEvent: (e) => emitted.push(e) }));
    expect(emitted.some((e) => e.type === "node_warning")).toBe(false);
  });

  test("does NOT emit a node_warning when node has no per-node config (regardless of provider)", async () => {
    const { provider } = makeSpyProvider({
      chunks: [{ type: "text", content: "" }, { type: "done" }],
      type: "stub",
    });
    const emitted: NodeStreamEvent[] = [];
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [],
    });
    await handler.handle(stubNode, buildCtx({ onEvent: (e) => emitted.push(e) }));
    expect(emitted.some((e) => e.type === "node_warning")).toBe(false);
  });

  test("preflight that throws (provider deregistered) does NOT leak — handler returns a failed NodeResult", async () => {
    // Regression: previously, a throwing `getProvider()` in the preflight
    // path escaped before the timer was cleared and `afterNode` ran. The
    // fix wraps the preflight in try/catch so the real failure surfaces
    // inside consume(), which has the proper cleanup.
    let getProviderCalls = 0;
    const failingProvider: PromptHandlerProvider = {
      async *sendQuery() {
        // consume() reaches this on the SECOND call (preflight was the
        // first, throw on the second so the real path observes the
        // failure with proper cleanup).
        yield { type: "error", message: "provider deregistered" };
      },
      getType: () => "claude",
    };
    const handler = makePromptHandler({
      getProvider: () => {
        getProviderCalls++;
        if (getProviderCalls === 1) {
          throw new Error("provider deregistered (preflight)");
        }
        return failingProvider;
      },
      getRegisteredTools: () => [],
    });
    const node = {
      id: "n1",
      prompt: "",
      denied_tools: ["Bash"],
    } as unknown as DagNode;
    // The contract: handle() always returns a NodeResult, never throws.
    const result = await handler.handle(node, buildCtx());
    expect(result.status).toBe("failed");
  });

  test("skips the mismatch warning when the provider doesn't expose getType()", async () => {
    // Existing structural spies without `getType` should keep working
    // without spurious warnings. The handler's defensive check guards
    // against this case.
    const { provider } = makeSpyProvider({
      chunks: [{ type: "text", content: "" }, { type: "done" }],
    });
    const emitted: NodeStreamEvent[] = [];
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [],
    });
    const node = {
      id: "n1",
      prompt: "",
      denied_tools: ["Bash"],
    } as unknown as DagNode;
    await handler.handle(node, buildCtx({ onEvent: (e) => emitted.push(e) }));
    expect(emitted.some((e) => e.type === "node_warning")).toBe(false);
  });

  test("aborts when ctx.abortSignal fires mid-stream — status=failed, error=aborted", async () => {
    const ctlr = new AbortController();
    const { provider } = makeSpyProvider({
      chunks: [
        { type: "text", content: "first" },
        { type: "text", content: "second" },
        { type: "text", content: "third" },
        { type: "done" },
      ],
      chunkDelayMs: 50,
    });
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [],
    });
    // Fire abort after the first chunk has plausibly landed.
    setTimeout(() => ctlr.abort(), 25);
    const result = await handler.handle(stubNode, buildCtx({ abortSignal: ctlr.signal }));
    expect(result.status).toBe("failed");
    expect(result.error).toBe("aborted");
  });

  test("aborts cleanly when ctx.abortSignal was already fired", async () => {
    const ctlr = new AbortController();
    ctlr.abort();
    const { provider } = makeSpyProvider({
      chunks: [{ type: "text", content: "should not see" }, { type: "done" }],
    });
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [],
    });
    const result = await handler.handle(stubNode, buildCtx({ abortSignal: ctlr.signal }));
    expect(result.status).toBe("failed");
    expect(result.error).toBe("aborted");
  });

  test("times out — status=failed, error=prompt timeout after Ns", async () => {
    const { provider } = makeSpyProvider({
      chunks: [{ type: "text", content: "slow" }, { type: "done" }],
      chunkDelayMs: 500,
    });
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [],
      timeoutMs: 50,
    });
    const result = await handler.handle(stubNode, buildCtx());
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/^prompt timeout after \d+s$/);
  });

  test("propagates provider throw as failed.error", async () => {
    const { provider } = makeSpyProvider({
      chunks: [
        { type: "text", content: "ok" },
        { type: "text", content: "" },
      ],
      throwAt: 1,
      throwError: new Error("upstream provider exploded"),
    });
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [],
    });
    const result = await handler.handle(stubNode, buildCtx());
    expect(result.status).toBe("failed");
    expect(result.error).toBe("upstream provider exploded");
    // The text accumulated before the throw is preserved so a partial run
    // is at least inspectable.
    expect(result.output.kind === "text" ? result.output.text : "").toBe("ok");
  });

  test("captures provider error chunk into NodeResult.error", async () => {
    const { provider } = makeSpyProvider({
      chunks: [
        { type: "text", content: "partial" },
        { type: "error", message: "rate limited" },
        { type: "done" },
      ],
    });
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [],
    });
    const result = await handler.handle(stubNode, buildCtx());
    expect(result.status).toBe("failed");
    expect(result.error).toBe("rate limited");
    expect(result.output.kind === "text" ? result.output.text : "").toBe("partial");
  });

  test("lifecycle hooks fire on success and receive node + result", async () => {
    const before: Array<{ runId: string; nodeId: string }> = [];
    const after: Array<{ runId: string; nodeId: string; status: string }> = [];
    const { provider } = makeSpyProvider({
      chunks: [{ type: "text", content: "yo" }, { type: "done" }],
    });
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [],
      lifecycle: {
        beforeNode: (ctx) => {
          before.push({ runId: ctx.runId, nodeId: ctx.nodeId });
        },
        afterNode: (ctx, result) => {
          after.push({
            runId: ctx.runId,
            nodeId: ctx.nodeId,
            status: result.status,
          });
        },
      },
    });
    await handler.handle(stubNode, buildCtx({ runId: "r-7", nodeId: "summarize" }));
    expect(before).toEqual([{ runId: "r-7", nodeId: "summarize" }]);
    expect(after).toEqual([{ runId: "r-7", nodeId: "summarize", status: "succeeded" }]);
  });

  test("lifecycle hook throws — swallowed, node still completes", async () => {
    const { provider } = makeSpyProvider({
      chunks: [{ type: "text", content: "ok" }, { type: "done" }],
    });
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [],
      lifecycle: {
        beforeNode: () => {
          throw new Error("memory unavailable");
        },
        afterNode: () => {
          throw new Error("memory writeback failed");
        },
      },
    });
    const result = await handler.handle(stubNode, buildCtx());
    // Hook failures must NOT take the run down — the seam is best-effort
    // per the W5 forward-compat contract (Phase 4.5 memory layer plugs in
    // here and any storage hiccup must degrade gracefully).
    expect(result.status).toBe("succeeded");
    expect(result.output.kind === "text" ? result.output.text : "").toBe("ok");
  });

  test("per-node model: field on the node passes through to options.model", async () => {
    const { provider, calls } = makeSpyProvider({
      chunks: [{ type: "text", content: "" }, { type: "done" }],
    });
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [],
    });
    const nodeWithModel = {
      id: "n1",
      prompt: "",
      model: "gpt-5-3-mini",
    } as unknown as DagNode;
    await handler.handle(nodeWithModel, buildCtx());
    expect(calls[0]!.options?.model).toBe("gpt-5-3-mini");
  });

  test("times out even when the provider ignores its abortSignal (hung provider)", async () => {
    // Adversarial provider: parks forever on the first `next()` and does
    // NOT observe its options.abortSignal. Mimics a misbehaving SDK whose
    // internal HTTP socket call doesn't propagate cancel. Without the
    // handler racing against an external timeout promise, handle() would
    // hang forever and the workflow_runs row would stay 'running'.
    const hungProvider: PromptHandlerProvider = {
      async *sendQuery() {
        await new Promise<void>(() => {
          /* never resolves; ignores abort */
        });
      },
    };
    const handler = makePromptHandler({
      getProvider: () => hungProvider,
      getRegisteredTools: () => [],
      timeoutMs: 40,
    });
    const startMs = Date.now();
    const result = await handler.handle(stubNode, buildCtx());
    const elapsedMs = Date.now() - startMs;
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/^prompt timeout after \d+s$/);
    // Bounded return time: well below 5x the timeout under normal load.
    expect(elapsedMs).toBeLessThan(500);
  });

  test("survives async rejection from iterator.return() cleanup on timeout", async () => {
    // Adversarial provider: yields once, then its next() parks forever, and
    // its return() rejects asynchronously when the handler tries to clean up
    // (mimics an SDK whose teardown hits a downed network or a release that
    // rejects). handle() must return with the timeout result and the
    // rejected cleanup promise must NOT escape as an unhandled rejection
    // after handle() has returned.
    //
    // A plain `async function*` generator cannot model this — its return()
    // runs the finally block, but a finally that awaits a rejected promise
    // would propagate through return() in a runtime-specific way. A
    // hand-built AsyncIterator is deterministic: its return() simply
    // rejects, which is exactly the surface we want to exercise.
    let returnCalled = false;
    let unhandled: unknown = null;
    const onUnhandled = (reason: unknown): void => {
      unhandled = reason;
    };
    // Bun's process is Node-compatible — `unhandledRejection` fires when a
    // Promise rejects without a handler.
    process.on("unhandledRejection", onUnhandled);
    try {
      const adversarial: PromptHandlerProvider = {
        sendQuery() {
          let yielded = false;
          const iter: AsyncIterator<unknown> = {
            next() {
              if (!yielded) {
                yielded = true;
                return Promise.resolve({
                  value: { type: "text", content: "first" },
                  done: false,
                });
              }
              // Park forever; ignores abort.
              return new Promise(() => undefined);
            },
            return(): Promise<IteratorResult<unknown>> {
              returnCalled = true;
              return Promise.reject(new Error("adversarial cleanup rejected"));
            },
          };
          return {
            [Symbol.asyncIterator]() {
              return iter;
            },
            next: iter.next.bind(iter),
            return: iter.return!.bind(iter),
          } as unknown as AsyncGenerator<unknown>;
        },
      };
      const handler = makePromptHandler({
        getProvider: () => adversarial,
        getRegisteredTools: () => [],
        timeoutMs: 40,
      });
      const result = await handler.handle(stubNode, buildCtx());
      expect(result.status).toBe("failed");
      expect(result.error).toMatch(/^prompt timeout after \d+s$/);
      // Yield so the iterator.return-driven rejection has time to surface.
      await new Promise((r) => setTimeout(r, 100));
      // The handler must have called return() on timeout — confirms the
      // cleanup catch path was actually exercised.
      expect(returnCalled).toBe(true);
      expect(unhandled).toBeNull();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("cleans up the iterator on non-abort consume exit (ctx.emit throws)", async () => {
    // If the consumer throws while handling a yielded chunk (synthetic here
    // via a poisoned ctx.emit, realistic when downstream consumer code
    // fails), the abort listener never fires. The handler must still call
    // iterator.return() in consume's finally so provider sessions / network
    // resources don't leak open.
    let returnCalled = false;
    const provider: PromptHandlerProvider = {
      sendQuery() {
        let yielded = false;
        const iter: AsyncIterator<unknown> = {
          next() {
            if (!yielded) {
              yielded = true;
              return Promise.resolve({
                value: { type: "text", content: "x" },
                done: false,
              });
            }
            // Park if we ever get past the failing emit.
            return new Promise(() => undefined);
          },
          return(): Promise<IteratorResult<unknown>> {
            returnCalled = true;
            return Promise.resolve({ value: undefined, done: true });
          },
        };
        return {
          [Symbol.asyncIterator]() {
            return iter;
          },
          next: iter.next.bind(iter),
          return: iter.return!.bind(iter),
        } as unknown as AsyncGenerator<unknown>;
      },
    };
    const ctx = buildCtx({
      onEvent: () => {
        throw new Error("poisoned emit");
      },
    });
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [],
    });
    const result = await handler.handle(stubNode, ctx);
    // The throw flows through the handler's try/catch, marking the run failed.
    expect(result.status).toBe("failed");
    expect(result.error).toBe("poisoned emit");
    expect(returnCalled).toBe(true);
  });

  test("preserves normalized error chunk over a raw throw that follows it", async () => {
    // Provider that emits a normalized "error" chunk and then throws — common
    // shape for SDK paths that surface a user-friendly message in-band, then
    // raise an internal error during teardown. The user-facing message is the
    // one we want on NodeResult.error.
    const { provider } = makeSpyProvider({
      chunks: [
        { type: "text", content: "partial" },
        { type: "error", message: "rate limited (please retry)" },
        { type: "text", content: "this would never arrive" },
      ],
      throwAt: 2,
      throwError: new Error("internal: connection reset"),
    });
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [],
    });
    const result = await handler.handle(stubNode, buildCtx());
    expect(result.status).toBe("failed");
    // The friendlier normalized message wins, not the raw thrown one.
    expect(result.error).toBe("rate limited (please retry)");
  });

  test("passes ctx.resolvedBody as the prompt (substitution already happened in executor)", async () => {
    const { provider, calls } = makeSpyProvider({
      chunks: [{ type: "text", content: "" }, { type: "done" }],
    });
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [],
    });
    await handler.handle(stubNode, buildCtx({ resolvedBody: "Summarize: hello world" }));
    expect(calls[0]!.prompt).toBe("Summarize: hello world");
  });

  test("getProvider receives node.provider when set (node overrides workflow)", async () => {
    const { provider } = makeSpyProvider({
      chunks: [{ type: "text", content: "" }, { type: "done" }],
    });
    const requested: (string | undefined)[] = [];
    const handler = makePromptHandler({
      getProvider: (id) => {
        requested.push(id);
        return provider;
      },
      getRegisteredTools: () => [],
    });
    const node = { id: "n1", prompt: "", provider: "copilot" } as unknown as DagNode;
    await handler.handle(node, buildCtx({ workflowProvider: "claude" }));
    // Both call sites (preflight getType + consume sendQuery) should receive
    // the resolved effective id — node.provider wins over workflow.provider.
    expect(requested.every((id) => id === "copilot")).toBe(true);
    expect(requested.length).toBeGreaterThan(0);
  });

  test("getProvider receives ctx.workflow.provider when node.provider is unset", async () => {
    const { provider } = makeSpyProvider({
      chunks: [{ type: "text", content: "" }, { type: "done" }],
    });
    const requested: (string | undefined)[] = [];
    const handler = makePromptHandler({
      getProvider: (id) => {
        requested.push(id);
        return provider;
      },
      getRegisteredTools: () => [],
    });
    await handler.handle(stubNode, buildCtx({ workflowProvider: "copilot" }));
    expect(requested.every((id) => id === "copilot")).toBe(true);
  });

  test("getProvider receives undefined when neither node nor workflow set provider", async () => {
    const { provider } = makeSpyProvider({
      chunks: [{ type: "text", content: "" }, { type: "done" }],
    });
    const requested: (string | undefined)[] = [];
    const handler = makePromptHandler({
      getProvider: (id) => {
        requested.push(id);
        return provider;
      },
      getRegisteredTools: () => [],
    });
    await handler.handle(stubNode, buildCtx());
    expect(requested.every((id) => id === undefined)).toBe(true);
  });

  test("getProvider throwing on an unknown id surfaces as a failed NodeResult", async () => {
    // Mirrors the bootstrap.ts behavior: an unknown provider id throws with a
    // clean "not registered" message inside the resolver. The preflight catch
    // swallows it; consume() hits the same throw and turns it into the node's
    // error. End result: failed NodeResult with the registry message.
    const handler = makePromptHandler({
      getProvider: (id) => {
        throw new Error(`Provider '${id}' is not registered. Available: stub, copilot`);
      },
      getRegisteredTools: () => [],
    });
    const node = { id: "n1", prompt: "", provider: "not-a-real-provider" } as unknown as DagNode;
    const result = await handler.handle(node, buildCtx());
    expect(result.status).toBe("failed");
    expect(result.error).toContain("not-a-real-provider");
    expect(result.error).toContain("not registered");
  });

  describe("output_format", () => {
    test("appends the schema instruction to the prompt sent to the provider", async () => {
      const { provider, calls } = makeSpyProvider({
        chunks: [{ type: "text", content: '{"kind":"bug"}' }, { type: "done" }],
      });
      const handler = makePromptHandler({
        getProvider: () => provider,
        getRegisteredTools: () => [],
      });
      const node = {
        id: "n1",
        prompt: "",
        output_format: {
          type: "object",
          properties: { kind: { type: "string" } },
          required: ["kind"],
        },
      } as unknown as DagNode;
      await handler.handle(node, buildCtx({ resolvedBody: "classify this" }));
      expect(calls).toHaveLength(1);
      const sent = calls[0]!.prompt;
      expect(sent.startsWith("classify this")).toBe(true);
      expect(sent).toContain("ONLY a single-line JSON object");
      expect(sent).toContain('"type":"object"');
    });

    test("no suffix is appended when output_format is unset", async () => {
      const { provider, calls } = makeSpyProvider({
        chunks: [{ type: "text", content: "hi" }, { type: "done" }],
      });
      const handler = makePromptHandler({
        getProvider: () => provider,
        getRegisteredTools: () => [],
      });
      await handler.handle(stubNode, buildCtx({ resolvedBody: "say hi" }));
      expect(calls[0]!.prompt).toBe("say hi");
    });

    test("clean JSON reply is normalized as the node output", async () => {
      const { provider } = makeSpyProvider({
        chunks: [{ type: "text", content: '  {"kind":"bug","title":"oops"}  ' }, { type: "done" }],
      });
      const handler = makePromptHandler({
        getProvider: () => provider,
        getRegisteredTools: () => [],
      });
      const node = {
        id: "n1",
        prompt: "",
        output_format: { type: "object", properties: { kind: { type: "string" } } },
      } as unknown as DagNode;
      const result = await handler.handle(node, buildCtx());
      expect(result.status).toBe("succeeded");
      const text = result.output.kind === "text" ? result.output.text : "";
      expect(text).toBe('{"kind":"bug","title":"oops"}');
    });

    test("fenced JSON reply has fences stripped before being committed", async () => {
      const { provider } = makeSpyProvider({
        chunks: [{ type: "text", content: '```json\n{"kind":"feature"}\n```' }, { type: "done" }],
      });
      const handler = makePromptHandler({
        getProvider: () => provider,
        getRegisteredTools: () => [],
      });
      const node = {
        id: "n1",
        prompt: "",
        output_format: { type: "object" },
      } as unknown as DagNode;
      const result = await handler.handle(node, buildCtx());
      const text = result.output.kind === "text" ? result.output.text : "";
      expect(text).toBe('{"kind":"feature"}');
    });

    test("non-JSON reply is preserved as-is (substitute layer's existing failure mode)", async () => {
      const { provider } = makeSpyProvider({
        chunks: [{ type: "text", content: "I think this is a bug." }, { type: "done" }],
      });
      const handler = makePromptHandler({
        getProvider: () => provider,
        getRegisteredTools: () => [],
      });
      const node = {
        id: "n1",
        prompt: "",
        output_format: { type: "object" },
      } as unknown as DagNode;
      const result = await handler.handle(node, buildCtx());
      const text = result.output.kind === "text" ? result.output.text : "";
      expect(text).toBe("I think this is a bug.");
    });
  });
});
