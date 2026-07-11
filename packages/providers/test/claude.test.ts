// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ToolDefinition } from "@keelson/shared";
import { z } from "zod";
import { type ClaudeToolProjectionContext, projectToolsForClaude } from "../src/claude/factory.ts";
import type {
  ClaudeQueryOptions,
  ClaudeSdkMessage,
  ClaudeSdkModule,
  MessageChunk,
  ProviderFinishReason,
} from "../src/index.ts";
import {
  buildFriendlyClaudeError,
  CLAUDE_CAPABILITIES,
  CLAUDE_CREDENTIAL_SERVICE_ID,
  CLAUDE_DEFAULT_MODEL,
  type ClaudeCliRunner,
  ClaudeProvider,
  ClaudeQueryFactory,
  clearRegistry,
  getProviderInfoList,
  isRegisteredProvider,
  registerClaudeProvider,
} from "../src/index.ts";

// claude auth status --json runner stub. Captures the env it was handed so a
// test can assert the subscription probe strips ANTHROPIC_API_KEY.
function fakeCliRunner(
  body: Record<string, unknown> | { fail: true },
  calls?: { count: number; env?: Record<string, string> },
): ClaudeCliRunner {
  return async (env) => {
    if (calls) {
      calls.count++;
      calls.env = env;
    }
    if ("fail" in body) return { exitCode: 1, stdout: "", stderr: "not logged in" };
    return { exitCode: 0, stdout: JSON.stringify(body), stderr: "" };
  };
}

// --- Mock SDK harness ---

interface MockSdkHandle {
  module: ClaudeSdkModule;
  lastOptions: () => ClaudeQueryOptions | null;
  lastPrompt: () => string | null;
  interruptCount: () => number;
}

type Scenario = (yieldFn: (msg: ClaudeSdkMessage) => Promise<void>) => Promise<void>;

interface MockSdkOptions {
  scenario?: Scenario;
  queryError?: Error;
  loaderError?: Error;
}

function makeMockSdk(opts: MockSdkOptions = {}): MockSdkHandle {
  let lastOptions: ClaudeQueryOptions | null = null;
  let lastPrompt: string | null = null;
  let interruptCount = 0;

  const module: ClaudeSdkModule = {
    query(args) {
      lastPrompt = args.prompt;
      lastOptions = args.options ?? null;
      if (opts.queryError) throw opts.queryError;

      // Build an async iterable from the scenario. The scenario receives a
      // push function it calls to enqueue messages, and the for-await on the
      // consumer side drains them in order.
      const pending: ClaudeSdkMessage[] = [];
      let resolveNext: (() => void) | null = null;
      let done = false;
      let producerError: unknown = null;

      const push = async (msg: ClaudeSdkMessage): Promise<void> => {
        pending.push(msg);
        const r = resolveNext;
        if (r) {
          resolveNext = null;
          r();
        }
        // Yield a microtask so the consumer can drain before the next push.
        await Promise.resolve();
      };

      // Start the scenario asynchronously; its completion closes the stream.
      void (async () => {
        try {
          if (opts.scenario) await opts.scenario(push);
        } catch (err) {
          producerError = err;
        } finally {
          done = true;
          // Cast to override TS's overzealous CFA: inside this IIFE TS thinks
          // resolveNext can only be `null` because the only non-null write is
          // in a sibling closure (the iterator's Promise callback). The cast
          // restores the declared union type.
          const r = resolveNext as (() => void) | null;
          resolveNext = null;
          r?.();
        }
      })();

      return {
        async *[Symbol.asyncIterator]() {
          while (true) {
            if (pending.length > 0) {
              yield pending.shift()!;
              continue;
            }
            if (done) {
              if (producerError) throw producerError;
              return;
            }
            await new Promise<void>((r) => {
              resolveNext = r;
            });
          }
        },
        interrupt: async () => {
          interruptCount++;
        },
      };
    },
  };

  return {
    module,
    lastOptions: () => lastOptions,
    lastPrompt: () => lastPrompt,
    interruptCount: () => interruptCount,
  };
}

function loaderFor(sdk: MockSdkHandle) {
  let count = 0;
  return {
    load: (): Promise<ClaudeSdkModule> => {
      count++;
      return Promise.resolve(sdk.module);
    },
    count: () => count,
  };
}

function rejectingLoader(err: Error) {
  return (): Promise<ClaudeSdkModule> => Promise.reject(err);
}

async function drain<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

// Common assistant-end pattern: yield a successful result message that
// terminates the provider's drain loop.
async function pushSuccess(push: (msg: ClaudeSdkMessage) => Promise<void>): Promise<void> {
  await push({
    type: "result",
    subtype: "success",
    is_error: false,
    uuid: "result-uuid",
    session_id: "sess-id",
  });
}

beforeEach(() => {
  clearRegistry();
});

describe("registerClaudeProvider", () => {
  it("registers a claude provider with the expected identity", () => {
    registerClaudeProvider({ getCredential: async () => undefined });
    expect(isRegisteredProvider("claude")).toBe(true);
    const info = getProviderInfoList().find((p) => p.id === "claude");
    expect(info).toBeDefined();
    expect(info!.displayName).toBe("Claude");
    expect(info!.builtIn).toBe(true);
    expect(info!.credentialServiceId).toBe(CLAUDE_CREDENTIAL_SERVICE_ID);
    expect(info!.capabilities).toEqual(CLAUDE_CAPABILITIES);
  });

  it("is idempotent — calling twice does not throw", () => {
    const opts = { getCredential: async () => undefined };
    registerClaudeProvider(opts);
    expect(() => registerClaudeProvider(opts)).not.toThrow();
  });
});

describe("ClaudeProvider — identity", () => {
  it("getType returns 'claude'", () => {
    const p = new ClaudeProvider({ getCredential: async () => undefined });
    expect(p.getType()).toBe("claude");
  });

  it("getCapabilities matches the registered shape", () => {
    const p = new ClaudeProvider({ getCredential: async () => undefined });
    expect(p.getCapabilities()).toEqual(CLAUDE_CAPABILITIES);
  });
});

describe("ClaudeProvider — credential modes (api-key)", () => {
  it("omits env when no API key is saved (CLI auth fallback)", async () => {
    const sdk = makeMockSdk({ scenario: pushSuccess });
    const loader = loaderFor(sdk);
    const provider = new ClaudeProvider({
      getCredential: async () => undefined,
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loader.load }),
      authPreference: "api-key",
    });
    await drain(provider.sendQuery("hi", "/tmp"));

    expect(loader.count()).toBe(1);
    const options = sdk.lastOptions();
    expect(options).not.toBeNull();
    expect(options!.env).toBeUndefined();
  });

  it("sets ANTHROPIC_API_KEY when a credential is saved", async () => {
    const sdk = makeMockSdk({ scenario: pushSuccess });
    const loader = loaderFor(sdk);
    const provider = new ClaudeProvider({
      getCredential: async () => "sk-ant-xyz",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loader.load }),
      authPreference: "api-key",
    });
    await drain(provider.sendQuery("hi", "/tmp"));

    const options = sdk.lastOptions();
    expect(options!.env).toEqual({ ANTHROPIC_API_KEY: "sk-ant-xyz" });
  });
});

describe("ClaudeProvider — subscription preference", () => {
  // Set an ambient key so "stripped" is observable, restored after each test.
  let savedKey: string | undefined;
  beforeEach(() => {
    savedKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-ambient";
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  });

  it("auto: uses the subscription (strips the key) when one is detected", async () => {
    const sdk = makeMockSdk({ scenario: pushSuccess });
    const provider = new ClaudeProvider({
      getCredential: async () => "sk-ant-saved",
      queryFactory: new ClaudeQueryFactory({
        sdkLoader: loaderFor(sdk).load,
        cliRunner: fakeCliRunner({ loggedIn: true, subscriptionType: "max" }),
      }),
      // authPreference defaults to "auto"
    });
    await drain(provider.sendQuery("hi", "/tmp"));

    const options = sdk.lastOptions();
    // Subscription wins over the saved token; the key is absent from the spawn.
    expect(options!.env).toBeDefined();
    expect(options!.env?.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("auto: falls back to the API key when no subscription is detected", async () => {
    const sdk = makeMockSdk({ scenario: pushSuccess });
    const provider = new ClaudeProvider({
      getCredential: async () => "sk-ant-saved",
      queryFactory: new ClaudeQueryFactory({
        sdkLoader: loaderFor(sdk).load,
        cliRunner: fakeCliRunner({ loggedIn: true, subscriptionType: null }),
      }),
    });
    await drain(provider.sendQuery("hi", "/tmp"));

    expect(sdk.lastOptions()!.env).toEqual({ ANTHROPIC_API_KEY: "sk-ant-saved" });
  });

  it("auto: falls back to the API key when the probe fails", async () => {
    const sdk = makeMockSdk({ scenario: pushSuccess });
    const provider = new ClaudeProvider({
      getCredential: async () => undefined,
      queryFactory: new ClaudeQueryFactory({
        sdkLoader: loaderFor(sdk).load,
        cliRunner: fakeCliRunner({ fail: true }),
      }),
    });
    await drain(provider.sendQuery("hi", "/tmp"));

    // No subscription, no saved token → env omitted (ambient key in effect).
    expect(sdk.lastOptions()!.env).toBeUndefined();
  });

  it("subscription: forces the subscription route without probing", async () => {
    const sdk = makeMockSdk({ scenario: pushSuccess });
    const calls = { count: 0 };
    const provider = new ClaudeProvider({
      getCredential: async () => "sk-ant-saved",
      queryFactory: new ClaudeQueryFactory({
        sdkLoader: loaderFor(sdk).load,
        cliRunner: fakeCliRunner({ loggedIn: true, subscriptionType: "max" }, calls),
      }),
      authPreference: "subscription",
    });
    await drain(provider.sendQuery("hi", "/tmp"));

    expect(calls.count).toBe(0); // explicit mode skips detection
    expect(sdk.lastOptions()!.env?.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("api-key: never strips even when a subscription exists", async () => {
    const sdk = makeMockSdk({ scenario: pushSuccess });
    const calls = { count: 0 };
    const provider = new ClaudeProvider({
      getCredential: async () => "sk-ant-saved",
      queryFactory: new ClaudeQueryFactory({
        sdkLoader: loaderFor(sdk).load,
        cliRunner: fakeCliRunner({ loggedIn: true, subscriptionType: "max" }, calls),
      }),
      authPreference: "api-key",
    });
    await drain(provider.sendQuery("hi", "/tmp"));

    expect(calls.count).toBe(0);
    expect(sdk.lastOptions()!.env).toEqual({ ANTHROPIC_API_KEY: "sk-ant-saved" });
  });

  it("auto: probes once across turns (memoized)", async () => {
    const sdk = makeMockSdk({ scenario: pushSuccess });
    const calls = { count: 0 };
    const provider = new ClaudeProvider({
      getCredential: async () => undefined,
      queryFactory: new ClaudeQueryFactory({
        sdkLoader: loaderFor(sdk).load,
        cliRunner: fakeCliRunner({ loggedIn: true, subscriptionType: "max" }, calls),
      }),
    });
    await drain(provider.sendQuery("one", "/tmp"));
    await drain(provider.sendQuery("two", "/tmp"));

    expect(calls.count).toBe(1);
  });
});

describe("ClaudeQueryFactory.detectSubscription", () => {
  it("true when the key-stripped status reports a subscription", async () => {
    const calls = { count: 0 };
    const factory = new ClaudeQueryFactory({
      cliRunner: fakeCliRunner({ loggedIn: true, subscriptionType: "max" }, calls),
    });
    expect(await factory.detectSubscription()).toBe(true);
    // The probe runs against an ANTHROPIC_API_KEY-stripped env.
    expect(calls.env).toBeDefined();
    expect(calls.env?.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("false when logged in via API key (no subscriptionType)", async () => {
    const factory = new ClaudeQueryFactory({
      cliRunner: fakeCliRunner({ loggedIn: true, subscriptionType: null }),
    });
    expect(await factory.detectSubscription()).toBe(false);
  });

  it("false when the CLI is not logged in / fails", async () => {
    const factory = new ClaudeQueryFactory({ cliRunner: fakeCliRunner({ fail: true }) });
    expect(await factory.detectSubscription()).toBe(false);
  });
});

describe("ClaudeProvider — happy path stream translation", () => {
  it("translates stream_event text deltas to text chunks", async () => {
    const sdk = makeMockSdk({
      scenario: async (push) => {
        await push({
          type: "system",
          subtype: "init",
          uuid: "init-uuid",
          session_id: "sess-id",
        });
        await push({
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "hel" } },
          uuid: "u1",
          session_id: "sess-id",
        });
        await push({
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo " } },
          uuid: "u2",
          session_id: "sess-id",
        });
        await push({
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "world" } },
          uuid: "u3",
          session_id: "sess-id",
        });
        // Final full assistant message — its text content must NOT be
        // re-emitted (deltas already covered it).
        await push({
          type: "assistant",
          message: { content: [{ type: "text", text: "hello world" }] },
          uuid: "a1",
          session_id: "sess-id",
        });
        await pushSuccess(push);
      },
    });
    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });

    const chunks = await drain(provider.sendQuery("hello", "/tmp"));

    expect(chunks).toHaveLength(3);
    expect(chunks.every((c) => c.type === "text")).toBe(true);
    expect(chunks.map((c) => (c as { content: string }).content).join("")).toBe("hello world");
    expect(sdk.lastPrompt()).toBe("hello");
  });

  it("translates tool_use content blocks to tool_use chunks", async () => {
    const sdk = makeMockSdk({
      scenario: async (push) => {
        await push({
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "toolu_abc123",
                name: "Read",
                input: { path: "/etc/hosts" },
              },
            ],
          },
          uuid: "a1",
          session_id: "sess-id",
        });
        await pushSuccess(push);
      },
    });
    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });

    const chunks = await drain(provider.sendQuery("hi", "/tmp"));

    expect(chunks).toHaveLength(1);
    // Phase 3 S2: id from the Anthropic content block forwards onto the
    // chunk so persisted contentParts can pair tool_use with tool_result.
    expect(chunks[0]).toEqual({
      type: "tool_use",
      id: "toolu_abc123",
      toolName: "Read",
      toolInput: { path: "/etc/hosts" },
    });
  });

  it("emits tool_result chunks from SDK user messages with matching tool_use_id (id pairing)", async () => {
    // The SDK injects a `user` message with a tool_result block carrying
    // Anthropic's original tool_use_id; synthesizing our own would orphan
    // the result on reload.
    const sdk = makeMockSdk({
      scenario: async (push) => {
        await push({
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "toolu_pair_42",
                name: "cluster",
                input: { persona: "shipper" },
              },
            ],
          },
          uuid: "a1",
          session_id: "sess-id",
        });
        // SDK echoes the result back as a user message after our handler
        // returns. tool_use_id MUST equal the originating tool_use.id.
        await push({
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_pair_42",
                content: '{"healthy": true}',
              },
            ],
          },
          parent_tool_use_id: null,
          uuid: "u1",
          session_id: "sess-id",
        } as ClaudeSdkMessage);
        await pushSuccess(push);
      },
    });
    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });

    const chunks = await drain(provider.sendQuery("status?", "/tmp"));
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.type).toBe("tool_use");
    expect(chunks[1]!.type).toBe("tool_result");
    if (chunks[0]!.type !== "tool_use" || chunks[1]!.type !== "tool_result")
      throw new Error("narrow");
    expect(chunks[0]!.id).toBe("toolu_pair_42");
    expect(chunks[1]!.toolUseId).toBe("toolu_pair_42");
    // The same id appears on both sides — UI <ToolCallsBlock> can now pair.
    expect(chunks[0]!.id).toBe(chunks[1]!.toolUseId);
    expect(chunks[1]!.content).toBe('{"healthy": true}');
  });

  it("propagates is_error from SDK user-message tool_result blocks", async () => {
    const sdk = makeMockSdk({
      scenario: async (push) => {
        await push({
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_err",
                content: "tool blew up",
                is_error: true,
              },
            ],
          },
          parent_tool_use_id: null,
          uuid: "u1",
          session_id: "sess-id",
        } as ClaudeSdkMessage);
        await pushSuccess(push);
      },
    });
    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });
    const chunks = await drain(provider.sendQuery("go", "/tmp"));
    expect(chunks).toHaveLength(1);
    const tr = chunks[0] as Extract<MessageChunk, { type: "tool_result" }>;
    expect(tr.toolUseId).toBe("toolu_err");
    expect(tr.content).toBe("tool blew up");
    expect(tr.isError).toBe(true);
  });

  it("stringifies array-shaped tool_result content (text blocks joined)", async () => {
    const sdk = makeMockSdk({
      scenario: async (push) => {
        await push({
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_arr",
                // Anthropic's ToolResultBlockParam.content union includes the
                // typed-block-array form. The mapper joins text fields and
                // drops non-text entries.
                content: [
                  { type: "text", text: "line one\n" },
                  { type: "text", text: "line two" },
                  { type: "image", source: "ignored" } as unknown as {
                    type: string;
                  },
                ],
              },
            ],
          },
          parent_tool_use_id: null,
          uuid: "u1",
          session_id: "sess-id",
        } as ClaudeSdkMessage);
        await pushSuccess(push);
      },
    });
    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });
    const chunks = await drain(provider.sendQuery("go", "/tmp"));
    expect(chunks).toHaveLength(1);
    const tr = chunks[0] as Extract<MessageChunk, { type: "tool_result" }>;
    expect(tr.content).toBe("line one\nline two");
  });

  it("ignores plain-string user-message content (typed user input — not a tool_result)", async () => {
    const sdk = makeMockSdk({
      scenario: async (push) => {
        await push({
          type: "user",
          message: { role: "user", content: "hello again" },
          parent_tool_use_id: null,
          uuid: "u1",
          session_id: "sess-id",
        } as unknown as ClaudeSdkMessage);
        await pushSuccess(push);
      },
    });
    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });
    const chunks = await drain(provider.sendQuery("hi", "/tmp"));
    // Plain string content is a user input echo — no chunk produced.
    expect(chunks).toHaveLength(0);
  });

  it("synthesizes a tool_use id when the content block omits one", async () => {
    const sdk = makeMockSdk({
      scenario: async (push) => {
        await push({
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                name: "Read",
                input: { path: "/etc/hosts" },
              },
            ],
          },
          uuid: "a1",
          session_id: "sess-id",
        });
        await pushSuccess(push);
      },
    });
    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });

    const chunks = await drain(provider.sendQuery("hi", "/tmp"));

    expect(chunks).toHaveLength(1);
    const chunk = chunks[0]!;
    expect(chunk.type).toBe("tool_use");
    if (chunk.type !== "tool_use") throw new Error("narrow");
    // Defensive synthesis: SDKs that omit id still pair via the synthesized
    // value (persisted contentParts require id on tool_use).
    expect(typeof chunk.id).toBe("string");
    expect(chunk.id!.length).toBeGreaterThan(0);
    expect(chunk.toolName).toBe("Read");
    expect(chunk.toolInput).toEqual({ path: "/etc/hosts" });
  });

  it("threads model and resume sessionId into SDK options", async () => {
    const sdk = makeMockSdk({ scenario: pushSuccess });
    const provider = new ClaudeProvider({
      getCredential: async () => undefined,
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });
    await drain(
      provider.sendQuery("hi", "/tmp", "prev-sess", {
        model: "claude-sonnet-4-6",
        systemPrompt: "you are concise",
      }),
    );

    const options = sdk.lastOptions()!;
    expect(options.resume).toBe("prev-sess");
    expect(options.model).toBe("claude-sonnet-4-6");
    expect(options.systemPrompt).toBe("you are concise");
    expect(options.includePartialMessages).toBe(true);
    expect(options.permissionMode).toBe("bypassPermissions");
    expect(options.cwd).toBe("/tmp");
  });

  it("maps allowedDirectories to additionalDirectories and path-aware permission mode", async () => {
    const sdk = makeMockSdk({ scenario: pushSuccess });
    const provider = new ClaudeProvider({
      getCredential: async () => undefined,
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });

    await drain(
      provider.sendQuery("hi", "/tmp", undefined, {
        allowedDirectories: ["/tmp/room", "/tmp/shared"],
      }),
    );

    const options = sdk.lastOptions()!;
    expect(options.additionalDirectories).toEqual(["/tmp/room", "/tmp/shared"]);
    expect(options.permissionMode).toBe("default");
  });

  it("reports max_tokens from the root assistant stop reason", async () => {
    const sdk = makeMockSdk({
      scenario: async (push) => {
        await push({
          type: "assistant",
          message: { content: [], stop_reason: "max_tokens" },
          uuid: "a1",
          session_id: "sess-id",
        });
        await pushSuccess(push);
      },
    });
    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });
    let finishReason: ProviderFinishReason | undefined;

    await drain(
      provider.sendQuery("hi", "/tmp", undefined, {
        onFinishReason: (reason) => {
          finishReason = reason;
        },
      }),
    );

    expect(finishReason).toBe("max_tokens");
  });

  it("maps model_context_window_exceeded to max_tokens", async () => {
    const sdk = makeMockSdk({
      scenario: async (push) => {
        await push({
          type: "assistant",
          message: { content: [], stop_reason: "model_context_window_exceeded" },
          uuid: "a1",
          session_id: "sess-id",
        });
        await pushSuccess(push);
      },
    });
    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });
    let finishReason: ProviderFinishReason | undefined;

    await drain(
      provider.sendQuery("hi", "/tmp", undefined, {
        onFinishReason: (reason) => {
          finishReason = reason;
        },
      }),
    );

    expect(finishReason).toBe("max_tokens");
  });

  it("reports end from the root assistant stop reason", async () => {
    const sdk = makeMockSdk({
      scenario: async (push) => {
        await push({
          type: "assistant",
          parent_tool_use_id: "toolu_task",
          message: { content: [], stop_reason: "max_tokens" },
          uuid: "a-sub",
          session_id: "sess-id",
        });
        await push({
          type: "assistant",
          message: { content: [], stop_reason: "end_turn" },
          uuid: "a-root",
          session_id: "sess-id",
        });
        await pushSuccess(push);
      },
    });
    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });
    let finishReason: ProviderFinishReason | undefined;

    await drain(
      provider.sendQuery("hi", "/tmp", undefined, {
        onFinishReason: (reason) => {
          finishReason = reason;
        },
      }),
    );

    expect(finishReason).toBe("end");
  });
});

describe("ClaudeProvider — extended thinking (F10.4)", () => {
  it("translates stream_event thinking_delta to thinking chunks", async () => {
    const sdk = makeMockSdk({
      scenario: async (push) => {
        await push({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "thinking_delta", thinking: "Let me " },
          },
          uuid: "t1",
          session_id: "sess-id",
        });
        await push({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "thinking_delta", thinking: "think." },
          },
          uuid: "t2",
          session_id: "sess-id",
        });
        // Full assistant message with a thinking block — the mapper drops
        // it (the deltas already covered the content) and only the answer
        // text would be emitted, so the assistant block here is empty.
        await push({
          type: "assistant",
          message: { content: [] },
          uuid: "a1",
          session_id: "sess-id",
        });
        await pushSuccess(push);
      },
    });
    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });

    const chunks = await drain(provider.sendQuery("hi", "/tmp"));

    expect(chunks).toHaveLength(2);
    expect(chunks.every((c) => c.type === "thinking")).toBe(true);
    const joined = chunks.map((c) => (c as { content: string }).content).join("");
    expect(joined).toBe("Let me think.");
  });

  it("ignores empty thinking_delta strings", async () => {
    const sdk = makeMockSdk({
      scenario: async (push) => {
        await push({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "thinking_delta", thinking: "" },
          },
          uuid: "t1",
          session_id: "sess-id",
        });
        await pushSuccess(push);
      },
    });
    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });

    const chunks = await drain(provider.sendQuery("hi", "/tmp"));
    expect(chunks).toHaveLength(0);
  });

  it("silently skips full thinking and redacted_thinking blocks in assistant messages", async () => {
    // Deltas are the source of truth; the full assistant message's thinking
    // block would be a duplicate. redacted_thinking has nothing the user
    // could read. Both must drop without producing chunks.
    const sdk = makeMockSdk({
      scenario: async (push) => {
        await push({
          type: "assistant",
          message: {
            content: [
              { type: "thinking", text: "should be ignored" },
              { type: "redacted_thinking" },
            ],
          },
          uuid: "a1",
          session_id: "sess-id",
        });
        await pushSuccess(push);
      },
    });
    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });

    const chunks = await drain(provider.sendQuery("hi", "/tmp"));
    expect(chunks).toHaveLength(0);
  });

  it("forwards thinking:true as adaptive thinking config to the SDK", async () => {
    const sdk = makeMockSdk({ scenario: pushSuccess });
    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });

    await drain(provider.sendQuery("hi", "/tmp", undefined, { thinking: true }));

    const options = sdk.lastOptions()!;
    expect(options.thinking).toEqual({
      type: "adaptive",
      display: "summarized",
    });
  });

  it("forwards thinking:false as disabled thinking config to the SDK", async () => {
    const sdk = makeMockSdk({ scenario: pushSuccess });
    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });

    await drain(provider.sendQuery("hi", "/tmp", undefined, { thinking: false }));

    const options = sdk.lastOptions()!;
    expect(options.thinking).toEqual({ type: "disabled" });
  });

  it("omits thinking option entirely when not specified (preserves SDK default)", async () => {
    const sdk = makeMockSdk({ scenario: pushSuccess });
    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });

    await drain(provider.sendQuery("hi", "/tmp"));

    const options = sdk.lastOptions()!;
    expect(options.thinking).toBeUndefined();
  });
});

describe("ClaudeProvider — error paths", () => {
  it("yields a friendly system message and throws when the SDK module fails to load", async () => {
    const provider = new ClaudeProvider({
      getCredential: async () => undefined,
      queryFactory: new ClaudeQueryFactory({
        sdkLoader: rejectingLoader(
          new Error("Cannot find module '@anthropic-ai/claude-agent-sdk'"),
        ),
      }),
    });

    const collected: MessageChunk[] = [];
    let thrown: unknown = null;
    try {
      for await (const c of provider.sendQuery("hi", "/tmp")) collected.push(c);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(collected).toHaveLength(1);
    const first = collected[0]!;
    expect(first.type).toBe("system");
    expect((first as { content: string }).content).toContain("Claude Agent SDK is not installed");
  });

  it("classifies a 401-style auth failure", () => {
    const msg = buildFriendlyClaudeError(new Error("401 invalid x-api-key"));
    expect(msg).toContain("Claude authentication failed");
  });

  it("classifies a rate-limit error", () => {
    const msg = buildFriendlyClaudeError(new Error("429 rate_limit"));
    expect(msg).toContain("rate limit");
  });

  it("yields an error chunk and throws when the result subtype is not success", async () => {
    const sdk = makeMockSdk({
      scenario: async (push) => {
        await push({
          type: "result",
          subtype: "error_max_turns",
          is_error: true,
          uuid: "r-uuid",
          session_id: "sess-id",
        });
      },
    });
    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });

    const collected: MessageChunk[] = [];
    let thrown: unknown = null;
    try {
      for await (const c of provider.sendQuery("hi", "/tmp")) collected.push(c);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(collected).toHaveLength(1);
    expect(collected[0]!.type).toBe("error");
  });

  it("yields an error chunk and throws when an assistant message carries an SDK error field", async () => {
    const sdk = makeMockSdk({
      scenario: async (push) => {
        await push({
          type: "assistant",
          error: "authentication_failed",
          message: { content: [] },
          uuid: "a1",
          session_id: "sess-id",
        });
        // No double-emit: even though a result would follow, the provider
        // throws on the assistant.error and never reaches it.
        await push({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: ["downstream auth rejected"],
          uuid: "r-uuid",
          session_id: "sess-id",
        });
      },
    });
    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });

    const collected: MessageChunk[] = [];
    let thrown: unknown = null;
    try {
      for await (const c of provider.sendQuery("hi", "/tmp")) collected.push(c);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(collected).toHaveLength(1);
    const first = collected[0]!;
    expect(first.type).toBe("error");
    expect((first as { message: string }).message).toContain("Claude authentication failed");
  });
});

describe("ClaudeProvider — abort", () => {
  it("returns immediately and skips SDK load when signal is pre-aborted", async () => {
    const sdk = makeMockSdk({ scenario: pushSuccess });
    const loader = loaderFor(sdk);
    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loader.load }),
    });

    const ac = new AbortController();
    ac.abort();
    const chunks = await drain(
      provider.sendQuery("hi", "/tmp", undefined, { abortSignal: ac.signal }),
    );

    expect(chunks).toHaveLength(0);
    expect(loader.count()).toBe(0);
  });

  it("stops draining and calls interrupt when aborted mid-stream", async () => {
    const ac = new AbortController();
    const sdk = makeMockSdk({
      scenario: async (push) => {
        await push({
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "first" } },
          uuid: "u1",
          session_id: "sess-id",
        });
        await push({
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "second" } },
          uuid: "u2",
          session_id: "sess-id",
        });
        await pushSuccess(push);
      },
    });
    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });

    // Consumer drives the abort after the first chunk lands — matches the
    // pattern in chat-route.test.ts and avoids producer-side scheduling races.
    const chunks: MessageChunk[] = [];
    for await (const c of provider.sendQuery("hi", "/tmp", undefined, {
      abortSignal: ac.signal,
    })) {
      chunks.push(c);
      if (chunks.length === 1) ac.abort();
    }

    expect(chunks).toHaveLength(1);
    expect((chunks[0] as { content: string }).content).toBe("first");
    expect(sdk.interruptCount()).toBe(1);
  });

  it("does NOT call interrupt on the success path", async () => {
    const sdk = makeMockSdk({ scenario: pushSuccess });
    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });

    await drain(provider.sendQuery("hi", "/tmp"));

    // The SDK tears itself down via its own return()/cleanup() on success;
    // calling interrupt() then would write through a closed transport.
    expect(sdk.interruptCount()).toBe(0);
  });

  it("detaches the inbound AbortSignal listener after sendQuery completes", async () => {
    const sdk = makeMockSdk({ scenario: pushSuccess });
    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });

    const ac = new AbortController();
    let attached = 0;
    let detached = 0;
    const origAdd = ac.signal.addEventListener.bind(ac.signal);
    const origRemove = ac.signal.removeEventListener.bind(ac.signal);
    ac.signal.addEventListener = ((...args: Parameters<typeof origAdd>) => {
      if (args[0] === "abort") attached++;
      return origAdd(...args);
    }) as typeof origAdd;
    ac.signal.removeEventListener = ((...args: Parameters<typeof origRemove>) => {
      if (args[0] === "abort") detached++;
      return origRemove(...args);
    }) as typeof origRemove;

    await drain(provider.sendQuery("hi", "/tmp", undefined, { abortSignal: ac.signal }));

    expect(attached).toBe(1);
    expect(detached).toBe(1);
  });
});

describe("ClaudeProvider — additional error paths", () => {
  it("passes SDKResultError.errors[] as hint to the friendly classifier", async () => {
    const sdk = makeMockSdk({
      scenario: async (push) => {
        await push({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: ["pipe broke at step 4", "downstream timeout"],
          uuid: "r-uuid",
          session_id: "sess-id",
        });
      },
    });
    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });

    const collected: MessageChunk[] = [];
    let thrown: unknown = null;
    try {
      for await (const c of provider.sendQuery("hi", "/tmp")) collected.push(c);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(collected).toHaveLength(1);
    const message = (collected[0] as { message: string }).message;
    // Friendly classifier output includes the joined `errors` array as a hint.
    expect(message).toContain("pipe broke at step 4");
    expect(message).toContain("downstream timeout");
  });

  it("classifies max_turns / budget limits with a dedicated friendly message", () => {
    expect(buildFriendlyClaudeError(new Error("error_max_turns"))).toContain(
      "hit a configured turn or budget limit",
    );
    expect(buildFriendlyClaudeError(new Error("error_max_budget_usd"))).toContain(
      "hit a configured turn or budget limit",
    );
  });

  it("classifies invalid_request with prompt-shape guidance", () => {
    const msg = buildFriendlyClaudeError(new Error("invalid_request: bad tool input"));
    expect(msg).toContain("invalid_request");
    expect(msg).toContain("prompt or attached tools");
  });

  it("classifies SDK 'overloaded' as a rate-limit signal, not an entitlement error", () => {
    const msg = buildFriendlyClaudeError(new Error("overloaded"));
    expect(msg).toContain("rate limit");
  });

  it("propagates producer errors and runs cleanup", async () => {
    const sdk = makeMockSdk({
      scenario: async (push) => {
        await push({
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } },
          uuid: "u1",
          session_id: "sess-id",
        });
        throw new Error("stream pipe collapsed");
      },
    });
    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });

    const collected: MessageChunk[] = [];
    let thrown: unknown = null;
    try {
      for await (const c of provider.sendQuery("hi", "/tmp")) collected.push(c);
    } catch (err) {
      thrown = err;
    }

    // First chunk landed before the producer threw.
    expect(collected).toHaveLength(1);
    expect((collected[0] as { content: string }).content).toBe("partial");
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("stream pipe collapsed");
    // Success-path: interrupt should NOT be called even when the iterator
    // throws — the SDK has already errored out of its own state.
    expect(sdk.interruptCount()).toBe(0);
  });
});

describe("ClaudeProvider — defaultModel + listModels", () => {
  it("capabilities pin the opus model as the default over the family catalog", () => {
    expect(CLAUDE_DEFAULT_MODEL).toBe("claude-opus-4-8");
    expect(CLAUDE_CAPABILITIES.defaultModel).toBe(CLAUDE_DEFAULT_MODEL);
    expect(CLAUDE_CAPABILITIES.models).toContain(CLAUDE_DEFAULT_MODEL);
    expect([...CLAUDE_CAPABILITIES.models]).toEqual([
      "claude-fable-5",
      "claude-opus-4-8",
      "claude-sonnet-5",
      "claude-haiku-4-5",
    ]);
  });

  it("listModels() returns the curated catalog with metadata", async () => {
    // The Anthropic Agent SDK has no live model list endpoint, so the
    // provider serves a curated catalog. F10.2 widened the return from
    // bare ids to ModelInfo carrying displayName / costTier / supports.
    const provider = new ClaudeProvider({
      getCredential: async () => undefined,
    });
    const models = await provider.listModels();
    // Same ids as capabilities.models, same order, full metadata.
    expect(models.map((m) => m.id)).toEqual([...CLAUDE_CAPABILITIES.models]);
    // All Claude entries support thinking — F10.4 reads this flag to gate
    // the per-turn thinking chip in the composer.
    expect(models.every((m) => m.supports?.thinking === true)).toBe(true);
    // Every entry has a displayName and a costTier.
    expect(models.every((m) => typeof m.displayName === "string")).toBe(true);
    expect(models.every((m) => m.costTier !== undefined)).toBe(true);
  });

  it("listModels() deep-clones the supports block (callers can't mutate the catalog)", async () => {
    const provider = new ClaudeProvider({
      getCredential: async () => undefined,
    });
    const first = await provider.listModels();
    // Mutate the returned object.
    if (first[0]!.supports) first[0]!.supports.vision = false;
    const second = await provider.listModels();
    expect(second[0]!.supports?.vision).toBe(true);
  });
});

describe("ClaudeProvider — Phase 3 S2 tool wiring", () => {
  // Stub ToolDefinition for the projection tests. The handler is invoked
  // only when the SDK calls back into our wrapper; these tests assert the
  // PROJECTION shape reaches the SDK, not the runtime handler path.
  const fakeTool = {
    name: "cluster",
    description: "Cluster status collector",
    inputSchema: (() => {
      // Inline minimal Zod-like surface — the tests below don't actually
      // parse anything (SDK never invokes the handler here), so the schema
      // doesn't need real validation logic.
      return { _output: {}, safeParse: () => ({ success: true, data: {} }) };
    })() as unknown as import("@keelson/shared").ToolDefinition["inputSchema"],
    execute: async () => {},
  } as unknown as import("@keelson/shared").ToolDefinition;

  it("threads SendQueryOptions.tools into an SDK MCP server via mcpServers", async () => {
    const mcpInstance = { __probe: "mcp-server" };
    let receivedServerOptions: {
      name: string;
      version?: string;
      tools?: Array<{ name: string; description: string }>;
    } | null = null;

    const sdk = makeMockSdk({ scenario: pushSuccess });
    // Augment the mock SDK with createSdkMcpServer — opt-in surface that the
    // factory checks before projecting tools, so existing tests stay unaffected.
    sdk.module.createSdkMcpServer = (opts: {
      name: string;
      version?: string;
      tools?: Array<{ name: string; description: string }>;
    }) => {
      receivedServerOptions = opts;
      return mcpInstance;
    };
    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });

    await drain(provider.sendQuery("hi", "/tmp", undefined, { tools: [fakeTool] }));

    expect(receivedServerOptions).not.toBeNull();
    expect(receivedServerOptions!.name).toBe("keelson");
    expect(receivedServerOptions!.tools).toHaveLength(1);
    expect(receivedServerOptions!.tools![0]!.name).toBe("cluster");
    expect(receivedServerOptions!.tools![0]!.description).toBe("Cluster status collector");

    const options = sdk.lastOptions()!;
    expect(options.mcpServers).toBeDefined();
    expect(options.mcpServers!.keelson).toBe(mcpInstance);
  });

  it("projects ZodObject input schemas via .shape (Codex P2: required-arg tools)", async () => {
    // Regression: empty `inputSchema:{}` would advertise a zero-arg tool to
    // the SDK, so required-arg skills (e.g. read_file(path)) would never
    // receive their args. The projection must expose the skill's
    // ZodObject `.shape` so the SDK converts it to JSON Schema correctly.
    let receivedSchema: unknown = "not-set";

    const realTool = {
      name: "read_file",
      description: "Read a file",
      inputSchema: z
        .object({
          path: z.string(),
          encoding: z.enum(["utf-8", "binary"]).optional(),
        })
        .strict(),
      execute: async () => {},
    } as import("@keelson/shared").ToolDefinition;

    const sdk = makeMockSdk({ scenario: pushSuccess });
    sdk.module.createSdkMcpServer = (opts: {
      name: string;
      tools?: Array<{ name: string; inputSchema: unknown }>;
    }) => {
      const t = opts.tools?.[0];
      receivedSchema = t ? t.inputSchema : null;
      return { __probe: "mcp-server" };
    };
    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });
    await drain(provider.sendQuery("hi", "/tmp", undefined, { tools: [realTool] }));

    // The projected shape is z.object(...).shape — a record keyed by the
    // schema's field names. The SDK wraps this in z.object(shape) and
    // toJSONSchemas it for the model.
    expect(receivedSchema).not.toBe("not-set");
    expect(receivedSchema).not.toBeNull();
    const shape = receivedSchema as Record<string, unknown>;
    expect(Object.keys(shape).sort()).toEqual(["encoding", "path"]);
    // Each value is the field's zod schema (defensive — exact identity
    // can't be asserted without a deep zod compare, but the keys are the
    // load-bearing part of the projection).
    expect(shape.path).toBeDefined();
    expect(shape.encoding).toBeDefined();
  });

  it("forwards options.allowedTools / disallowedTools to SDK, expanded with mcp__keelson__ prefix for bare names", async () => {
    const sdk = makeMockSdk({ scenario: pushSuccess });
    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });
    await drain(
      provider.sendQuery("hi", "/tmp", undefined, {
        allowedTools: ["Read", "repo_get_kube"],
        disallowedTools: ["Bash"],
      }),
    );
    const options = sdk.lastOptions()!;
    // Each bare name expands to itself + the MCP-wrapped form. SDK built-ins
    // (Read, Bash) won't match the wrapped form but the SDK ignores unmatched
    // allowlist entries — extra harmless. Authors naming MCP tools
    // (repo_get_kube) reach the real SDK identifier via the wrapped form.
    expect(options.allowedTools).toEqual([
      "Read",
      "mcp__keelson__Read",
      "repo_get_kube",
      "mcp__keelson__repo_get_kube",
    ]);
    expect(options.disallowedTools).toEqual(["Bash", "mcp__keelson__Bash"]);
  });

  it("forwards allowedTools to SDK Options.tools (built-in catalog gate) AND Options.allowedTools (auto-allow hint), with MCP names filtered out of Options.tools", async () => {
    // Regression for the Codex finding: under `bypassPermissions` the SDK
    // skips all permission checks, which makes `allowedTools` toothless as
    // a catalog gate (it's a permission auto-allow list per the SDK docs).
    // Options.tools is the load-bearing field — string[] removes any
    // built-in tool not listed from the model's context. We set both fields
    // so the SDK has a hard gate AND a permission hint, BUT Options.tools
    // must only contain names the SDK recognizes as built-ins; MCP tools
    // come via mcpServers and any MCP names in Options.tools would be
    // rejected by the CLI as unknown.
    const sdk = makeMockSdk({ scenario: pushSuccess });
    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });
    await drain(
      provider.sendQuery("hi", "/tmp", undefined, {
        allowedTools: ["Read", "repo_get_kube", "mcp__keelson__gitlab_list_mrs"],
        tools: [fakeTool],
      }),
    );
    const options = sdk.lastOptions()!;
    // Options.tools carries only NON-MCP names: "Read" (built-in), with
    // "repo_get_kube" (filtered: it's a registered MCP tool via fakeTool's
    // "cluster" name; we'd typically filter via membership in params.tools)
    // and "mcp__keelson__gitlab_list_mrs" (filtered: explicit mcp__
    // prefix). The remaining bare name that doesn't match the MCP catalog
    // also passes through (the SDK will simply ignore unknown built-ins).
    expect(options.tools).toEqual(["Read", "repo_get_kube"]);
    // Options.allowedTools carries the expanded MCP-wrapped variants too so
    // the auto-allow hint also matches our registered skills' SDK names.
    expect(options.allowedTools).toEqual([
      "Read",
      "mcp__keelson__Read",
      "repo_get_kube",
      "mcp__keelson__repo_get_kube",
      "mcp__keelson__gitlab_list_mrs",
    ]);
    // permissionMode stays on the default we've always shipped — Options.tools
    // is the gate, not the permission mode.
    expect(options.permissionMode).toBe("bypassPermissions");
  });

  it("filters globally-denied MCP names out of Options.tools via the unfiltered registry hint", async () => {
    // Regression: when allowed_tools names an MCP tool that the prompt
    // handler removed from filteredTools (e.g. kube_delete_cluster got
    // dropped by the global denylist), the factory previously saw it only
    // in params.allowedTools (not in params.tools) and forwarded it via
    // Options.tools, where the SDK rejects it as an unknown built-in.
    // `registeredMcpToolNames` is the unfiltered catalog hint that lets
    // the factory recognize the name as MCP even though the projection
    // dropped it.
    const sdk = makeMockSdk({ scenario: pushSuccess });
    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });
    await drain(
      provider.sendQuery("hi", "/tmp", undefined, {
        allowedTools: ["Read", "kube_delete_cluster"],
        // params.tools is empty (denied tool was filtered out by prompt
        // handler before reaching the provider), but the registry hint
        // tells the factory the name is MCP.
        registeredMcpToolNames: ["kube_delete_cluster", "repo_get_kube"],
      }),
    );
    const options = sdk.lastOptions()!;
    expect(options.tools).toEqual(["Read"]);
    // allowedTools still carries the literal author intent + expansion.
    expect(options.allowedTools).toEqual([
      "Read",
      "mcp__keelson__Read",
      "kube_delete_cluster",
      "mcp__keelson__kube_delete_cluster",
    ]);
  });

  it("filters MCP-registered tool names out of Options.tools (they come via mcpServers, not built-ins)", async () => {
    // When the allow-list names a tool that's also in our registered MCP
    // catalog (i.e., reachable via mcpServers), it must NOT appear in
    // Options.tools — the SDK would reject it as an unknown built-in.
    const sdk = makeMockSdk({ scenario: pushSuccess });
    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });
    // fakeTool has name "cluster" (see fakeTool definition at top of this
    // describe block) — the factory should detect that and strip it from
    // Options.tools. (mcpServers creation requires createSdkMcpServer on
    // the mock SDK which other tests opt into; here we only assert the
    // filtering behavior on Options.tools.)
    await drain(
      provider.sendQuery("hi", "/tmp", undefined, {
        allowedTools: ["Read", "cluster"],
        tools: [fakeTool],
      }),
    );
    const options = sdk.lastOptions()!;
    expect(options.tools).toEqual(["Read"]);
  });

  it("empty allowedTools array sets Options.tools=[] which disables all built-ins", async () => {
    const sdk = makeMockSdk({ scenario: pushSuccess });
    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });
    // Per SDK docs: `tools: []` disables all built-in tools. Combined with
    // an empty mcpServers projection at the prompt-handler layer, the model
    // has zero tools — text-only generation.
    await drain(provider.sendQuery("hi", "/tmp", undefined, { allowedTools: [] }));
    const options = sdk.lastOptions()!;
    expect(options.tools).toEqual([]);
    expect(options.allowedTools).toEqual([]);
  });

  it("does NOT set Options.tools when only disallowedTools is provided", async () => {
    const sdk = makeMockSdk({ scenario: pushSuccess });
    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });
    await drain(
      provider.sendQuery("hi", "/tmp", undefined, {
        disallowedTools: ["Bash"],
      }),
    );
    const options = sdk.lastOptions()!;
    // disallowedTools alone doesn't need a catalog override — the SDK
    // removes named built-ins from context unconditionally.
    expect(options.tools).toBeUndefined();
    expect(options.disallowedTools).toEqual(["Bash", "mcp__keelson__Bash"]);
    expect(options.permissionMode).toBe("bypassPermissions");
  });

  it("leaves already-wrapped mcp__ names unchanged", async () => {
    const sdk = makeMockSdk({ scenario: pushSuccess });
    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });
    await drain(
      provider.sendQuery("hi", "/tmp", undefined, {
        allowedTools: ["mcp__keelson__repo_get_kube", "Read"],
      }),
    );
    const options = sdk.lastOptions()!;
    // Pre-wrapped name passes through as-is (no double prefix); Read still
    // gets its companion wrapped form.
    expect(options.allowedTools).toEqual([
      "mcp__keelson__repo_get_kube",
      "Read",
      "mcp__keelson__Read",
    ]);
  });

  it("forwards an empty allowedTools array (model gets no tools)", async () => {
    const sdk = makeMockSdk({ scenario: pushSuccess });
    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });
    // `[]` is meaningful (forbids every tool); the conditional spread in the
    // provider checks `!== undefined`, not truthy, so it must reach the SDK.
    await drain(provider.sendQuery("hi", "/tmp", undefined, { allowedTools: [] }));
    const options = sdk.lastOptions()!;
    expect(options.allowedTools).toEqual([]);
    expect(options.disallowedTools).toBeUndefined();
  });

  it("projects per-node YAML hooks into SDK Options.hooks (matcher + async callback returning canned response)", async () => {
    const sdk = makeMockSdk({ scenario: pushSuccess });
    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });
    await drain(
      provider.sendQuery("hi", "/tmp", undefined, {
        hooks: {
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
                },
              },
              timeout: 30,
            },
          ],
        },
      }),
    );
    const options = sdk.lastOptions()!;
    const sdkHooks = options.hooks as Record<
      string,
      Array<{
        matcher?: string;
        hooks: Array<(input: unknown) => Promise<unknown>>;
        timeout?: number;
      }>
    >;
    expect(sdkHooks).toBeDefined();
    expect(Object.keys(sdkHooks).sort()).toEqual(["PostToolUse", "PreToolUse"]);

    const post = sdkHooks.PostToolUse![0]!;
    expect(post.matcher).toBe("Read");
    expect(post.hooks).toHaveLength(1);
    const postResult = await post.hooks[0]!({ tool_name: "Read" });
    expect(postResult).toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: "assess what you just read",
      },
    });

    const pre = sdkHooks.PreToolUse![0]!;
    expect(pre.matcher).toBe("Bash");
    expect(pre.timeout).toBe(30);
  });

  it("omits hooks when no per-node hooks are provided", async () => {
    const sdk = makeMockSdk({ scenario: pushSuccess });
    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });
    await drain(provider.sendQuery("hi", "/tmp", undefined, {}));
    const options = sdk.lastOptions()!;
    expect(options.hooks).toBeUndefined();
  });

  it("wires the built-in policy gate as a PreToolUse hook (no keelson tools needed)", async () => {
    const sdk = makeMockSdk({ scenario: pushSuccess });
    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });
    const seen: string[] = [];
    const gate = async (call: { tool: string; args?: unknown }) => {
      seen.push(call.tool);
      return call.tool === "Bash"
        ? { outcome: "deny" as const, reason: "shell blocked by policy" }
        : { outcome: "allow" as const };
    };
    // No `tools` — the gate must reach a PreToolUse hook so the agent's OWN
    // built-in Bash/Edit/Write route through the engine under bypassPermissions.
    await drain(provider.sendQuery("hi", "/tmp", undefined, { evaluateToolCall: gate }));
    const sdkHooks = sdk.lastOptions()!.hooks as Record<
      string,
      Array<{ matcher?: string; hooks: Array<(input: unknown) => Promise<unknown>> }>
    >;
    expect(sdkHooks).toBeDefined();
    const pre = sdkHooks.PreToolUse![0]!;
    expect(await pre.hooks[0]!({ tool_name: "Bash", tool_input: { command: "ls" } })).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringContaining("shell blocked by policy"),
      },
    });
    expect(await pre.hooks[0]!({ tool_name: "Read", tool_input: {} })).toEqual({});
    // MCP/skill calls are gated in the tool handler, not here — the hook skips them.
    expect(await pre.hooks[0]!({ tool_name: "mcp__keelson__x", tool_input: {} })).toEqual({});
    expect(seen).toEqual(["Bash", "Read"]);
  });

  it("runs the built-in policy gate before user PreToolUse hooks (gate first, user second)", async () => {
    const sdk = makeMockSdk({ scenario: pushSuccess });
    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });
    await drain(
      provider.sendQuery("hi", "/tmp", undefined, {
        evaluateToolCall: async () => ({ outcome: "allow" as const }),
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              response: {
                hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
              },
            },
          ],
        },
      }),
    );
    // Gate first so its deny is enforced before a user "allow" could pre-approve.
    const sdkHooks = sdk.lastOptions()!.hooks as Record<string, Array<{ matcher?: string }>>;
    expect(sdkHooks.PreToolUse).toHaveLength(2);
    expect(sdkHooks.PreToolUse![0]!.matcher).toBeUndefined(); // built-in gate (matcher-less)
    expect(sdkHooks.PreToolUse![1]!.matcher).toBe("Bash"); // user hook
  });

  it("omits allowedTools / disallowedTools when not provided", async () => {
    const sdk = makeMockSdk({ scenario: pushSuccess });
    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });
    await drain(provider.sendQuery("hi", "/tmp", undefined, {}));
    const options = sdk.lastOptions()!;
    expect(options.allowedTools).toBeUndefined();
    expect(options.disallowedTools).toBeUndefined();
  });

  it("yields tool-emitted chunks concurrently with SDK iteration (Codex P2)", async () => {
    // Regression: previously the provider drained tool-emitted chunks only
    // BETWEEN SDK messages. A slow tool's progress would buffer until the
    // SDK yielded its next message — i.e. not until the tool returned.
    // With the producer-consumer queue refactor, a chunk pushed via
    // ctx.emit reaches the consumer immediately, regardless of where the
    // SDK iterable is parked.
    let projectedHandler: ((args: unknown, extra: unknown) => Promise<unknown>) | null = null;

    let releaseTool: (() => void) | null = null;
    const toolBlock = new Promise<void>((r) => {
      releaseTool = r;
    });

    type ToolCtx = import("@keelson/shared").ToolContext;
    const slowTool = {
      name: "slow",
      description: "emits progress mid-execute",
      inputSchema: z.object({}).strict(),
      async execute(_input: unknown, ctx: ToolCtx) {
        ctx.emit({ type: "text", content: "progress-1" });
        await toolBlock; // hang until the test releases — simulates a long
        // mid-tool await without depending on real wall-clock time.
        ctx.emit({ type: "text", content: "progress-2" });
      },
    } as import("@keelson/shared").ToolDefinition;

    let releaseScenario: (() => void) | null = null;
    const scenarioBlock = new Promise<void>((r) => {
      releaseScenario = r;
    });

    const sdk = makeMockSdk({
      scenario: async (push) => {
        // Assistant emits the tool_use block; then the scenario HANGS so
        // the SDK iterable cannot move forward. Without concurrent drain,
        // the consumer would wedge here regardless of what the tool emits.
        await push({
          type: "assistant",
          message: {
            content: [{ type: "tool_use", id: "tu_slow", name: "slow", input: {} }],
          },
          uuid: "a1",
          session_id: "sess-id",
        });
        await scenarioBlock;
        await pushSuccess(push);
      },
    });
    sdk.module.createSdkMcpServer = (opts: {
      name: string;
      tools?: Array<{
        handler: (args: unknown, extra: unknown) => Promise<unknown>;
      }>;
    }) => {
      projectedHandler = opts.tools?.[0]?.handler ?? null;
      return {};
    };

    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });

    const gen = provider.sendQuery("hi", "/tmp", undefined, {
      tools: [slowTool],
    });

    // First yielded chunk: the assistant message's tool_use block.
    const c1 = await gen.next();
    expect(c1.done).toBe(false);
    expect(c1.value!.type).toBe("tool_use");

    // Now invoke the projected handler — simulates the SDK calling our
    // wrapper. The handler is async and pauses on toolBlock after the
    // first ctx.emit, so the consumer should see progress-1 immediately
    // while the SDK scenario is still hung on scenarioBlock.
    expect(projectedHandler).not.toBeNull();
    const handlerPromise = projectedHandler!({}, {});

    const c2 = await gen.next();
    expect(c2.done).toBe(false);
    expect(c2.value!.type).toBe("text");
    expect((c2.value as { content: string }).content).toBe("progress-1");
    // ↑ This assertion would TIMEOUT with the old toolEmitQueue array drain
    // because gen.next() would be blocked on the SDK's next message, which
    // can't arrive until the scenario unblocks.

    // Release the tool's mid-execute hang; second progress chunk drains.
    releaseTool!();
    await handlerPromise;

    const c3 = await gen.next();
    expect(c3.done).toBe(false);
    expect(c3.value!.type).toBe("text");
    expect((c3.value as { content: string }).content).toBe("progress-2");

    // Drain to completion so the producer settles cleanly.
    releaseScenario!();
    const rest: MessageChunk[] = [];
    for await (const chunk of gen) rest.push(chunk);
  });

  it("falls back to empty shape for non-ZodObject input schemas", async () => {
    // Primitive/union inputSchema falls back to {} — the model sees a zero-arg tool.
    let receivedSchema: unknown = "not-set";

    const primitiveTool = {
      name: "primitive",
      description: "Takes a bare string",
      inputSchema: z.string(),
      execute: async () => {},
    } as import("@keelson/shared").ToolDefinition;

    const sdk = makeMockSdk({ scenario: pushSuccess });
    sdk.module.createSdkMcpServer = (opts: {
      name: string;
      tools?: Array<{ name: string; inputSchema: unknown }>;
    }) => {
      const t = opts.tools?.[0];
      receivedSchema = t ? t.inputSchema : null;
      return {};
    };
    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });
    await drain(provider.sendQuery("hi", "/tmp", undefined, { tools: [primitiveTool] }));

    expect(receivedSchema).toEqual({});
  });

  it("omits mcpServers entirely when no tools are passed", async () => {
    const sdk = makeMockSdk({ scenario: pushSuccess });
    let createServerCalled = false;
    sdk.module.createSdkMcpServer = () => {
      createServerCalled = true;
      return {};
    };
    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });

    await drain(provider.sendQuery("hi", "/tmp"));

    expect(createServerCalled).toBe(false);
    expect(sdk.lastOptions()!.mcpServers).toBeUndefined();
  });

  it("skips MCP projection when SDK lacks createSdkMcpServer (back-compat)", async () => {
    const sdk = makeMockSdk({ scenario: pushSuccess });
    // Intentionally do NOT install createSdkMcpServer — exercises the
    // structural mock SDK path so older test fixtures continue to work.
    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });

    await drain(provider.sendQuery("hi", "/tmp", undefined, { tools: [fakeTool] }));

    // Without createSdkMcpServer, the projection is a no-op — turn proceeds
    // without tools rather than crashing on the missing capability.
    expect(sdk.lastOptions()!.mcpServers).toBeUndefined();
  });
});

describe("ClaudeProvider — token usage (chat/workflow usage feedback)", () => {
  it("emits a usage chunk built from result.usage, last assistant call usage, and modelUsage", async () => {
    const sdk = makeMockSdk({
      scenario: async (push) => {
        await push({
          type: "assistant",
          message: {
            content: [{ type: "text", text: "step one" }],
            usage: { input_tokens: 12, output_tokens: 5, cache_read_input_tokens: 100 },
          },
          uuid: "a1",
          session_id: "sess-id",
        });
        // Second API call of the same turn — this one is the context measure.
        await push({
          type: "assistant",
          message: {
            content: [{ type: "text", text: "step two" }],
            usage: {
              input_tokens: 20,
              output_tokens: 9,
              cache_read_input_tokens: 150,
              cache_creation_input_tokens: 30,
            },
          },
          uuid: "a2",
          session_id: "sess-id",
        });
        await push({
          type: "result",
          subtype: "success",
          is_error: false,
          usage: {
            input_tokens: 32,
            output_tokens: 14,
            cache_read_input_tokens: 250,
            cache_creation_input_tokens: 30,
          },
          modelUsage: { "claude-haiku-4-5": { contextWindow: 200000 } },
          uuid: "result-uuid",
          session_id: "sess-id",
        } as ClaudeSdkMessage);
      },
    });
    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });

    const chunks = await drain(provider.sendQuery("hi", "/tmp"));

    const usageChunks = chunks.filter((c) => c.type === "usage");
    expect(usageChunks).toHaveLength(1);
    expect(usageChunks[0]).toEqual({
      type: "usage",
      usage: {
        inputTokens: 32,
        outputTokens: 14,
        cacheReadInputTokens: 250,
        cacheCreationInputTokens: 30,
        // last call: 20 input + 150 cache read + 30 cache creation
        contextTokens: 200,
        contextWindow: 200000,
      },
    });
  });

  it("emits no usage chunk when the result carries no counts", async () => {
    const sdk = makeMockSdk({ scenario: pushSuccess });
    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });

    const chunks = await drain(provider.sendQuery("hi", "/tmp"));

    expect(chunks.filter((c) => c.type === "usage")).toHaveLength(0);
  });

  it("still emits usage on an error result — the failed turn spent tokens", async () => {
    const sdk = makeMockSdk({
      scenario: async (push) => {
        await push({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: ["boom"],
          usage: { input_tokens: 7, output_tokens: 3 },
          uuid: "result-uuid",
          session_id: "sess-id",
        } as ClaudeSdkMessage);
      },
    });
    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });

    const chunks: MessageChunk[] = [];
    let threw = false;
    try {
      for await (const chunk of provider.sendQuery("hi", "/tmp")) chunks.push(chunk);
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    const usageChunks = chunks.filter((c) => c.type === "usage");
    expect(usageChunks).toHaveLength(1);
    expect(usageChunks[0]).toEqual({
      type: "usage",
      usage: { inputTokens: 7, outputTokens: 3 },
    });
  });
});

describe("ClaudeProvider — token usage edge cases", () => {
  it("ignores subagent assistant usage for the context measure (parent_tool_use_id set)", async () => {
    const sdk = makeMockSdk({
      scenario: async (push) => {
        // Root agent's call — this is the conversation's real context.
        await push({
          type: "assistant",
          message: {
            content: [{ type: "text", text: "orchestrating" }],
            usage: { input_tokens: 150000, cache_read_input_tokens: 40000 },
          },
          uuid: "a-root",
          session_id: "sess-id",
        });
        // Task subagent's call — tiny fresh context, must not win.
        await push({
          type: "assistant",
          parent_tool_use_id: "toolu_task_1",
          message: {
            content: [{ type: "text", text: "subagent reply" }],
            usage: { input_tokens: 3000, output_tokens: 50 },
          },
          uuid: "a-sub",
          session_id: "sess-id",
        });
        await push({
          type: "result",
          subtype: "success",
          is_error: false,
          usage: { input_tokens: 153000, output_tokens: 500 },
          uuid: "result-uuid",
          session_id: "sess-id",
        } as ClaudeSdkMessage);
      },
    });
    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });

    const chunks = await drain(provider.sendQuery("hi", "/tmp"));
    const usageChunk = chunks.find((c) => c.type === "usage");
    expect(usageChunk).toBeDefined();
    if (usageChunk && usageChunk.type === "usage") {
      // 150000 + 40000 from the root call, NOT 3000 from the subagent.
      expect(usageChunk.usage.contextTokens).toBe(190000);
    }
  });

  it("omits zero-valued cache fields so a cache-miss turn renders no cache rows", async () => {
    const sdk = makeMockSdk({
      scenario: async (push) => {
        await push({
          type: "result",
          subtype: "success",
          is_error: false,
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          uuid: "result-uuid",
          session_id: "sess-id",
        } as ClaudeSdkMessage);
      },
    });
    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });

    const chunks = await drain(provider.sendQuery("hi", "/tmp"));
    const usageChunk = chunks.find((c) => c.type === "usage");
    expect(usageChunk).toEqual({
      type: "usage",
      usage: { inputTokens: 100, outputTokens: 20 },
    });
  });

  it("keeps Anthropic input_tokens fresh-only when cache fields are present", async () => {
    const sdk = makeMockSdk({
      scenario: async (push) => {
        await push({
          type: "result",
          subtype: "success",
          is_error: false,
          usage: {
            input_tokens: 10,
            output_tokens: 3,
            cache_read_input_tokens: 90,
            cache_creation_input_tokens: 5,
          },
          uuid: "result-uuid",
          session_id: "sess-id",
        } as ClaudeSdkMessage);
      },
    });
    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });

    const chunks = await drain(provider.sendQuery("hi", "/tmp"));
    const usageChunk = chunks.find((c) => c.type === "usage");
    expect(usageChunk).toEqual({
      type: "usage",
      usage: {
        inputTokens: 10,
        outputTokens: 3,
        cacheReadInputTokens: 90,
        cacheCreationInputTokens: 5,
      },
    });
  });

  it("emits no usage chunk when the assistant message has an empty usage object and result has no usage", async () => {
    const sdk = makeMockSdk({
      scenario: async (push) => {
        await push({
          type: "assistant",
          message: { content: [{ type: "text", text: "hi" }], usage: {} },
          uuid: "a1",
          session_id: "sess-id",
        } as ClaudeSdkMessage);
        await push({
          type: "result",
          subtype: "success",
          is_error: false,
          uuid: "result-uuid",
          session_id: "sess-id",
        });
      },
    });
    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });

    const chunks = await drain(provider.sendQuery("hi", "/tmp"));
    expect(chunks.filter((c) => c.type === "usage")).toHaveLength(0);
  });
});

describe("ClaudeProvider — usage built from partial result data", () => {
  it("emits usage when the result carries only cache counts (no input/output)", async () => {
    const sdk = makeMockSdk({
      scenario: async (push) => {
        await push({
          type: "result",
          subtype: "success",
          is_error: false,
          usage: { cache_read_input_tokens: 50000 },
          uuid: "result-uuid",
          session_id: "sess-id",
        } as ClaudeSdkMessage);
      },
    });
    const provider = new ClaudeProvider({
      getCredential: async () => "k",
      queryFactory: new ClaudeQueryFactory({ sdkLoader: loaderFor(sdk).load }),
    });

    const chunks = await drain(provider.sendQuery("hi", "/tmp"));
    const usageChunk = chunks.find((c) => c.type === "usage");
    expect(usageChunk).toEqual({
      type: "usage",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 50000 },
    });
  });
});

describe("projectToolsForClaude — per-call policy gate", () => {
  const echoTool = (execute?: ToolDefinition["execute"]): ToolDefinition =>
    ({
      name: "echo",
      description: "Echo the input",
      inputSchema: z.object({ value: z.string() }),
      execute:
        execute ??
        (async (input, ctx) => {
          ctx.emit({
            type: "tool_result",
            toolUseId: "",
            content: `echo:${(input as { value: string }).value}`,
          });
        }),
    }) as ToolDefinition;

  const projection = (
    gate?: ClaudeToolProjectionContext["evaluateToolCall"],
    resultGate?: ClaudeToolProjectionContext["evaluateToolResult"],
  ): ClaudeToolProjectionContext => ({
    pushChunk: () => {},
    contextFactory: () => ({
      cwd: "/tmp",
      emit: () => {},
      abortSignal: new AbortController().signal,
    }),
    ...(gate ? { evaluateToolCall: gate } : {}),
    ...(resultGate ? { evaluateToolResult: resultGate } : {}),
  });

  it("returns an error tool_result and skips execute when the gate denies", async () => {
    let executed = false;
    const tool = echoTool(async () => {
      executed = true;
    });
    const [def] = projectToolsForClaude(
      [tool],
      projection(async () => ({ outcome: "deny", reason: "no writes" })),
    );
    if (!def) throw new Error("narrow");
    const result = await def.handler({ value: "x" }, {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Tool 'echo' denied by policy: no writes");
    expect(executed).toBe(false);
  });

  it("runs the tool when the gate allows, receiving the validated args", async () => {
    let seenArgs: unknown;
    const [def] = projectToolsForClaude(
      [echoTool()],
      projection(async (call) => {
        seenArgs = call.args;
        return { outcome: "allow" };
      }),
    );
    if (!def) throw new Error("narrow");
    const result = await def.handler({ value: "hi" }, {});
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toBe("echo:hi");
    expect(seenArgs).toEqual({ value: "hi" });
  });

  it("runs the tool when no gate is wired (back-compat)", async () => {
    const [def] = projectToolsForClaude([echoTool()], projection());
    if (!def) throw new Error("narrow");
    const result = await def.handler({ value: "hi" }, {});
    expect(result.isError).toBeUndefined();
  });

  it("a result-gate substitution rewrites the result the SDK hands the model", async () => {
    let seen: unknown;
    const [def] = projectToolsForClaude(
      [echoTool()],
      projection(undefined, async (r) => {
        seen = r.result;
        return { outcome: "allow", data: "echo:[REDACTED]" };
      }),
    );
    if (!def) throw new Error("narrow");
    const result = await def.handler({ value: "hi" }, {});
    // The SDK feeds this returned content to the model AND echoes it to the UI.
    expect(result.content[0]?.text).toBe("echo:[REDACTED]");
    expect(result.isError).toBeUndefined();
    expect(seen).toBe("echo:hi");
  });

  it("a result-gate deny replaces the result with the reason, marked as an error", async () => {
    const [def] = projectToolsForClaude(
      [echoTool()],
      projection(undefined, async () => ({ outcome: "deny", reason: "leaked a secret" })),
    );
    if (!def) throw new Error("narrow");
    const result = await def.handler({ value: "hi" }, {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Tool 'echo' result withheld by policy: leaked a secret");
  });

  it("a plain result-gate allow leaves the tool output untouched", async () => {
    const [def] = projectToolsForClaude(
      [echoTool()],
      projection(undefined, async () => ({ outcome: "allow" })),
    );
    if (!def) throw new Error("narrow");
    const result = await def.handler({ value: "hi" }, {});
    expect(result.content[0]?.text).toBe("echo:hi");
    expect(result.isError).toBeUndefined();
  });
});
