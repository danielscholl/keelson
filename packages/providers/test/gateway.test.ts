// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { beforeEach, describe, expect, it } from "bun:test";
import type { MessageChunk } from "../src/index.ts";
import {
  clearRegistry,
  GatewayProvider,
  getProviderInfoList,
  isRegisteredProvider,
  registerConfiguredGateways,
  unregisterProvider,
} from "../src/index.ts";

// A fetch stand-in: the handler sees the URL + init and returns a Response.
function mockFetch(
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): { fn: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function sse(...lines: string[]): Response {
  const body = lines.map((l) => `data: ${l}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function chunk(delta: Record<string, unknown>): string {
  return JSON.stringify({ choices: [{ delta }] });
}

async function collect(gen: AsyncGenerator<MessageChunk>): Promise<MessageChunk[]> {
  const out: MessageChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

const noKey = async () => undefined;

describe("GatewayProvider.getCapabilities", () => {
  it("reflects a configured model", () => {
    const p = new GatewayProvider({
      id: "g",
      baseUrl: "http://x/v1",
      getApiKey: noKey,
      model: "m1",
    });
    expect(p.getType()).toBe("gateway");
    expect(p.getCapabilities()).toEqual({
      sessionResume: false,
      streaming: true,
      tools: false,
      models: ["m1"],
      defaultModel: "m1",
    });
  });

  it("is empty-but-valid without a model (picker fills from listModels)", () => {
    const p = new GatewayProvider({ id: "g", baseUrl: "http://x/v1", getApiKey: noKey });
    expect(p.getCapabilities().models).toEqual([]);
    expect(p.getCapabilities().defaultModel).toBe("");
  });
});

describe("GatewayProvider.sendQuery", () => {
  it("streams content deltas as text and ends on [DONE]", async () => {
    const { fn, calls } = mockFetch(() =>
      sse(chunk({ content: "Hello" }), chunk({ content: " world" }), "[DONE]"),
    );
    const p = new GatewayProvider({
      id: "g",
      baseUrl: "http://host/v1",
      getApiKey: noKey,
      model: "m1",
      fetchImpl: fn,
    });
    const chunks = await collect(p.sendQuery("hi", "/tmp"));
    expect(chunks).toEqual([
      { type: "text", content: "Hello" },
      { type: "text", content: " world" },
      { type: "done" },
    ]);
    // Targets the OpenAI chat-completions path with a streaming request.
    expect(calls[0]?.url).toBe("http://host/v1/chat/completions");
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body).toMatchObject({ model: "m1", stream: true });
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("includes a system message when systemPrompt is set", async () => {
    const { fn, calls } = mockFetch(() => sse(chunk({ content: "ok" }), "[DONE]"));
    const p = new GatewayProvider({
      id: "g",
      baseUrl: "http://h/v1",
      getApiKey: noKey,
      model: "m",
      fetchImpl: fn,
    });
    await collect(p.sendQuery("hi", "/tmp", undefined, { systemPrompt: "be brief" }));
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body.messages).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ]);
  });

  it("concatenates multi-line data: fields within one SSE event", async () => {
    // One JSON object split across two `data:` lines (joined with \n by the
    // client, per the SSE spec) followed by the [DONE] sentinel.
    const body = 'data: {"choices":[\ndata: {"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
    const { fn } = mockFetch(
      () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const p = new GatewayProvider({
      id: "g",
      baseUrl: "http://h/v1",
      getApiKey: noKey,
      model: "m",
      fetchImpl: fn,
    });
    const chunks = await collect(p.sendQuery("q", "/tmp"));
    expect(chunks).toEqual([{ type: "text", content: "hi" }, { type: "done" }]);
  });

  it("maps reasoning_content to a thinking chunk", async () => {
    const { fn } = mockFetch(() =>
      sse(chunk({ reasoning_content: "hmm" }), chunk({ content: "answer" }), "[DONE]"),
    );
    const p = new GatewayProvider({
      id: "g",
      baseUrl: "http://h/v1",
      getApiKey: noKey,
      model: "m",
      fetchImpl: fn,
    });
    const chunks = await collect(p.sendQuery("q", "/tmp"));
    expect(chunks).toEqual([
      { type: "thinking", content: "hmm" },
      { type: "text", content: "answer" },
      { type: "done" },
    ]);
  });

  it("emits a usage chunk when the stream reports token counts", async () => {
    const usageLine = JSON.stringify({
      choices: [{ delta: {} }],
      usage: { prompt_tokens: 11, completion_tokens: 7 },
    });
    const { fn } = mockFetch(() => sse(chunk({ content: "x" }), usageLine, "[DONE]"));
    const p = new GatewayProvider({
      id: "g",
      baseUrl: "http://h/v1",
      getApiKey: noKey,
      model: "m",
      fetchImpl: fn,
    });
    const chunks = await collect(p.sendQuery("q", "/tmp"));
    expect(chunks).toContainEqual({
      type: "usage",
      usage: { inputTokens: 11, outputTokens: 7 },
    });
  });

  it("omits Authorization when keyless and sends Bearer when a key is set", async () => {
    const keyless = mockFetch(() => sse("[DONE]"));
    await collect(
      new GatewayProvider({
        id: "g",
        baseUrl: "http://h/v1",
        getApiKey: noKey,
        model: "m",
        fetchImpl: keyless.fn,
      }).sendQuery("q", "/tmp"),
    );
    expect(
      (keyless.calls[0]?.init?.headers as Record<string, string>).authorization,
    ).toBeUndefined();

    const keyed = mockFetch(() => sse("[DONE]"));
    await collect(
      new GatewayProvider({
        id: "g",
        baseUrl: "http://h/v1",
        getApiKey: async () => "secret",
        model: "m",
        fetchImpl: keyed.fn,
      }).sendQuery("q", "/tmp"),
    );
    expect((keyed.calls[0]?.init?.headers as Record<string, string>).authorization).toBe(
      "Bearer secret",
    );
  });

  it("yields an error chunk (then done) on an HTTP error", async () => {
    const { fn } = mockFetch(() => new Response("upstream boom", { status: 502 }));
    const p = new GatewayProvider({
      id: "ollama",
      baseUrl: "http://h/v1",
      getApiKey: noKey,
      model: "m",
      fetchImpl: fn,
    });
    const chunks = await collect(p.sendQuery("q", "/tmp"));
    expect(chunks[0]?.type).toBe("error");
    expect((chunks[0] as { message: string }).message).toContain("HTTP 502");
    expect((chunks[0] as { message: string }).message).toContain("upstream boom");
    expect(chunks.at(-1)).toEqual({ type: "done" });
  });

  it("errors clearly when no model is configured or selected", async () => {
    const { fn, calls } = mockFetch(() => sse("[DONE]"));
    const p = new GatewayProvider({
      id: "g",
      baseUrl: "http://h/v1",
      getApiKey: noKey,
      fetchImpl: fn,
    });
    const chunks = await collect(p.sendQuery("q", "/tmp"));
    expect(chunks[0]?.type).toBe("error");
    expect((chunks[0] as { message: string }).message).toContain("no model");
    // Never hit the network without a model.
    expect(calls).toHaveLength(0);
  });

  it("yields nothing extra when the turn is aborted before the request", async () => {
    const controller = new AbortController();
    controller.abort();
    const { fn } = mockFetch((_url, init) => {
      if ((init?.signal as AbortSignal | undefined)?.aborted) throw new Error("aborted");
      return sse("[DONE]");
    });
    const p = new GatewayProvider({
      id: "g",
      baseUrl: "http://h/v1",
      getApiKey: noKey,
      model: "m",
      fetchImpl: fn,
    });
    const chunks = await collect(
      p.sendQuery("q", "/tmp", undefined, { abortSignal: controller.signal }),
    );
    expect(chunks).toEqual([]);
  });
});

describe("GatewayProvider.listModels", () => {
  it("returns the endpoint's models on success", async () => {
    const { fn, calls } = mockFetch(() =>
      Response.json({ data: [{ id: "qwen3:latest" }, { id: "llama3" }] }),
    );
    const p = new GatewayProvider({
      id: "g",
      baseUrl: "http://h/v1",
      getApiKey: noKey,
      fetchImpl: fn,
    });
    expect(await p.listModels()).toEqual([{ id: "qwen3:latest" }, { id: "llama3" }]);
    expect(calls[0]?.url).toBe("http://h/v1/models");
  });

  it("falls back to the configured model when the endpoint can't enumerate", async () => {
    const { fn } = mockFetch(() => new Response("nope", { status: 404 }));
    const p = new GatewayProvider({
      id: "g",
      baseUrl: "http://h/v1",
      getApiKey: noKey,
      model: "m1",
      fetchImpl: fn,
    });
    expect(await p.listModels()).toEqual([{ id: "m1" }]);
  });

  it("never throws on a network failure", async () => {
    const fn = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const p = new GatewayProvider({
      id: "g",
      baseUrl: "http://h/v1",
      getApiKey: noKey,
      fetchImpl: fn,
    });
    expect(await p.listModels()).toEqual([]);
  });
});

describe("registerConfiguredGateways", () => {
  beforeEach(() => clearRegistry());

  it("registers a provider per gateway, keyed by name, with credentialServiceId", () => {
    const seen: string[] = [];
    const ids = registerConfiguredGateways({
      gateways: [{ name: "ollama", baseUrl: "http://localhost:11434/v1", model: "qwen3:latest" }],
      getApiKey: async (svc) => {
        seen.push(svc);
        return undefined;
      },
    });
    expect(ids).toEqual(["ollama"]);
    expect(isRegisteredProvider("ollama")).toBe(true);
    const info = getProviderInfoList().find((p) => p.id === "ollama");
    expect(info?.credentialServiceId).toBe("gateway-ollama");
    expect(info?.builtIn).toBe(false);
  });

  it("skips a gateway whose name already names a registered provider", () => {
    registerConfiguredGateways({
      gateways: [{ name: "dup", baseUrl: "http://a/v1" }],
      getApiKey: noKey,
    });
    const ids = registerConfiguredGateways({
      gateways: [{ name: "dup", baseUrl: "http://b/v1" }],
      getApiKey: noKey,
    });
    expect(ids).toEqual([]);
  });

  it("unregisterProvider removes a gateway so it can be replaced", () => {
    registerConfiguredGateways({
      gateways: [{ name: "g", baseUrl: "http://a/v1" }],
      getApiKey: noKey,
    });
    expect(unregisterProvider("g")).toBe(true);
    expect(isRegisteredProvider("g")).toBe(false);
  });
});
