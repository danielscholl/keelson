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
      "--output-format",
      "json",
      // no tool field requested => text-only (see tool-rail tests below)
      "--tools",
      "",
      "--append-system-prompt",
      "be terse",
      "--model",
      "opus",
      "--resume",
      "s0",
      // prompt is the last positional, after `--`, so a leading dash is data
      "--",
      "do x",
    ]);
  });

  it("passes the prompt as the final positional after `--` (leading-dash safe)", async () => {
    let seen: string[] = [];
    const run = makeRibAgentTurn({
      runJSON: fakeExec({ ok: true, data: { result: "x" } }, (_cmd, args) => {
        seen = args;
      }),
    });
    await run("chamber", { prompt: "- a bullet prompt" }).result;
    expect(seen.slice(-2)).toEqual(["--", "- a bullet prompt"]);
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

  it("maps a zero-exit JSON error (is_error / non-success subtype) to an error result", async () => {
    const flagged = makeRibAgentTurn({
      runJSON: fakeExec({ ok: true, data: { result: "", is_error: true, session_id: "s1" } }),
    });
    const r1 = await flagged("chamber", { prompt: "hi" }).result;
    expect(r1.status).toBe("error");
    expect(r1.sessionId).toBe("s1");

    const maxTurns = makeRibAgentTurn({
      runJSON: fakeExec({ ok: true, data: { subtype: "error_max_turns", result: "partial" } }),
    });
    const r2 = await maxTurns("chamber", { prompt: "hi" }).result;
    expect(r2.status).toBe("error");
    expect(r2.text).toBe("partial");
    expect(r2.error).toContain("error_max_turns");
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

describe("makeRibAgentTurn tool rails", () => {
  // Capture the CLI args produced for a given request's tool fields.
  async function argsFor(
    req: Parameters<ReturnType<typeof makeRibAgentTurn>>[1],
  ): Promise<string[]> {
    let seen: string[] = [];
    const run = makeRibAgentTurn({
      runJSON: fakeExec({ ok: true, data: { result: "x" } }, (_cmd, args) => {
        seen = args;
      }),
    });
    await run("chamber", req).result;
    return seen;
  }

  it("forces a text-only turn when no tool field is set (the room default)", async () => {
    const args = await argsFor({ prompt: "hi" });
    expect(args).toContain("--tools");
    // --tools "" disables all tools
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args).not.toContain("--allowedTools");
  });

  it("treats an explicit empty allowedTools as text-only too", async () => {
    const args = await argsFor({ prompt: "hi", allowedTools: [] });
    expect(args[args.indexOf("--tools") + 1]).toBe("");
  });

  it("passes a requested available tool set, not the empty sentinel", async () => {
    const args = await argsFor({ prompt: "hi", tools: [{ name: "Read" }, { name: "Edit" }] });
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Edit");
  });

  it("bounds the --tools catalog from an allow-list, not just the permission rail", async () => {
    const args = await argsFor({ prompt: "hi", allowedTools: ["Read"] });
    // allow-list must narrow the catalog gate too, else default tools stay loadable
    expect(args[args.indexOf("--tools") + 1]).toBe("Read");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("Read");
  });

  it("intersects tools with the allow-list so the catalog can't widen past it", async () => {
    const args = await argsFor({
      prompt: "hi",
      tools: [{ name: "Read" }, { name: "Edit" }],
      allowedTools: ["Read"],
    });
    expect(args[args.indexOf("--tools") + 1]).toBe("Read"); // Edit excluded by the allow-list
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("Read");
  });

  it("maps allow/deny rails (catalog uses base names; rail keeps the scope)", async () => {
    const allowed = await argsFor({ prompt: "hi", allowedTools: ["Bash(git:*)", "Read"] });
    expect(allowed[allowed.indexOf("--tools") + 1]).toBe("Bash,Read"); // catalog = base names
    expect(allowed[allowed.indexOf("--allowedTools") + 1]).toBe("Bash(git:*),Read");
    expect(allowed).not.toContain(""); // not the text-only sentinel

    const denied = await argsFor({ prompt: "hi", disallowedTools: ["Bash", "Edit"] });
    expect(denied[denied.indexOf("--disallowedTools") + 1]).toBe("Bash,Edit");
    // a deny-only request still leaves the rest of the tools available
    expect(denied).not.toContain("--tools");
  });

  it("treats an empty deny list like no deny rail (default tools, not text-only)", async () => {
    const args = await argsFor({ prompt: "hi", disallowedTools: [] });
    expect(args).not.toContain("--tools"); // not the text-only sentinel
    expect(args).not.toContain("--disallowedTools");
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
