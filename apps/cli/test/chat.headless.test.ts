// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MessageChunk } from "@keelson/shared";

import { chatHeadless } from "../src/in-process/chat.ts";

describe("chatHeadless (in-process chat)", () => {
  const originalUseStubs = process.env.KEELSON_USE_STUBS;
  const originalProviders = process.env.KEELSON_PROVIDERS;

  beforeAll(() => {
    process.env.KEELSON_USE_STUBS = "1";
    process.env.KEELSON_PROVIDERS = "stub";
  });

  afterAll(() => {
    if (originalUseStubs === undefined) {
      delete process.env.KEELSON_USE_STUBS;
    } else {
      process.env.KEELSON_USE_STUBS = originalUseStubs;
    }
    if (originalProviders === undefined) {
      delete process.env.KEELSON_PROVIDERS;
    } else {
      process.env.KEELSON_PROVIDERS = originalProviders;
    }
  });

  test("echoes the prompt through the stub provider with a system + text + done sequence", async () => {
    const chunks: MessageChunk[] = [];
    const result = await chatHeadless({
      message: "ping pong",
      cwd: process.cwd(),
      provider: "stub",
      onChunk: (chunk) => chunks.push(chunk),
    });

    expect(result.providerId).toBe("stub");
    expect(result.text.trim()).toBe("ping pong");
    expect(chunks[0]?.type).toBe("system");
    expect(chunks[chunks.length - 1]?.type).toBe("done");
    const textChunks = chunks.filter((c) => c.type === "text") as Array<{
      type: "text";
      content: string;
    }>;
    expect(textChunks.map((c) => c.content.trim())).toEqual(["ping", "pong"]);
  });

  test("--provider omitted picks stub when KEELSON_PROVIDERS=stub", async () => {
    // bootstrapCliProviders honors KEELSON_PROVIDERS, so only `stub` is
    // registered here. The default-picker fallback chain
    // (copilot → stub → first) lands on stub since copilot isn't
    // registered — matching what the HTTP / SPA path resolves to.
    const result = await chatHeadless({
      message: "hi",
      cwd: process.cwd(),
    });
    expect(result.providerId).toBe("stub");
    expect(result.text.trim()).toBe("hi");
  });

  test("unknown --provider throws UnknownProviderError", async () => {
    expect(
      chatHeadless({
        message: "x",
        cwd: process.cwd(),
        provider: "does-not-exist",
      }),
    ).rejects.toThrow(/does-not-exist/);
  });
});
