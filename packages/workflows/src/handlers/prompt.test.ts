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
import type { NodeContext, NodeStreamEvent, NotebookAdapter } from "../executor.ts";
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
  // When set, makeSpyProvider exposes `getType()` returning this
  // string so the handler's provider-mismatch check has a value to inspect.
  // Omit to keep the structural-subset behavior used by existing tests.
  type?: string;
  // When set, makeSpyProvider exposes `getCapabilities()` returning this
  // shape so the model-resolution chain can fall through to a provider
  // default. Omit to keep the prior structural-subset behavior.
  capabilities?: { defaultModel?: string };
}

function makeSpyProvider(opts: SpyProviderOptions = {}): {
  provider: PromptHandlerProvider;
  calls: SpyCall[];
} {
  const calls: SpyCall[] = [];
  const provider: PromptHandlerProvider = {
    ...(opts.type !== undefined ? { getType: () => opts.type! } : {}),
    ...(opts.capabilities !== undefined ? { getCapabilities: () => opts.capabilities! } : {}),
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
  workflowModel?: string;
  notebook?: NotebookAdapter;
}

function buildCtx(opts: BuildCtxOptions = {}): NodeContext {
  const body = opts.resolvedBody ?? "say hi";
  const workflow = {
    name: "test",
    description: "",
    nodes: [],
    ...(opts.workflowProvider !== undefined ? { provider: opts.workflowProvider } : {}),
    ...(opts.workflowModel !== undefined ? { model: opts.workflowModel } : {}),
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
    ...(opts.notebook !== undefined ? { notebook: opts.notebook } : {}),
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

  test("requestGate deny fails the node before opening a provider session", async () => {
    const { provider, calls } = makeSpyProvider({
      chunks: [{ type: "text", content: "should not run" }, { type: "done" }],
    });
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [],
      requestGate: async () => ({
        outcome: "deny",
        reason: "session token budget reached; switch to a cheaper model to continue",
      }),
    });
    const result = await handler.handle(stubNode, buildCtx());
    expect(result.status).toBe("failed");
    expect(result.error).toContain("token budget");
    // The provider session is never opened on a deny.
    expect(calls).toHaveLength(0);
  });

  test("requestGate allow runs the node and receives the resolved model + provider", async () => {
    const { provider, calls } = makeSpyProvider({
      chunks: [{ type: "text", content: "ok" }, { type: "done" }],
    });
    let seen: { runId: string; model?: string; provider?: string } | undefined;
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [],
      requestGate: async (ctx, model, prov) => {
        seen = { runId: ctx.runId, model, provider: prov };
        return { outcome: "allow" };
      },
    });
    const node = { id: "n1", prompt: "", model: "claude-sonnet-4-6" } as unknown as DagNode;
    const result = await handler.handle(node, buildCtx({ workflowProvider: "claude" }));
    expect(result.status).toBe("succeeded");
    expect(calls).toHaveLength(1);
    expect(seen).toEqual({ runId: "test-run", model: "claude-sonnet-4-6", provider: "claude" });
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

  test("projectTools is the final global gate — it drops a tool after node resolution", async () => {
    const { provider, calls } = makeSpyProvider({
      chunks: [{ type: "text", content: "" }, { type: "done" }],
    });
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [{ name: "kube_delete_cluster" }, { name: "repo_get_state" }],
      // No handler-level denylist (the engine owns it); the injected gate drops one.
      denylist: [],
      projectTools: async (candidates) =>
        candidates.filter((t) => t.name !== "kube_delete_cluster"),
    });
    await handler.handle(stubNode, buildCtx());
    const toolNames = (calls[0]!.options?.tools ?? []).map((t) => t.name);
    expect(toolNames).not.toContain("kube_delete_cluster");
    expect(toolNames).toContain("repo_get_state");
  });

  test("evaluateToolCall is bound to the node's provider and forwarded to the provider", async () => {
    const { provider, calls } = makeSpyProvider({
      chunks: [{ type: "text", content: "" }, { type: "done" }],
    });
    let seenProvider: string | undefined | "unset" = "unset";
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [{ name: "repo_get_state" }],
      evaluateToolCall: async (_call, prov) => {
        seenProvider = prov;
        return { outcome: "deny", reason: "blocked" };
      },
    });
    await handler.handle(stubNode, buildCtx({ workflowProvider: "claude" }));
    const gate = calls[0]?.options?.evaluateToolCall;
    if (!gate) throw new Error("expected evaluateToolCall to be forwarded to the provider");
    // The provider receives a thunk taking only the call — the provider id is
    // already bound, so routing it reaches the harness gate with that id baked in.
    const decision = await gate({ tool: "repo_get_state", args: { x: 1 } });
    expect(decision).toEqual({ outcome: "deny", reason: "blocked" });
    expect(seenProvider).toBe("claude");
  });

  test("evaluateToolCall is threaded the node's teardown signal so a pending ASK cancels on abort", async () => {
    const { provider, calls } = makeSpyProvider({
      chunks: [{ type: "text", content: "" }, { type: "done" }],
    });
    let seenSignal: AbortSignal | undefined;
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [{ name: "repo_get_state" }],
      evaluateToolCall: async (_call, _prov, signal) => {
        seenSignal = signal;
        return { outcome: "allow" };
      },
    });
    await handler.handle(stubNode, buildCtx());
    const gate = calls[0]?.options?.evaluateToolCall;
    if (!gate) throw new Error("expected evaluateToolCall to be forwarded to the provider");
    await gate({ tool: "repo_get_state", args: { x: 1 } });
    // The bound gate carries the SAME signal the provider stream rides — the
    // handler's run-cancel + node-timeout teardown signal — so an engine `ask`
    // cancels with the turn instead of hanging on the approval timeout.
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal).toBe(calls[0]?.options?.abortSignal);
  });

  test("no evaluateToolCall opt → the provider receives no per-call gate", async () => {
    const { provider, calls } = makeSpyProvider({
      chunks: [{ type: "text", content: "" }, { type: "done" }],
    });
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [{ name: "repo_get_state" }],
    });
    await handler.handle(stubNode, buildCtx());
    expect(calls[0]?.options?.evaluateToolCall).toBeUndefined();
  });

  test("evaluateToolResult is bound to the node's provider and forwarded to the provider", async () => {
    const { provider, calls } = makeSpyProvider({
      chunks: [{ type: "text", content: "" }, { type: "done" }],
    });
    let seenProvider: string | undefined | "unset" = "unset";
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [{ name: "repo_get_state" }],
      evaluateToolResult: async (_call, prov) => {
        seenProvider = prov;
        return { outcome: "allow", data: "redacted" };
      },
    });
    await handler.handle(stubNode, buildCtx({ workflowProvider: "claude" }));
    const gate = calls[0]?.options?.evaluateToolResult;
    if (!gate) throw new Error("expected evaluateToolResult to be forwarded to the provider");
    const decision = await gate({ tool: "repo_get_state", result: "raw" });
    expect(decision).toEqual({ outcome: "allow", data: "redacted" });
    expect(seenProvider).toBe("claude");
  });

  test("no evaluateToolResult opt → the provider receives no per-result gate", async () => {
    const { provider, calls } = makeSpyProvider({
      chunks: [{ type: "text", content: "" }, { type: "done" }],
    });
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [],
    });
    await handler.handle(stubNode, buildCtx());
    expect(calls[0]?.options?.evaluateToolResult).toBeUndefined();
  });

  test("evaluateResponse substitution rewrites the node's output text", async () => {
    const { provider } = makeSpyProvider({
      chunks: [
        { type: "text", content: "the secret is " },
        { type: "text", content: "hunter2" },
        { type: "done" },
      ],
    });
    let seenText: string | undefined;
    let seenProvider: string | undefined;
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [],
      evaluateResponse: async (text, prov) => {
        seenText = text;
        seenProvider = prov;
        return { outcome: "allow", data: text.replace("hunter2", "[REDACTED]") };
      },
    });
    const result = await handler.handle(stubNode, buildCtx({ workflowProvider: "claude" }));
    expect(result.status).toBe("succeeded");
    expect(result.output.kind === "text" ? result.output.text : "").toBe(
      "the secret is [REDACTED]",
    );
    // The gate saw the FULL assembled text and the node's effective provider.
    expect(seenText).toBe("the secret is hunter2");
    expect(seenProvider).toBe("claude");
  });

  test("evaluateResponse deny fails the node with the policy's reason", async () => {
    const { provider } = makeSpyProvider({
      chunks: [{ type: "text", content: "forbidden output" }, { type: "done" }],
    });
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [],
      evaluateResponse: async () => ({ outcome: "deny", reason: "response blocked by policy" }),
    });
    const result = await handler.handle(stubNode, buildCtx());
    expect(result.status).toBe("failed");
    expect(result.error).toBe("response blocked by policy");
  });

  test("evaluateResponse is NOT consulted when the turn already failed", async () => {
    let called = false;
    const { provider } = makeSpyProvider({
      chunks: [{ type: "text", content: "partial" }, { type: "done" }],
      throwAt: 0,
      throwError: new Error("provider exploded"),
    });
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [],
      evaluateResponse: async () => {
        called = true;
        return { outcome: "allow" };
      },
    });
    const result = await handler.handle(stubNode, buildCtx());
    expect(result.status).toBe("failed");
    // A failed turn has no complete response to govern — the gate is skipped.
    expect(called).toBe(false);
  });

  test("a throwing evaluateResponse fails open — the node keeps its output", async () => {
    const { provider } = makeSpyProvider({
      chunks: [{ type: "text", content: "kept" }, { type: "done" }],
    });
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [],
      evaluateResponse: async () => {
        throw new Error("gate fault");
      },
    });
    const result = await handler.handle(stubNode, buildCtx());
    expect(result.status).toBe("succeeded");
    expect(result.output.kind === "text" ? result.output.text : "").toBe("kept");
  });

  test("evaluateResponse still redacts the output of a tool-errored (fail_on_tool_error) node", async () => {
    // The model produced a complete reply, but a tool errored → the node fails.
    // The reply is still recorded as the failed node's output, so the response
    // gate must run and redact it rather than leak the secret.
    const { provider } = makeSpyProvider({
      chunks: [
        { type: "text", content: "the secret is hunter2" },
        { type: "tool_result", toolUseId: "t1", content: "boom", isError: true },
        { type: "done" },
      ],
    });
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [],
      evaluateResponse: async (text) => ({
        outcome: "allow",
        data: text.replace("hunter2", "[REDACTED]"),
      }),
    });
    const node = { id: "n1", prompt: "", fail_on_tool_error: true } as unknown as DagNode;
    const result = await handler.handle(node, buildCtx());
    // Fails on the tool error, but its recorded output is redacted (no leak).
    expect(result.status).toBe("failed");
    expect(result.output.kind === "text" ? result.output.text : "").toBe(
      "the secret is [REDACTED]",
    );
  });

  test("a throwing projectTools gate fails open — node-resolved tools still pass through", async () => {
    const { provider, calls } = makeSpyProvider({
      chunks: [{ type: "text", content: "" }, { type: "done" }],
    });
    // Track invocation so the test proves the gate was actually CALLED and its
    // throw was caught — not merely that the tool survived (which the no-gate
    // path would also satisfy).
    let gateCalled = false;
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [{ name: "repo_get_state" }],
      denylist: [],
      projectTools: async () => {
        gateCalled = true;
        throw new Error("gate fault");
      },
    });
    const result = await handler.handle(stubNode, buildCtx());
    expect(gateCalled).toBe(true);
    expect(result.status).toBe("succeeded");
    const toolNames = (calls[0]!.options?.tools ?? []).map((t) => t.name);
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

  test("defaultOffTools (rib tools) are excluded from a node with no allowed_tools", async () => {
    const { provider, calls } = makeSpyProvider({
      chunks: [{ type: "text", content: "" }, { type: "done" }],
    });
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [{ name: "osdu_quality" }, { name: "repo_get_kube" }],
      defaultOffTools: ["osdu_quality"],
    });
    await handler.handle(stubNode, buildCtx());
    const toolNames = (calls[0]!.options?.tools ?? []).map((t) => t.name);
    // A workflow inherits no rib tool it didn't ask for...
    expect(toolNames).not.toContain("osdu_quality");
    // ...but non-default-off registered tools still pass through.
    expect(toolNames).toContain("repo_get_kube");
  });

  test("a node opts into a defaultOffTool by listing it in allowed_tools", async () => {
    const { provider, calls } = makeSpyProvider({
      chunks: [{ type: "text", content: "" }, { type: "done" }],
    });
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [{ name: "osdu_quality" }, { name: "repo_get_kube" }],
      defaultOffTools: ["osdu_quality"],
    });
    const node = {
      id: "n1",
      prompt: "",
      allowed_tools: ["osdu_quality"],
    } as unknown as DagNode;
    await handler.handle(node, buildCtx());
    const toolNames = (calls[0]!.options?.tools ?? []).map((t) => t.name);
    // Explicit opt-in brings the rib tool into the node's catalog.
    expect(toolNames).toContain("osdu_quality");
    expect(toolNames).not.toContain("repo_get_kube");
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

  test("copilot does NOT warn for allowed_tools / denied_tools / Pre+PostToolUse hooks", async () => {
    const { provider } = makeSpyProvider({
      chunks: [{ type: "text", content: "" }, { type: "done" }],
      type: "copilot",
    });
    const emitted: NodeStreamEvent[] = [];
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [],
    });
    const node = {
      id: "n1",
      prompt: "",
      allowed_tools: ["Read", "Glob", "Grep"],
      denied_tools: ["Write"],
      hooks: {
        PreToolUse: [{ matcher: "Bash", response: { decision: "block" } }],
        PostToolUse: [{ matcher: "Read", response: { ok: true } }],
      },
    } as unknown as DagNode;
    await handler.handle(node, buildCtx({ onEvent: (e) => emitted.push(e) }));
    expect(emitted.some((e) => e.type === "node_warning")).toBe(false);
  });

  test("copilot warns only for hook events beyond Pre/PostToolUse", async () => {
    const { provider } = makeSpyProvider({
      chunks: [{ type: "text", content: "" }, { type: "done" }],
      type: "copilot",
    });
    const emitted: NodeStreamEvent[] = [];
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [],
    });
    const node = {
      id: "n1",
      prompt: "",
      hooks: {
        PostToolUse: [{ matcher: "Read", response: { ok: true } }],
        SessionStart: [{ response: { ok: true } }],
      },
    } as unknown as DagNode;
    await handler.handle(node, buildCtx({ onEvent: (e) => emitted.push(e) }));
    const warnings = emitted.filter(
      (e): e is { type: "node_warning"; message: string } => e.type === "node_warning",
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain("copilot");
    // The no-op list (after the colon) names only the unsupported event.
    const noOpList = warnings[0]!.message.split("no-op:")[1] ?? "";
    expect(noOpList).toContain("SessionStart");
    expect(noOpList).not.toContain("PostToolUse");
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

  test("times out — status=failed, error=prompt idle timeout", async () => {
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
    expect(result.error).toMatch(/^prompt idle timeout after \d+s without stream activity$/);
  });

  test("honors a per-node idle_timeout below the factory default", async () => {
    const { provider } = makeSpyProvider({
      chunks: [{ type: "text", content: "slow" }, { type: "done" }],
      chunkDelayMs: 500,
    });
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [],
      // Factory default would never fire inside the test window; the per-node
      // budget must be the one that takes effect.
      timeoutMs: 10_000,
    });
    const node = { id: "n1", prompt: "", idle_timeout: 30 } as unknown as DagNode;
    const result = await handler.handle(node, buildCtx());
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/^prompt idle timeout after \d+s without stream activity$/);
  });

  test("per-node idle_timeout resets on each stream chunk (idle, not wall-clock)", async () => {
    // Chunks arrive every 20ms; total wall-clock (~80ms) exceeds the 60ms
    // budget, but no single gap does — an idle timer never fires.
    const { provider } = makeSpyProvider({
      chunks: [
        { type: "text", content: "a" },
        { type: "text", content: "b" },
        { type: "text", content: "c" },
        { type: "done" },
      ],
      chunkDelayMs: 20,
    });
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [],
      timeoutMs: 10_000,
    });
    const node = { id: "n1", prompt: "", idle_timeout: 60 } as unknown as DagNode;
    const result = await handler.handle(node, buildCtx());
    expect(result.status).toBe("succeeded");
    expect(result.output.kind === "text" ? result.output.text : "").toBe("abc");
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
    // Hook failures must NOT take the run down — the seam is best-effort,
    // so a storage hiccup in a hook degrades gracefully.
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

  describe("model fallback chain", () => {
    test("workflow.model is forwarded when the node has no model", async () => {
      const { provider, calls } = makeSpyProvider({
        chunks: [{ type: "text", content: "" }, { type: "done" }],
      });
      const handler = makePromptHandler({
        getProvider: () => provider,
        getRegisteredTools: () => [],
      });
      await handler.handle(stubNode, buildCtx({ workflowModel: "gpt-5" }));
      expect(calls[0]!.options?.model).toBe("gpt-5");
    });

    test("node.model wins over workflow.model", async () => {
      const { provider, calls } = makeSpyProvider({
        chunks: [{ type: "text", content: "" }, { type: "done" }],
      });
      const handler = makePromptHandler({
        getProvider: () => provider,
        getRegisteredTools: () => [],
      });
      const node = { id: "n1", prompt: "", model: "gpt-4o" } as unknown as DagNode;
      await handler.handle(node, buildCtx({ workflowModel: "gpt-5" }));
      expect(calls[0]!.options?.model).toBe("gpt-4o");
    });

    test("provider.defaultModel is forwarded when neither node nor workflow set model", async () => {
      const { provider, calls } = makeSpyProvider({
        chunks: [{ type: "text", content: "" }, { type: "done" }],
        capabilities: { defaultModel: "gpt-5" },
      });
      const handler = makePromptHandler({
        getProvider: () => provider,
        getRegisteredTools: () => [],
      });
      await handler.handle(stubNode, buildCtx());
      expect(calls[0]!.options?.model).toBe("gpt-5");
    });

    test("empty-string defaultModel does not flow through as model", async () => {
      const { provider, calls } = makeSpyProvider({
        chunks: [{ type: "text", content: "" }, { type: "done" }],
        capabilities: { defaultModel: "" },
      });
      const handler = makePromptHandler({
        getProvider: () => provider,
        getRegisteredTools: () => [],
      });
      await handler.handle(stubNode, buildCtx());
      expect(calls[0]!.options?.model).toBeUndefined();
    });

    test("provider.defaultModel still resolves when preflight getProvider() throws but consume's succeeds", async () => {
      // Guards against the fallback regressing to `undefined` if the preflight
      // resolver lookup ever fails transiently (caught + swallowed) while the
      // consume() lookup succeeds.
      const { provider, calls } = makeSpyProvider({
        chunks: [{ type: "text", content: "" }, { type: "done" }],
        capabilities: { defaultModel: "gpt-5" },
      });
      let attempt = 0;
      const handler = makePromptHandler({
        getProvider: () => {
          attempt++;
          if (attempt === 1) throw new Error("registry blip on preflight");
          return provider;
        },
        getRegisteredTools: () => [],
      });
      await handler.handle(stubNode, buildCtx());
      expect(calls[0]!.options?.model).toBe("gpt-5");
    });
  });

  describe("provider/model provenance on the NodeResult", () => {
    test("records the requested model and the resolved provider id", async () => {
      const { provider } = makeSpyProvider({
        chunks: [{ type: "text", content: "ok" }, { type: "done" }],
      });
      const handler = makePromptHandler({
        getProvider: () => provider,
        // Mirrors the composition root: an unset hint resolves to the boot default.
        resolveProviderId: (id) => id ?? "copilot",
        getRegisteredTools: () => [],
      });
      const node = { id: "n1", prompt: "", model: "claude-sonnet-4-6" } as unknown as DagNode;
      const result = await handler.handle(node, buildCtx({ workflowProvider: "claude" }));
      expect(result.provider).toBe("claude");
      expect(result.model).toBe("claude-sonnet-4-6");
    });

    test("resolveProviderId supplies the concrete provider id when the workflow pins nothing", async () => {
      const { provider } = makeSpyProvider({
        chunks: [{ type: "text", content: "ok" }, { type: "done" }],
        capabilities: { defaultModel: "auto" },
      });
      const handler = makePromptHandler({
        getProvider: () => provider,
        resolveProviderId: (id) => id ?? "copilot",
        getRegisteredTools: () => [],
      });
      const result = await handler.handle(stubNode, buildCtx());
      // Provider falls back to the boot default; model to the provider default.
      expect(result.provider).toBe("copilot");
      expect(result.model).toBe("auto");
    });

    test("falls back to the raw provider hint when no resolveProviderId is injected", async () => {
      const { provider } = makeSpyProvider({
        chunks: [{ type: "text", content: "ok" }, { type: "done" }],
      });
      const handler = makePromptHandler({
        getProvider: () => provider,
        getRegisteredTools: () => [],
      });
      const node = { id: "n1", prompt: "", provider: "claude" } as unknown as DagNode;
      const result = await handler.handle(node, buildCtx());
      expect(result.provider).toBe("claude");
    });

    test("a {type:'model'} chunk overrides the requested model (resolved-concrete wins)", async () => {
      const events: NodeStreamEvent[] = [];
      const { provider } = makeSpyProvider({
        chunks: [
          { type: "text", content: "ok" },
          { type: "model", model: "claude-sonnet-4-6-20260219" },
          { type: "done" },
        ],
      });
      const handler = makePromptHandler({
        getProvider: () => provider,
        resolveProviderId: (id) => id ?? "copilot",
        getRegisteredTools: () => [],
      });
      // Requested "auto" (copilot-style); the provider reports the concrete model.
      const node = { id: "n1", prompt: "", model: "auto" } as unknown as DagNode;
      const result = await handler.handle(node, buildCtx({ onEvent: (e) => events.push(e) }));
      expect(result.model).toBe("claude-sonnet-4-6-20260219");
      // The model chunk is intercepted (like usage), not fanned out as node_chunk.
      const chunkTypes = events
        .filter(
          (e): e is Extract<NodeStreamEvent, { type: "node_chunk" }> => e.type === "node_chunk",
        )
        .map((e) => (e.chunk as { type?: string }).type);
      expect(chunkTypes).not.toContain("model");
    });

    test("a blank {type:'model'} chunk does not clobber the requested model", async () => {
      const { provider } = makeSpyProvider({
        chunks: [
          { type: "text", content: "ok" },
          { type: "model", model: "   " },
          { type: "done" },
        ],
      });
      const handler = makePromptHandler({
        getProvider: () => provider,
        getRegisteredTools: () => [],
      });
      const node = { id: "n1", prompt: "", model: "gpt-5" } as unknown as DagNode;
      const result = await handler.handle(node, buildCtx());
      expect(result.model).toBe("gpt-5");
    });

    test("attaches provider/model even when the turn fails", async () => {
      const { provider } = makeSpyProvider({
        chunks: [{ type: "error", message: "boom" }, { type: "done" }],
      });
      const handler = makePromptHandler({
        getProvider: () => provider,
        resolveProviderId: (id) => id ?? "copilot",
        getRegisteredTools: () => [],
      });
      const node = { id: "n1", prompt: "", model: "gpt-5" } as unknown as DagNode;
      const result = await handler.handle(node, buildCtx());
      expect(result.status).toBe("failed");
      expect(result.provider).toBe("copilot");
      expect(result.model).toBe("gpt-5");
    });

    test("omits provider/model when no hint, resolver, or model resolves (standalone)", async () => {
      const { provider } = makeSpyProvider({
        chunks: [{ type: "text", content: "ok" }, { type: "done" }],
      });
      const handler = makePromptHandler({
        getProvider: () => provider,
        getRegisteredTools: () => [],
      });
      const result = await handler.handle(stubNode, buildCtx());
      expect(result.provider).toBeUndefined();
      expect(result.model).toBeUndefined();
    });
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
    expect(result.error).toMatch(/^prompt idle timeout after \d+s without stream activity$/);
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
      expect(result.error).toMatch(/^prompt idle timeout after \d+s without stream activity$/);
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

    test("clean JSON reply becomes structured node output", async () => {
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
      expect(result.output.kind).toBe("structured");
      const value = result.output.kind === "structured" ? result.output.value : undefined;
      expect(value).toEqual({ kind: "bug", title: "oops" });
    });

    test("fenced JSON reply becomes structured node output", async () => {
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
      expect(result.output.kind).toBe("structured");
      const value = result.output.kind === "structured" ? result.output.value : undefined;
      expect(value).toEqual({ kind: "feature" });
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

    test("a bare JSON scalar stays text, not structured", async () => {
      const { provider } = makeSpyProvider({
        chunks: [{ type: "text", content: "null" }, { type: "done" }],
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
      expect(result.output.kind).toBe("text");
      const text = result.output.kind === "text" ? result.output.text : "";
      expect(text).toBe("null");
    });
  });
});

describe("makePromptHandler — project notebook injection", () => {
  const doneOnly = (): ReturnType<typeof makeSpyProvider> =>
    makeSpyProvider({ chunks: [{ type: "done" }] });
  const adapter = (read: () => string | undefined): NotebookAdapter => ({
    read,
    append: () => ({ ok: true }),
  });

  test("injects the notebook section from ctx.notebook.read()", async () => {
    const { provider, calls } = doneOnly();
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [],
    });
    await handler.handle(
      stubNode,
      buildCtx({ notebook: adapter(() => "## Project notebook\n\nnotes") }),
    );
    expect(calls[0]?.options?.systemPrompt).toBe("## Project notebook\n\nnotes");
  });

  test("notebook is prepended to the factory seed system prompt", async () => {
    const { provider, calls } = doneOnly();
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [],
      systemPrompt: "SEED",
    });
    await handler.handle(
      stubNode,
      buildCtx({ notebook: adapter(() => "## Project notebook\n\nnotes") }),
    );
    const sp = calls[0]?.options?.systemPrompt ?? "";
    expect(sp).toContain("## Project notebook");
    expect(sp).toContain("SEED");
    expect(sp.indexOf("## Project notebook")).toBeLessThan(sp.indexOf("SEED"));
  });

  test("no notebook adapter → seed-only", async () => {
    const { provider, calls } = doneOnly();
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [],
      systemPrompt: "SEED",
    });
    await handler.handle(stubNode, buildCtx());
    expect(calls[0]?.options?.systemPrompt).toBe("SEED");
  });

  test("an empty notebook (read returns undefined) and no seed → no systemPrompt", async () => {
    const { provider, calls } = doneOnly();
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [],
    });
    await handler.handle(stubNode, buildCtx({ notebook: adapter(() => undefined) }));
    expect(calls[0]?.options?.systemPrompt).toBeUndefined();
  });

  test("a throwing read() must not take the node down (best-effort context)", async () => {
    const { provider, calls } = doneOnly();
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [],
      systemPrompt: "SEED",
    });
    const result = await handler.handle(
      stubNode,
      buildCtx({
        notebook: adapter(() => {
          throw new Error("read blew up");
        }),
      }),
    );
    expect(result.status).toBe("succeeded");
    expect(calls[0]?.options?.systemPrompt).toBe("SEED");
  });
});

describe("prompt handler — token usage", () => {
  test("captures the provider's usage chunk on NodeResult and keeps it off the chunk channel", async () => {
    const { provider } = makeSpyProvider({
      chunks: [
        { type: "text", content: "hello" },
        {
          type: "usage",
          usage: { inputTokens: 50, outputTokens: 12, contextTokens: 62, contextWindow: 200000 },
        },
        { type: "done" },
      ],
    });
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [],
    });
    const events: NodeStreamEvent[] = [];
    const result = await handler.handle(stubNode, buildCtx({ onEvent: (e) => events.push(e) }));

    expect(result.status).toBe("succeeded");
    expect(result.usage).toEqual({
      inputTokens: 50,
      outputTokens: 12,
      contextTokens: 62,
      contextWindow: 200000,
    });
    // usage rides NodeResult → node_done, never the node_chunk channel.
    const chunkEvents = events.filter((e) => e.type === "node_chunk");
    for (const e of chunkEvents) {
      expect((e as { chunk: { type?: string } }).chunk.type).not.toBe("usage");
    }
  });

  test("attaches usage to a failed result when the turn spent tokens before erroring", async () => {
    const { provider } = makeSpyProvider({
      chunks: [
        { type: "usage", usage: { inputTokens: 9, outputTokens: 1 } },
        { type: "error", message: "provider blew up" },
      ],
    });
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [],
    });
    const result = await handler.handle(stubNode, buildCtx());

    expect(result.status).toBe("failed");
    expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 1 });
  });

  test("leaves usage absent when the provider reports none", async () => {
    const { provider } = makeSpyProvider({
      chunks: [{ type: "text", content: "hi" }, { type: "done" }],
    });
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [],
    });
    const result = await handler.handle(stubNode, buildCtx());

    expect(result.status).toBe("succeeded");
    expect(result.usage).toBeUndefined();
  });
});

describe("prompt handler — usage sanitation at the provider boundary", () => {
  test("strips unknown fields and floors float counts from a nonconforming provider", async () => {
    const { provider } = makeSpyProvider({
      chunks: [
        {
          type: "usage",
          usage: {
            inputTokens: 421.7,
            outputTokens: 37,
            totalTokens: 458, // unknown field — must not reach the wire frame
            contextWindow: 200000,
          },
        },
        { type: "done" },
      ],
    });
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [],
    });
    const result = await handler.handle(stubNode, buildCtx());
    expect(result.usage).toEqual({ inputTokens: 421, outputTokens: 37, contextWindow: 200000 });
  });

  test("drops usage payloads missing required counts entirely", async () => {
    const { provider } = makeSpyProvider({
      chunks: [
        { type: "usage", usage: { tokens: 5 } },
        { type: "usage", usage: [1, 2] },
        { type: "usage", usage: "lots" },
        { type: "done" },
      ],
    });
    const handler = makePromptHandler({
      getProvider: () => provider,
      getRegisteredTools: () => [],
    });
    const result = await handler.handle(stubNode, buildCtx());
    expect(result.usage).toBeUndefined();
  });
});
