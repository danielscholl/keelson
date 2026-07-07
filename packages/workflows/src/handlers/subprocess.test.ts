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
// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { tmpdir } from "node:os";
// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { join } from "node:path";

import type { NodeOutput } from "../schema/index.ts";
import { buildSubprocessEnv, ENV_VALUE_MAX_CHARS } from "./subprocess.ts";

function upstreamOf(id: string, output: string): ReadonlyMap<string, NodeOutput> {
  return new Map<string, NodeOutput>([
    [
      id,
      {
        state: "completed",
        output,
        startedAt: "2026-05-22T00:00:00Z",
        completedAt: "2026-05-22T00:00:01Z",
        durationMs: 1000,
      },
    ],
  ]);
}

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

describe("buildSubprocessEnv — env value cap (issue #442)", () => {
  const big = `HEAD-MARKER\n${"x".repeat(ENV_VALUE_MAX_CHARS * 3)}\nTAIL-MARKER`;

  test("a node output at or under the cap passes through unchanged with no _FILE var", () => {
    const exact = "y".repeat(ENV_VALUE_MAX_CHARS);
    const env = buildSubprocessEnv({}, upstreamOf("validate", exact));
    expect(env.KEELSON_NODE_validate_OUTPUT).toBe(exact);
    expect(Object.hasOwn(env, "KEELSON_NODE_validate_OUTPUT_FILE")).toBe(false);
  });

  test("an oversized node output is head+tail truncated with a marker carrying the full length", () => {
    const env = buildSubprocessEnv({}, upstreamOf("validate", big));
    const value = env.KEELSON_NODE_validate_OUTPUT as string;
    expect(value.startsWith("HEAD-MARKER")).toBe(true);
    expect(value.endsWith("TAIL-MARKER")).toBe(true);
    expect(value).toContain(`[keelson: output truncated — ${big.length} chars total`);
    // Bounded: head + tail + marker, nowhere near the original size.
    expect(value.length).toBeLessThan(ENV_VALUE_MAX_CHARS + 256);
  });

  test("without an artifacts dir the output is truncated but no _FILE var is set", () => {
    const env = buildSubprocessEnv({}, upstreamOf("validate", big));
    expect(Object.hasOwn(env, "KEELSON_NODE_validate_OUTPUT_FILE")).toBe(false);
    expect(env.KEELSON_NODE_validate_OUTPUT).not.toContain("_OUTPUT_FILE");
  });

  test("with an artifacts dir the full output spills to node-outputs/<id>.txt and _FILE points at it", () => {
    const dir = mkdtempSync(join(tmpdir(), "keelson-envcap-"));
    try {
      const env = buildSubprocessEnv({}, upstreamOf("re-review", big), { artifactsDir: dir });
      const spillPath = env.KEELSON_NODE_re_review_OUTPUT_FILE as string;
      expect(spillPath).toBe(join(dir, "node-outputs", "re_review.txt"));
      expect(readFileSync(spillPath, "utf8")).toBe(big);
      expect(env.KEELSON_NODE_re_review_OUTPUT).toContain(
        "full output at $KEELSON_NODE_re_review_OUTPUT_FILE",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unwritable artifacts dir degrades to truncation-only, not a throw", () => {
    const env = buildSubprocessEnv({}, upstreamOf("validate", big), {
      artifactsDir: "/dev/null/not-a-dir",
    });
    expect(Object.hasOwn(env, "KEELSON_NODE_validate_OUTPUT_FILE")).toBe(false);
    const value = env.KEELSON_NODE_validate_OUTPUT as string;
    expect(value).toContain("[keelson: output truncated");
  });

  test("oversized inputs and ARGUMENTS are capped the same way (no file spill)", () => {
    const env = buildSubprocessEnv({ ARGUMENTS: big, notes: big }, new Map<string, NodeOutput>());
    for (const key of ["KEELSON_ARGUMENTS", "KEELSON_INPUTS_ARGUMENTS", "KEELSON_INPUTS_notes"]) {
      const value = env[key] as string;
      expect(value.length).toBeLessThan(ENV_VALUE_MAX_CHARS + 256);
      expect(value).toContain(`[keelson: input truncated — ${big.length} chars total]`);
      expect(value.startsWith("HEAD-MARKER")).toBe(true);
      expect(value.endsWith("TAIL-MARKER")).toBe(true);
    }
  });
});
