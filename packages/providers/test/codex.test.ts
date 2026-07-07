// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageChunk } from "@keelson/shared";
import { type CodexRawEvent, mapCodexEvent } from "../src/codex/event-bridge.ts";
import type {
  CodexCreateThreadParams,
  CodexThread,
  CodexThreadFactory,
} from "../src/codex/factory.ts";
import { checkCodexAuth } from "../src/codex/factory.ts";
import { CODEX_CAPABILITIES, CodexProvider } from "../src/codex/provider.ts";

const item = (body: Record<string, unknown>): CodexRawEvent => ({
  type: "item.completed",
  item: body,
});

describe("mapCodexEvent", () => {
  test("agent_message item → text chunk", () => {
    expect(mapCodexEvent(item({ id: "a1", type: "agent_message", text: "hello" }))).toEqual([
      { type: "text", content: "hello" },
    ]);
  });

  test("empty agent_message text is dropped", () => {
    expect(mapCodexEvent(item({ id: "a1", type: "agent_message", text: "" }))).toEqual([]);
  });

  test("reasoning item → thinking chunk", () => {
    expect(mapCodexEvent(item({ id: "r1", type: "reasoning", text: "let me think" }))).toEqual([
      { type: "thinking", content: "let me think" },
    ]);
  });

  test("command_execution → paired tool_use + tool_result", () => {
    expect(
      mapCodexEvent(
        item({
          id: "c1",
          type: "command_execution",
          command: "ls -a",
          aggregated_output: "a\nb",
          exit_code: 0,
        }),
      ),
    ).toEqual([
      { type: "tool_use", id: "c1", toolName: "shell", toolInput: { command: "ls -a" } },
      { type: "tool_result", toolUseId: "c1", content: "a\nb" },
    ]);
  });

  test("command_execution with a non-zero exit marks the result an error and appends the code", () => {
    expect(
      mapCodexEvent(
        item({
          id: "c1",
          type: "command_execution",
          command: "false",
          aggregated_output: "boom",
          exit_code: 2,
        }),
      ),
    ).toEqual([
      { type: "tool_use", id: "c1", toolName: "shell", toolInput: { command: "false" } },
      { type: "tool_result", toolUseId: "c1", content: "boom\n[exit code: 2]", isError: true },
    ]);
  });

  test("command_execution without an id is dropped (unpairable)", () => {
    expect(mapCodexEvent(item({ type: "command_execution", command: "ls" }))).toEqual([]);
  });

  test("file_change → apply_patch tool_use + summary result", () => {
    expect(
      mapCodexEvent(
        item({
          id: "f1",
          type: "file_change",
          status: "completed",
          changes: [
            { path: "a.ts", kind: "add" },
            { path: "b.ts", kind: "update" },
            { path: "c.ts", kind: "delete" },
          ],
        }),
      ),
    ).toEqual([
      {
        type: "tool_use",
        id: "f1",
        toolName: "apply_patch",
        toolInput: {
          changes: [
            { path: "a.ts", kind: "add" },
            { path: "b.ts", kind: "update" },
            { path: "c.ts", kind: "delete" },
          ],
        },
      },
      { type: "tool_result", toolUseId: "f1", content: "➕ a.ts\n📝 b.ts\n➖ c.ts" },
    ]);
  });

  test("a failed file_change marks the result an error", () => {
    const out = mapCodexEvent(
      item({ id: "f1", type: "file_change", status: "failed", changes: [] }),
    );
    expect(out).toEqual([
      { type: "tool_use", id: "f1", toolName: "apply_patch", toolInput: { changes: [] } },
      { type: "tool_result", toolUseId: "f1", content: "patch failed", isError: true },
    ]);
  });

  test("mcp_tool_call success → server/tool name + stringified result", () => {
    expect(
      mapCodexEvent(
        item({
          id: "m1",
          type: "mcp_tool_call",
          server: "fs",
          tool: "read",
          status: "completed",
          arguments: { path: "x" },
          result: { content: [{ type: "text", text: "ok" }] },
        }),
      ),
    ).toEqual([
      {
        type: "tool_use",
        id: "m1",
        toolName: "fs/read",
        toolInput: { arguments: { path: "x" } },
      },
      { type: "tool_result", toolUseId: "m1", content: '[{"type":"text","text":"ok"}]' },
    ]);
  });

  test("mcp_tool_call failure → error result", () => {
    expect(
      mapCodexEvent(
        item({
          id: "m1",
          type: "mcp_tool_call",
          server: "fs",
          tool: "read",
          status: "failed",
          error: { message: "denied" },
        }),
      ),
    ).toEqual([
      { type: "tool_use", id: "m1", toolName: "fs/read" },
      { type: "tool_result", toolUseId: "m1", content: "denied", isError: true },
    ]);
  });

  test("web_search → query tool_use + empty result", () => {
    expect(mapCodexEvent(item({ id: "w1", type: "web_search", query: "bun docs" }))).toEqual([
      { type: "tool_use", id: "w1", toolName: "web_search", toolInput: { query: "bun docs" } },
      { type: "tool_result", toolUseId: "w1", content: "" },
    ]);
  });

  test("todo_list → a single system chunk with checkbox lines", () => {
    expect(
      mapCodexEvent(
        item({
          id: "t1",
          type: "todo_list",
          items: [
            { text: "scan", completed: true },
            { text: "fix", completed: false },
          ],
        }),
      ),
    ).toEqual([{ type: "system", content: "📋 Tasks:\n✅ scan\n⬜ fix" }]);
  });

  test("a non-fatal error item → system chunk", () => {
    expect(mapCodexEvent(item({ id: "e1", type: "error", message: "retrying" }))).toEqual([
      { type: "system", content: "⚠️ retrying" },
    ]);
  });

  test("turn.completed → usage chunk (cached_input_tokens → cacheRead, kept only when positive)", () => {
    expect(
      mapCodexEvent({
        type: "turn.completed",
        usage: {
          input_tokens: 100,
          cached_input_tokens: 20,
          output_tokens: 30,
          reasoning_output_tokens: 5,
        },
      }),
    ).toEqual([
      {
        type: "usage",
        usage: { inputTokens: 80, outputTokens: 30, cacheReadInputTokens: 20 },
      },
    ]);
  });

  test("turn.completed clamps fresh input at zero when cached input exceeds total input", () => {
    expect(
      mapCodexEvent({
        type: "turn.completed",
        usage: {
          input_tokens: 10,
          cached_input_tokens: 20,
          output_tokens: 5,
        },
      }),
    ).toEqual([
      {
        type: "usage",
        usage: { inputTokens: 0, outputTokens: 5, cacheReadInputTokens: 20 },
      },
    ]);
  });

  test("turn.completed with all-zero usage emits no fabricated zero row", () => {
    expect(
      mapCodexEvent({
        type: "turn.completed",
        usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 },
      }),
    ).toEqual([{ type: "usage", usage: { inputTokens: 0, outputTokens: 0 } }]);
  });

  test("turn.completed with no usable counts emits nothing", () => {
    expect(mapCodexEvent({ type: "turn.completed", usage: {} })).toEqual([]);
  });

  test("turn.failed → error chunk; falls back to a default message", () => {
    expect(
      mapCodexEvent({ type: "turn.failed", error: { message: "model not available" } }),
    ).toEqual([{ type: "error", message: "model not available" }]);
    expect(mapCodexEvent({ type: "turn.failed", error: {} })).toEqual([
      { type: "error", message: "codex turn failed" },
    ]);
  });

  test("fatal stream error event → error chunk", () => {
    expect(mapCodexEvent({ type: "error", message: "subprocess crashed" })).toEqual([
      { type: "error", message: "subprocess crashed" },
    ]);
  });

  test("thread.started and other lifecycle events map to nothing", () => {
    expect(mapCodexEvent({ type: "thread.started", thread_id: "th_1" })).toEqual([]);
    expect(mapCodexEvent({ type: "turn.started" })).toEqual([]);
    expect(
      mapCodexEvent({ type: "item.started", item: { id: "x", type: "agent_message" } }),
    ).toEqual([]);
    expect(
      mapCodexEvent({ type: "item.updated", item: { id: "x", type: "agent_message" } }),
    ).toEqual([]);
  });
});

// Fake factory: runStreamed replays a scripted event array (or a custom async
// iterable), exercising the provider's lifecycle with no SDK.
function fakeFactory(
  source: CodexRawEvent[] | AsyncIterable<CodexRawEvent>,
  opts: {
    throwOnCreate?: Error;
    throwOnRun?: Error;
    capture?: (p: CodexCreateThreadParams) => void;
    captureInput?: (input: string) => void;
  } = {},
): CodexThreadFactory {
  return {
    async createThread(params): Promise<CodexThread> {
      opts.capture?.(params);
      if (opts.throwOnCreate) throw opts.throwOnCreate;
      return {
        async runStreamed(input): Promise<AsyncIterable<CodexRawEvent>> {
          opts.captureInput?.(input);
          if (opts.throwOnRun) throw opts.throwOnRun;
          if (Array.isArray(source)) {
            return (async function* () {
              for (const e of source) yield e;
            })();
          }
          return source;
        },
      };
    },
  };
}

async function collect(gen: AsyncGenerator<MessageChunk>): Promise<MessageChunk[]> {
  const out: MessageChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

describe("CodexProvider", () => {
  test("getType / capabilities", () => {
    const p = new CodexProvider({ factory: fakeFactory([]) });
    expect(p.getType()).toBe("codex");
    expect(p.getCapabilities()).toEqual(CODEX_CAPABILITIES);
    expect(CODEX_CAPABILITIES.sessionResume).toBe(true);
    expect(CODEX_CAPABILITIES.tools).toBe(false);
  });

  test("listModels returns a deep copy of the curated catalog", async () => {
    const models = await new CodexProvider({ factory: fakeFactory([]) }).listModels();
    expect(models.map((m) => m.id)).toEqual(CODEX_CAPABILITIES.models);
  });

  test("streams text then usage; captures a new thread id via onSessionId", async () => {
    const sessions: string[] = [];
    const provider = new CodexProvider({
      factory: fakeFactory([
        { type: "thread.started", thread_id: "th_new" },
        item({ id: "a1", type: "agent_message", text: "answer" }),
        { type: "turn.completed", usage: { input_tokens: 4, output_tokens: 2 } },
      ]),
    });
    const chunks = await collect(
      provider.sendQuery("hi", "/repo", undefined, { onSessionId: (id) => sessions.push(id) }),
    );
    expect(chunks).toEqual([
      { type: "text", content: "answer" },
      { type: "usage", usage: { inputTokens: 4, outputTokens: 2 } },
    ]);
    expect(sessions).toEqual(["th_new"]);
  });

  test("a resumed thread echoes its id up front and passes resumeSessionId to the factory", async () => {
    const sessions: string[] = [];
    let captured: CodexCreateThreadParams | undefined;
    const provider = new CodexProvider({
      factory: fakeFactory([item({ id: "a1", type: "agent_message", text: "again" })], {
        capture: (p) => {
          captured = p;
        },
      }),
    });
    await collect(
      provider.sendQuery("hi", "/repo", "th_prior", { onSessionId: (id) => sessions.push(id) }),
    );
    expect(captured?.resumeSessionId).toBe("th_prior");
    expect(sessions).toEqual(["th_prior"]);
  });

  test("prepends systemPrompt to the user text and forwards model + mapped reasoning effort", async () => {
    let captured: CodexCreateThreadParams | undefined;
    let input = "";
    const provider = new CodexProvider({
      factory: fakeFactory([], {
        capture: (p) => {
          captured = p;
        },
        captureInput: (i) => {
          input = i;
        },
      }),
    });
    await collect(
      provider.sendQuery("question", "/repo", undefined, {
        model: "gpt-5.5",
        systemPrompt: "you are helpful",
        reasoningEffort: "none",
      }),
    );
    expect(input).toBe("you are helpful\n\nquestion");
    expect(captured?.model).toBe("gpt-5.5");
    // keelson "none" has no codex equivalent → "minimal".
    expect(captured?.reasoningEffort).toBe("minimal");
  });

  test("defaults to the agentic workspace-write sandbox with network off; overridable", async () => {
    let captured: CodexCreateThreadParams | undefined;
    const capture = (p: CodexCreateThreadParams) => {
      captured = p;
    };
    await collect(
      new CodexProvider({ factory: fakeFactory([], { capture }) }).sendQuery("x", "/r"),
    );
    expect(captured?.sandboxMode).toBe("workspace-write");
    expect(captured?.networkAccessEnabled).toBe(false);

    await collect(
      new CodexProvider({
        factory: fakeFactory([], { capture }),
        sandboxMode: "read-only",
        networkAccessEnabled: true,
      }).sendQuery("x", "/r"),
    );
    expect(captured?.sandboxMode).toBe("read-only");
    expect(captured?.networkAccessEnabled).toBe(true);
  });

  test("a thread-creation failure yields a single error chunk", async () => {
    const provider = new CodexProvider({
      factory: fakeFactory([], { throwOnCreate: new Error("codex not installed") }),
    });
    expect(await collect(provider.sendQuery("hi", "/r"))).toEqual([
      { type: "error", message: "codex thread failed to start: codex not installed" },
    ]);
  });

  test("a runStreamed failure yields an error chunk", async () => {
    const provider = new CodexProvider({
      factory: fakeFactory([], { throwOnRun: new Error("spawn failed") }),
    });
    expect(await collect(provider.sendQuery("hi", "/r"))).toEqual([
      { type: "error", message: "codex turn failed: spawn failed" },
    ]);
  });

  test("an abort during runStreamed startup returns without an error chunk", async () => {
    const controller = new AbortController();
    const factory: CodexThreadFactory = {
      async createThread(): Promise<CodexThread> {
        return {
          async runStreamed(): Promise<AsyncIterable<CodexRawEvent>> {
            // The caller aborts just as the turn starts; the SDK rejects in
            // response. That rejection is cancellation, not a turn failure.
            controller.abort();
            throw new Error("aborted before stream");
          },
        };
      },
    };
    const chunks = await collect(
      new CodexProvider({ factory }).sendQuery("hi", "/r", undefined, {
        abortSignal: controller.signal,
      }),
    );
    expect(chunks).toEqual([]);
  });

  test("a mid-stream throw (not aborted) surfaces as an error chunk", async () => {
    const events = (async function* (): AsyncGenerator<CodexRawEvent> {
      yield item({ id: "a1", type: "agent_message", text: "partial" });
      throw new Error("stream died");
    })();
    const provider = new CodexProvider({ factory: fakeFactory(events) });
    expect(await collect(provider.sendQuery("hi", "/r"))).toEqual([
      { type: "text", content: "partial" },
      { type: "error", message: "codex stream error: stream died" },
    ]);
  });

  test("a reported turn.failed is not double-reported when the stream then throws", async () => {
    const events = (async function* (): AsyncGenerator<CodexRawEvent> {
      yield { type: "turn.failed", error: { message: "model unavailable" } };
      throw new Error("subprocess exited");
    })();
    const provider = new CodexProvider({ factory: fakeFactory(events) });
    expect(await collect(provider.sendQuery("hi", "/r"))).toEqual([
      { type: "error", message: "model unavailable" },
    ]);
  });

  test("captures a new thread id even when the signal is already aborted as thread.started arrives", async () => {
    const controller = new AbortController();
    const events = (async function* (): AsyncGenerator<CodexRawEvent> {
      // Abort lands before the first event is delivered; the id must still be
      // captured so the half-open thread stays resumable next turn.
      controller.abort();
      yield { type: "thread.started", thread_id: "th_x" };
    })();
    const sessions: string[] = [];
    const provider = new CodexProvider({ factory: fakeFactory(events) });
    const chunks = await collect(
      provider.sendQuery("hi", "/r", undefined, {
        abortSignal: controller.signal,
        onSessionId: (id) => sessions.push(id),
      }),
    );
    expect(sessions).toEqual(["th_x"]);
    expect(chunks).toEqual([]);
  });

  test("an abort during the stream stops iteration and swallows the resulting error", async () => {
    const controller = new AbortController();
    const events = (async function* (): AsyncGenerator<CodexRawEvent> {
      yield item({ id: "a1", type: "agent_message", text: "first" });
      controller.abort();
      // A real SDK turn would throw once its signal fires; that post-abort
      // failure must not surface as a turn error.
      throw new Error("aborted subprocess");
    })();
    const provider = new CodexProvider({ factory: fakeFactory(events) });
    const chunks = await collect(
      provider.sendQuery("hi", "/r", undefined, { abortSignal: controller.signal }),
    );
    expect(chunks).toEqual([{ type: "text", content: "first" }]);
  });

  test("an already-aborted signal yields nothing and never creates a thread", async () => {
    let created = false;
    const factory: CodexThreadFactory = {
      async createThread() {
        created = true;
        throw new Error("should not be called");
      },
    };
    const controller = new AbortController();
    controller.abort();
    const chunks = await collect(
      new CodexProvider({ factory }).sendQuery("hi", "/r", undefined, {
        abortSignal: controller.signal,
      }),
    );
    expect(chunks).toEqual([]);
    expect(created).toBe(false);
  });
});

describe("checkCodexAuth", () => {
  test("reports an OPENAI_API_KEY env key", () => {
    expect(
      checkCodexAuth({ env: { OPENAI_API_KEY: "sk-x" }, authFile: "/nope/auth.json" }),
    ).toEqual({ authenticated: true, source: "env" });
  });

  test("reports a CODEX_API_KEY env key", () => {
    expect(checkCodexAuth({ env: { CODEX_API_KEY: "sk-x" }, authFile: "/nope/auth.json" })).toEqual(
      {
        authenticated: true,
        source: "env",
      },
    );
  });

  test("reports an auth.json file", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-auth-"));
    try {
      const authFile = join(dir, "auth.json");
      writeFileSync(authFile, "{}");
      expect(checkCodexAuth({ env: {}, authFile })).toEqual({
        authenticated: true,
        source: "auth.json",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports unauthenticated when nothing is present", () => {
    expect(checkCodexAuth({ env: {}, authFile: "/nope/auth.json" })).toEqual({
      authenticated: false,
    });
  });
});
