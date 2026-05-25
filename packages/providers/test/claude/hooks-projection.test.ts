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
    // Order is load-bearing — user hooks (first arg) observe before built-in
    // capture hooks (second arg, none today). The SDK runs them in order.
    expect(merged!.PreToolUse![0]!.matcher).toBe("Bash");
  });

  it("returns the other side when one is undefined", () => {
    expect(mergeSDKHooks(yamlA, undefined)).toBe(yamlA);
    expect(mergeSDKHooks(undefined, yamlB)).toBe(yamlB);
  });

  it("returns undefined when both inputs are undefined", () => {
    expect(mergeSDKHooks(undefined, undefined)).toBeUndefined();
  });
});
