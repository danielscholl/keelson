// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { afterEach, describe, expect, test } from "bun:test";
import type { ToolDefinition } from "@keelson/shared";
import { clearRegistry, registerTool } from "@keelson/skills";
import { z } from "zod";
import { executeRegisteredTool } from "../src/execute.ts";

const ctxOpts = () => ({ cwd: "/tmp", abortSignal: new AbortController().signal });

afterEach(() => {
  clearRegistry();
});

describe("executeRegisteredTool", () => {
  test("returns the emitted tool_result content", async () => {
    registerTool({
      name: "echo_ok",
      description: "echo",
      inputSchema: z.object({ msg: z.string() }),
      execute: async (input, ctx) => {
        ctx.emit({
          type: "tool_result",
          toolUseId: "",
          content: `got ${(input as { msg: string }).msg}`,
        });
      },
    });
    expect(await executeRegisteredTool("echo_ok", { msg: "hi" }, ctxOpts())).toEqual({
      content: "got hi",
      isError: false,
    });
  });

  test("propagates an isError tool_result", async () => {
    registerTool({
      name: "echo_err",
      description: "echo",
      inputSchema: z.object({}),
      execute: async (_input, ctx) => {
        ctx.emit({ type: "tool_result", toolUseId: "", content: "boom", isError: true });
      },
    });
    expect(await executeRegisteredTool("echo_err", {}, ctxOpts())).toEqual({
      content: "boom",
      isError: true,
    });
  });

  test("a thrown execute becomes an error result, not a throw", async () => {
    registerTool({
      name: "echo_throw",
      description: "echo",
      inputSchema: z.object({}),
      execute: async () => {
        throw new Error("kaboom");
      },
    });
    expect(await executeRegisteredTool("echo_throw", {}, ctxOpts())).toEqual({
      content: "kaboom",
      isError: true,
    });
  });

  test("zero-arg tool with undefined input", async () => {
    registerTool({
      name: "ping",
      description: "ping",
      inputSchema: z.object({}),
      execute: async (_input, ctx) => {
        ctx.emit({ type: "tool_result", toolUseId: "", content: "pong" });
      },
    });
    expect(await executeRegisteredTool("ping", undefined, ctxOpts())).toEqual({
      content: "pong",
      isError: false,
    });
  });

  test("unknown tool name is an error result", async () => {
    const res = await executeRegisteredTool("does_not_exist", {}, ctxOpts());
    expect(res.isError).toBe(true);
    expect(res.content).toContain("Unknown tool");
  });

  test("invalid input is an error result", async () => {
    registerTool({
      name: "needs_field",
      description: "x",
      inputSchema: z.object({ id: z.string() }),
      execute: async (_input, ctx) => {
        ctx.emit({ type: "tool_result", toolUseId: "", content: "unreachable" });
      },
    });
    const res = await executeRegisteredTool("needs_field", {}, ctxOpts());
    expect(res.isError).toBe(true);
    expect(res.content).toContain("Invalid input");
  });

  test("last tool_result wins when a tool emits several", async () => {
    registerTool({
      name: "multi",
      description: "x",
      inputSchema: z.object({}),
      execute: async (_input, ctx) => {
        ctx.emit({ type: "text", content: "progress" } as never);
        ctx.emit({ type: "tool_result", toolUseId: "", content: "first" });
        ctx.emit({ type: "tool_result", toolUseId: "", content: "last" });
      },
    });
    expect(await executeRegisteredTool("multi", {}, ctxOpts())).toEqual({
      content: "last",
      isError: false,
    });
  });

  test("no emit yields empty, non-error content", async () => {
    const silent: ToolDefinition = {
      name: "silent",
      description: "x",
      inputSchema: z.object({}),
      execute: async () => {},
    };
    registerTool(silent);
    expect(await executeRegisteredTool("silent", {}, ctxOpts())).toEqual({
      content: "",
      isError: false,
    });
  });
});
