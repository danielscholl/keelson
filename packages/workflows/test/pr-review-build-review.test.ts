// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseWorkflow } from "../src/loader.ts";

const bashDescribe = process.platform === "win32" ? describe.skip : describe;

interface Finding {
  path: string;
  line: number;
  severity: string;
  confidence: number;
  what: string;
  why: string;
  fix: string;
  repro?: string;
}

interface Comment {
  path: string;
  line: number;
  body: string;
}

bashDescribe("pr-review build-review repro rendering", () => {
  const tmps: string[] = [];
  afterEach(() => {
    for (const dir of tmps.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function script(): string {
    const filePath = join(import.meta.dir, "../assets/workflows/pr-review.yaml");
    const result = parseWorkflow(readFileSync(filePath, "utf8"), filePath);
    expect(result.error).toBeNull();
    const bash = result.workflow?.nodes.find((n) => n.id === "build-review")?.bash;
    if (!bash) throw new Error("build-review has no bash body");
    return bash;
  }

  function render(findings: Finding[]): Comment[] {
    return renderPayload(findings).comments;
  }

  function renderPayload(findings: Finding[]): { body: string; comments: Comment[] } {
    const artifacts = mkdtempSync(join(tmpdir(), "keelson-build-review-"));
    tmps.push(artifacts);
    writeFileSync(
      join(artifacts, "diff.patch"),
      [
        "diff --git a/a.ts b/a.ts",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -1,2 +1,3 @@",
        " const x = 1;",
        "+const y = 2;",
        " const z = 3;",
        "",
      ].join("\n"),
    );
    const triage = { verdict: "NEEDS FIXES", summary: "I checked it.", findings };
    const proc = Bun.spawnSync({
      cmd: ["bash", "-c", script()],
      cwd: artifacts,
      env: {
        ...(process.env as Record<string, string>),
        KEELSON_ARTIFACTS_DIR: artifacts,
        KEELSON_NODE_triage_OUTPUT: JSON.stringify(triage),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
    return JSON.parse(readFileSync(join(artifacts, "payload.json"), "utf8")) as {
      body: string;
      comments: Comment[];
    };
  }

  const base = { path: "a.ts", severity: "HIGH", confidence: 90, what: "w", why: "because" };

  test("renders a real repro under the rationale, before any suggestion block", () => {
    const [comment] = render([
      { ...base, line: 2, fix: "const y = 3;", repro: "bun test a.test.ts: expected 3, got 2" },
    ]);
    expect(comment?.body).toBe(
      "blocking: w\n\nbecause\n\nRepro: bun test a.test.ts: expected 3, got 2\n\n```suggestion\nconst y = 3;\n```",
    );
  });

  test("omits the line for a `none` repro with or without a reason", () => {
    const comments = render([
      { ...base, line: 2, fix: "", repro: "none: needs a live token" },
      { ...base, line: 3, fix: "", repro: "none" },
    ]);
    for (const comment of comments) {
      expect(comment.body).toBe("blocking: w\n\nbecause");
      expect(comment.body).not.toContain("Repro");
    }
  });

  test("omits the line when the field is absent", () => {
    const [comment] = render([{ ...base, line: 2, fix: "" }]);
    expect(comment?.body).toBe("blocking: w\n\nbecause");
  });

  test("a finding that cannot be anchored keeps its repro in the review body", () => {
    const { body, comments } = renderPayload([
      { ...base, line: 40, fix: "", repro: "bun test a.test.ts\nexpected 3, got 2" },
      { ...base, line: 41, fix: "", repro: "none" },
    ]);
    expect(comments).toEqual([]);
    expect(body).toContain(
      "- blocking: `a.ts` — w\n  Repro: bun test a.test.ts\n  expected 3, got 2\n- blocking: `a.ts` — w\n\n<!--",
    );
  });

  test("keeps a repro that only resembles the sentinel", () => {
    const comments = render([
      { ...base, line: 1, fix: "", repro: "nonexistent key read" },
      { ...base, line: 2, fix: "", repro: "None input: observed TypeError, expected empty result" },
      { ...base, line: 3, fix: "", repro: "NONE" },
    ]);
    expect(comments.map((c) => c.body)).toEqual([
      "blocking: w\n\nbecause\n\nRepro: nonexistent key read",
      "blocking: w\n\nbecause\n\nRepro: None input: observed TypeError, expected empty result",
      "blocking: w\n\nbecause\n\nRepro: NONE",
    ]);
  });
});
