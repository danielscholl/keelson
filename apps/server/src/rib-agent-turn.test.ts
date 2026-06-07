// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { describe, expect, it } from "bun:test";
import type { MessageChunk, Rib, RibContext, RibExecResult } from "@keelson/shared";
import { makeRibAgentTurn } from "./rib-agent-turn.ts";
import { applyRibs } from "./ribs.ts";

// A fake runJSON (typeof @keelson/shared/exec runJSON) that records its call and
// returns a scripted result.
function fakeExec(reply: RibExecResult<unknown>, onCall?: (cmd: string, args: string[]) => void) {
  return (async (cmd: string, args: string[]) => {
    onCall?.(cmd, args);
    return reply;
  }) as typeof import("@keelson/shared/exec").runJSON;
}

async function drain(stream: AsyncIterable<MessageChunk>): Promise<MessageChunk[]> {
  const out: MessageChunk[] = [];
  for await (const c of stream) out.push(c);
  return out;
}

describe("makeRibAgentTurn (CLI MVP)", () => {
  it("maps a successful CLI reply to an ok result + synthetic stream", async () => {
    const run = makeRibAgentTurn({
      runJSON: fakeExec({ ok: true, data: { result: "hello", session_id: "s1" } }),
    });
    const turn = run("chamber", { prompt: "say hi" });
    const result = await turn.result;
    expect(result).toEqual({
      status: "ok",
      text: "hello",
      providerId: "cli:claude",
      sessionId: "s1",
    });
    expect(await drain(turn.stream)).toEqual([
      { type: "text", content: "hello" },
      { type: "done" },
    ]);
  });

  it("passes prompt/system/model/resume through as CLI args", async () => {
    let seen: string[] = [];
    const run = makeRibAgentTurn({
      runJSON: fakeExec({ ok: true, data: { result: "x" } }, (_cmd, args) => {
        seen = args;
      }),
    });
    await run("chamber", {
      prompt: "do x",
      system: "be terse",
      model: "opus",
      resumeSessionId: "s0",
    }).result;
    expect(seen).toEqual([
      "-p",
      "do x",
      "--output-format",
      "json",
      "--append-system-prompt",
      "be terse",
      "--model",
      "opus",
      "--resume",
      "s0",
    ]);
  });

  it("maps a CLI failure to an error result + error chunk", async () => {
    const run = makeRibAgentTurn({
      runJSON: fakeExec({ ok: false, error: "claude not found", code: null }),
    });
    const turn = run("chamber", { prompt: "hi" });
    const result = await turn.result;
    expect(result.status).toBe("error");
    expect(result.text).toBe("");
    expect(result.error).toBe("claude not found");
    expect(await drain(turn.stream)).toEqual([
      { type: "error", message: "claude not found" },
      { type: "done" },
    ]);
  });

  it("classifies a timeout distinctly from a generic error", async () => {
    const run = makeRibAgentTurn({
      runJSON: fakeExec({ ok: false, error: "timed out after 5ms", code: null }),
    });
    expect((await run("chamber", { prompt: "hi" }).result).status).toBe("timeout");
  });

  it("short-circuits an already-aborted turn without shelling the CLI", async () => {
    let called = false;
    const run = makeRibAgentTurn({
      runJSON: fakeExec({ ok: true, data: { result: "x" } }, () => {
        called = true;
      }),
    });
    const ac = new AbortController();
    ac.abort();
    const result = await run("chamber", { prompt: "hi", abortSignal: ac.signal }).result;
    expect(result.status).toBe("aborted");
    expect(called).toBe(false);
  });

  it("stamps providerId from the configured bin", async () => {
    let cmd = "";
    const run = makeRibAgentTurn({
      bin: "codex",
      runJSON: fakeExec({ ok: true, data: { result: "x" } }, (c) => {
        cmd = c;
      }),
    });
    const result = await run("chamber", { prompt: "hi" }).result;
    expect(cmd).toBe("codex");
    expect(result.providerId).toBe("cli:codex");
  });
});

describe("applyRibs wiring", () => {
  it("exposes runAgentTurn on the rib context, bound to the rib id", async () => {
    let captured: RibContext | undefined;
    const rib: Rib = {
      id: "chamber",
      displayName: "Chamber",
      registerTools: (ctx) => {
        captured = ctx;
        return { registered: [] };
      },
    };
    let seenRibId = "";
    applyRibs({
      active: ["chamber"],
      available: { chamber: rib },
      ctx: {
        getExec: () => ({
          runJSON: async <T>() => ({ ok: true as const, data: undefined as T }),
          runText: async () => ({ ok: true as const, data: "" }),
        }),
      },
      runAgentTurn: (ribId) => {
        seenRibId = ribId;
        return {
          result: Promise.resolve({ status: "ok" as const, text: "" }),
          stream: (async function* () {
            yield { type: "done" as const };
          })(),
        };
      },
    });
    expect(captured?.runAgentTurn).toBeDefined();
    captured?.runAgentTurn?.({ prompt: "x" });
    expect(seenRibId).toBe("chamber");
  });

  it("omits runAgentTurn when none is supplied (fails closed for the rib)", () => {
    let captured: RibContext | undefined;
    const rib: Rib = {
      id: "chamber",
      displayName: "Chamber",
      registerTools: (ctx) => {
        captured = ctx;
        return { registered: [] };
      },
    };
    applyRibs({
      active: ["chamber"],
      available: { chamber: rib },
      ctx: {
        getExec: () => ({
          runJSON: async <T>() => ({ ok: true as const, data: undefined as T }),
          runText: async () => ({ ok: true as const, data: "" }),
        }),
      },
    });
    expect(captured?.runAgentTurn).toBeUndefined();
  });
});
