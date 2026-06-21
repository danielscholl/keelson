// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, it } from "bun:test";

import {
  buildBuiltinToolGateHooks,
  buildSDKHooksFromYAML,
  mergeSDKHooks,
} from "../../src/claude/hooks-projection.ts";

describe("buildSDKHooksFromYAML", () => {
  it("projects a single YAML matcher into one SDK matcher whose hook returns the canned response", async () => {
    const projected = buildSDKHooksFromYAML({
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
    });
    expect(Object.keys(projected)).toEqual(["PostToolUse"]);
    const matchers = projected.PostToolUse!;
    expect(matchers).toHaveLength(1);
    expect(matchers[0]!.matcher).toBe("Read");
    expect(matchers[0]!.hooks).toHaveLength(1);
    // The hook ignores its input and returns the literal YAML response —
    // the SDK is the thing that interprets `additionalContext` etc.
    const result = await matchers[0]!.hooks[0]!({ tool_name: "Read" });
    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: "assess what you just read",
      },
    });
  });

  it("forwards optional matcher / timeout fields only when present", () => {
    const projected = buildSDKHooksFromYAML({
      PreToolUse: [
        { response: { systemMessage: "no matcher" } },
        { matcher: "Bash", response: { permissionDecision: "deny" }, timeout: 30 },
      ],
    });
    const [withoutMatcher, withMatcher] = projected.PreToolUse!;
    expect(withoutMatcher!.matcher).toBeUndefined();
    expect(withoutMatcher!.timeout).toBeUndefined();
    expect(withMatcher!.matcher).toBe("Bash");
    expect(withMatcher!.timeout).toBe(30);
  });

  it("drops events with empty / undefined matcher arrays", () => {
    const projected = buildSDKHooksFromYAML({
      PostToolUse: [{ response: { ok: true } }],
      // Empty array — author explicitly registered the event but added no
      // matchers; not the same as setting it to undefined, but the SDK
      // doesn't care about an event with zero matchers, so drop it.
      PreToolUse: [],
      SessionStart: undefined,
    });
    expect(Object.keys(projected).sort()).toEqual(["PostToolUse"]);
  });

  it("returns an empty object when given empty hooks", () => {
    expect(buildSDKHooksFromYAML({})).toEqual({});
  });
});

describe("mergeSDKHooks", () => {
  const yamlA = buildSDKHooksFromYAML({
    PreToolUse: [{ matcher: "Bash", response: { tag: "A" } }],
  });
  const yamlB = buildSDKHooksFromYAML({
    PreToolUse: [{ matcher: "Bash", response: { tag: "B" } }],
    PostToolUse: [{ matcher: "Read", response: { tag: "B-post" } }],
  });

  it("concatenates matchers per event with first-arg first", () => {
    const merged = mergeSDKHooks(yamlA, yamlB);
    expect(merged).toBeDefined();
    expect(merged!.PreToolUse).toHaveLength(2);
    expect(merged!.PostToolUse).toHaveLength(1);
    // Order is load-bearing — the first arg's matchers come before the second
    // arg's. The SDK runs them in order.
    expect(merged!.PreToolUse![0]!.matcher).toBe("Bash");
  });

  it("returns the other side when one is undefined", () => {
    expect(mergeSDKHooks(yamlA, undefined)).toBe(yamlA);
    expect(mergeSDKHooks(undefined, yamlB)).toBe(yamlB);
  });

  it("returns undefined when both inputs are undefined", () => {
    expect(mergeSDKHooks(undefined, undefined)).toBeUndefined();
  });

  it("places the built-in policy gate before user hooks (gate first, user second)", () => {
    const user = buildSDKHooksFromYAML({
      PreToolUse: [{ matcher: "Bash", response: { tag: "user" } }],
    });
    const gate = buildBuiltinToolGateHooks(async () => ({ outcome: "allow" }));
    // Factory order: gate first so its deny is authoritative over a user "allow".
    const merged = mergeSDKHooks(gate, user)!;
    expect(merged.PreToolUse).toHaveLength(2);
    expect(merged.PreToolUse![0]!.matcher).toBeUndefined(); // gate is matcher-less, runs first
    expect(merged.PreToolUse![1]!.matcher).toBe("Bash"); // user matcher second
  });
});

describe("buildBuiltinToolGateHooks", () => {
  // A gate that records what reached it and denies one named tool, so a test can
  // assert both the deny projection and the mcp__/no-name skips (gate not called).
  const recordingGate = (denyTool?: string) => {
    const calls: { tool: string; args?: unknown }[] = [];
    const gate = async (call: { tool: string; args?: unknown }) => {
      calls.push(call);
      return denyTool !== undefined && call.tool === denyTool
        ? { outcome: "deny" as const, reason: `${call.tool} blocked` }
        : { outcome: "allow" as const };
    };
    return { gate, calls };
  };

  const fire = (hooks: ReturnType<typeof buildBuiltinToolGateHooks>, input: unknown) =>
    hooks.PreToolUse![0]!.hooks[0]!(input);

  it("registers one matcher-less PreToolUse hook (fires for every tool)", () => {
    const { gate } = recordingGate();
    const hooks = buildBuiltinToolGateHooks(gate);
    expect(Object.keys(hooks)).toEqual(["PreToolUse"]);
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.PreToolUse![0]!.matcher).toBeUndefined();
  });

  it("returns a PreToolUse deny carrying the gate's message when the gate denies", async () => {
    const { gate } = recordingGate("Bash");
    const result = await fire(buildBuiltinToolGateHooks(gate), {
      tool_name: "Bash",
      tool_input: { command: "rm -rf /" },
    });
    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringContaining("Bash blocked"),
      },
    });
  });

  it("returns {} (no opinion → proceed) when the gate allows", async () => {
    const { gate } = recordingGate("Bash");
    expect(
      await fire(buildBuiltinToolGateHooks(gate), { tool_name: "Read", tool_input: {} }),
    ).toEqual({});
  });

  it("passes the SDK tool_input through to the gate as args", async () => {
    const { gate, calls } = recordingGate();
    await fire(buildBuiltinToolGateHooks(gate), {
      tool_name: "Write",
      tool_input: { path: "/etc/x", content: "y" },
    });
    expect(calls).toEqual([{ tool: "Write", args: { path: "/etc/x", content: "y" } }]);
  });

  it("skips mcp__* names without calling the gate (gated in the tool handler instead)", async () => {
    const { gate, calls } = recordingGate("mcp__keelson__osdu_list");
    const result = await fire(buildBuiltinToolGateHooks(gate), {
      tool_name: "mcp__keelson__osdu_list",
      tool_input: {},
    });
    expect(result).toEqual({});
    expect(calls).toEqual([]);
  });

  it("proceeds without calling the gate when the payload carries no tool_name", async () => {
    const { gate, calls } = recordingGate("Bash");
    expect(await fire(buildBuiltinToolGateHooks(gate), {})).toEqual({});
    expect(await fire(buildBuiltinToolGateHooks(gate), null)).toEqual({});
    expect(calls).toEqual([]);
  });
});
