// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");

// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { bundledWorkflowsDir } from "../src/seed.ts";

const shimDescribe = process.platform === "win32" ? describe.skip : describe;

function extractPr(args: string): string {
  const document = parse(readFileSync(join(bundledWorkflowsDir(), "pr-review.yaml"), "utf8")) as {
    nodes: Array<{ id: string; bash?: string }>;
  };
  const script = document.nodes.find((node) => node.id === "extract-pr")?.bash;
  if (!script) throw new Error("Missing extract-pr bash node in pr-review");
  const proc = Bun.spawnSync({
    cmd: ["bash", "-c", script],
    env: { ...(process.env as Record<string, string>), KEELSON_ARGUMENTS: args },
    stdout: "pipe",
  });
  return proc.stdout.toString().trim();
}

shimDescribe("pr-review extract-pr", () => {
  test.each([
    ["review pr 42", "42"],
    ["42", "42"],
    ["  7 ", "7"],
    ["review 42", "42"],
    ["#17", "17"],
    ["PR#9", "9"],
    ["PR: 42", "42"],
    ["review PR-42", "42"],
    ["pull request 42", "42"],
    ["review MR !813", "813"],
    ["https://github.com/o/r/pull/913", "913"],
    ["https://gitlab.com/g/p/-/merge_requests/55", "55"],
    ["https://github.com/acme/pr2/pull/42", "42"],
    ["fixes issue #17, review PR 42", "42"],
    ["pr 42 (see #42)", "42"],
  ])("%s -> %s", (args, expected) => {
    expect(extractPr(args)).toBe(expected);
  });

  test.each([
    ["review the latest PR"],
    ["improve 3 things"],
    ["review #3 and #4"],
    ["compare pr 5 with pr 6"],
  ])("refuses to guess from %s", (args) => {
    expect(extractPr(args)).toBe("CURRENT");
  });
});
