// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  registerProvider,
  type SendQueryOptions,
  StubProvider,
  unregisterProvider,
} from "@keelson/providers";
import type { MessageChunk } from "@keelson/shared";

import { chatHeadless } from "../src/in-process/chat.ts";
import { SandboxUnavailableError } from "../src/in-process/sandbox.ts";

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

  describe("sandbox", () => {
    const originalSandbox = process.env.KEELSON_SANDBOX;
    afterAll(() => {
      if (originalSandbox === undefined) delete process.env.KEELSON_SANDBOX;
      else process.env.KEELSON_SANDBOX = originalSandbox;
    });

    // A provider that declares no sandbox support, so a sandboxed turn fails closed.
    class NoSandboxProvider extends StubProvider {
      override getCapabilities() {
        const { sandbox: _, ...caps } = super.getCapabilities();
        return caps;
      }
    }
    beforeAll(() => {
      registerProvider({
        id: "no-sandbox",
        displayName: "No sandbox",
        factory: () => new NoSandboxProvider(),
        capabilities: new NoSandboxProvider().getCapabilities(),
        builtIn: false,
      });
    });
    afterAll(() => {
      unregisterProvider("no-sandbox");
    });

    test("--sandbox on a provider that cannot sandbox fails closed before the turn", async () => {
      delete process.env.KEELSON_SANDBOX;
      const chunks: MessageChunk[] = [];
      const turn = chatHeadless({
        message: "hi",
        cwd: process.cwd(),
        provider: "no-sandbox",
        sandbox: true,
        onChunk: (chunk) => chunks.push(chunk),
      });
      await expect(turn).rejects.toBeInstanceOf(SandboxUnavailableError);
      await expect(turn).rejects.toThrow(
        "sandbox is on, but no-sandbox cannot sandbox its tools: switch to a provider that can sandbox, or pass --no-sandbox",
      );
      expect(chunks).toEqual([]);
    });

    test("KEELSON_SANDBOX=required holds it on over --no-sandbox", async () => {
      process.env.KEELSON_SANDBOX = "required";
      await expect(
        chatHeadless({ message: "hi", cwd: process.cwd(), provider: "no-sandbox", sandbox: false }),
      ).rejects.toThrow("KEELSON_SANDBOX=required holds the sandbox on");
    });

    test("the stub has nothing to confine, so the default-on sandbox lets it answer", async () => {
      delete process.env.KEELSON_SANDBOX;
      const result = await chatHeadless({ message: "hi", cwd: process.cwd(), provider: "stub" });
      expect(result.text.trim()).toBe("hi");
    });

    test("KEELSON_WORKFLOW_TOOL_DENYLIST=Bash withholds the sandboxed shell and denies it", async () => {
      delete process.env.KEELSON_SANDBOX;
      const originalDenylist = process.env.KEELSON_WORKFLOW_TOOL_DENYLIST;
      const seen: { tools: string[]; disallowed: readonly string[] | undefined }[] = [];
      class ToolSandboxProvider extends StubProvider {
        override getCapabilities() {
          return { ...super.getCapabilities(), tools: true, sandbox: "tool" as const };
        }
        override sendQuery(
          prompt: string,
          cwd: string,
          resumeSessionId?: string,
          options?: SendQueryOptions,
        ) {
          seen.push({
            tools: (options?.tools ?? []).map((t) => t.name),
            disallowed: options?.disallowedTools,
          });
          return super.sendQuery(prompt, cwd, resumeSessionId, options);
        }
      }
      registerProvider({
        id: "tool-sandbox",
        displayName: "Tool sandbox",
        factory: () => new ToolSandboxProvider(),
        capabilities: new ToolSandboxProvider().getCapabilities(),
        builtIn: false,
      });
      const turn = (denylist: string | undefined) => {
        if (denylist === undefined) delete process.env.KEELSON_WORKFLOW_TOOL_DENYLIST;
        else process.env.KEELSON_WORKFLOW_TOOL_DENYLIST = denylist;
        return chatHeadless({
          message: "hi",
          cwd: process.cwd(),
          provider: "tool-sandbox",
          sandbox: true,
        });
      };
      try {
        await turn(undefined);
        await turn("Bash");
        await turn("bash");
        expect(seen[0]).toEqual({ tools: ["bash"], disallowed: undefined });
        expect(seen[1]).toEqual({ tools: [], disallowed: ["bash"] });
        expect(seen[2]).toEqual({ tools: [], disallowed: ["bash"] });
      } finally {
        unregisterProvider("tool-sandbox");
        if (originalDenylist === undefined) delete process.env.KEELSON_WORKFLOW_TOOL_DENYLIST;
        else process.env.KEELSON_WORKFLOW_TOOL_DENYLIST = originalDenylist;
      }
    });

    test("--no-sandbox runs the turn", async () => {
      process.env.KEELSON_SANDBOX = "on";
      const result = await chatHeadless({
        message: "hi",
        cwd: process.cwd(),
        provider: "stub",
        sandbox: false,
      });
      expect(result.text.trim()).toBe("hi");
    });
  });
});
