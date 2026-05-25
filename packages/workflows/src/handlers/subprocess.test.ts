// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";

import type { NodeOutput } from "../schema/index.ts";
import { buildSubprocessEnv } from "./subprocess.ts";

describe("buildSubprocessEnv", () => {
  test("layers KEELSON_INPUTS_*, KEELSON_NODE_*_OUTPUT, and KEELSON_ARGUMENTS over PARENT_ENV", () => {
    const upstream = new Map<string, NodeOutput>([
      [
        "fetch-stats",
        {
          state: "completed",
          output: "ok",
          startedAt: "2026-05-22T00:00:00Z",
          completedAt: "2026-05-22T00:00:01Z",
          durationMs: 1000,
        },
      ],
    ]);
    const env = buildSubprocessEnv({ ARGUMENTS: "hi", flag: "yes" }, upstream);
    expect(env.KEELSON_ARGUMENTS).toBe("hi");
    expect(env.KEELSON_INPUTS_ARGUMENTS).toBe("hi");
    expect(env.KEELSON_INPUTS_flag).toBe("yes");
    // dashes in node ids normalize to underscores (POSIX env-var ident rule).
    expect(env.KEELSON_NODE_fetch_stats_OUTPUT).toBe("ok");
  });

  test("sets both KEELSON_ARTIFACTS_DIR and ARTIFACTS_DIR when options.artifactsDir is provided", () => {
    // Both vars carry the same value: KEELSON_ARTIFACTS_DIR matches our
    // prefixed-env contract; ARTIFACTS_DIR is the unprefixed name that
    // bash/script `ctx.rawBody` shells expand against — those handlers
    // skip executor substitution for command-injection safety, so the
    // unprefixed env var is the only way `cd "$ARTIFACTS_DIR"` resolves.
    const env = buildSubprocessEnv({}, new Map<string, NodeOutput>(), {
      artifactsDir: "/tmp/keelson-run-abc",
    });
    expect(env.KEELSON_ARTIFACTS_DIR).toBe("/tmp/keelson-run-abc");
    expect(env.ARTIFACTS_DIR).toBe("/tmp/keelson-run-abc");
  });

  test("omits both ARTIFACTS_DIR vars when options.artifactsDir is undefined (no PARENT_ENV leak)", () => {
    // The implementation unconditionally deletes env.KEELSON_ARTIFACTS_DIR
    // and env.ARTIFACTS_DIR after spreading PARENT_ENV — so even if the
    // operator's shell had either set when the server booted, neither
    // can leak into a workflow subprocess that wasn't given a per-run
    // scratch dir.
    const env = buildSubprocessEnv({}, new Map<string, NodeOutput>());
    expect(Object.hasOwn(env, "KEELSON_ARTIFACTS_DIR")).toBe(false);
    expect(Object.hasOwn(env, "ARTIFACTS_DIR")).toBe(false);
  });

  test("omits both ARTIFACTS_DIR vars when options is provided but artifactsDir is undefined", () => {
    // The handler call site uses a conditional-spread to omit `artifactsDir`
    // when ctx.artifactsDir is undefined, but defensive: an empty options
    // object should not write either env var.
    const env = buildSubprocessEnv({}, new Map<string, NodeOutput>(), {});
    expect(Object.hasOwn(env, "KEELSON_ARTIFACTS_DIR")).toBe(false);
    expect(Object.hasOwn(env, "ARTIFACTS_DIR")).toBe(false);
  });

  test("ARGUMENTS defaults to '' when not provided in inputs", () => {
    const env = buildSubprocessEnv({}, new Map<string, NodeOutput>());
    expect(env.KEELSON_ARGUMENTS).toBe("");
  });
});
