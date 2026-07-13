// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseWorkflow } from "@keelson/workflows";

const BIN = resolve(import.meta.dir, "..", "bin", "keelson.ts");
const FIXTURES = resolve(import.meta.dir, "fixtures");

async function runCli(args: readonly string[]): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", BIN, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { stdout, exitCode };
}

describe("workflow validate --dir (CLI)", () => {
  test("validates a named workflow from an explicit directory", async () => {
    const { stdout, exitCode } = await runCli([
      "--json",
      "workflow",
      "validate",
      "smoke-bash",
      "--dir",
      FIXTURES,
    ]);
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout.trim());
    expect(envelope.ok).toBe(true);
    expect(envelope.data.failed).toBe(0);
  });

  test("exits 4 when the name is missing from the explicit directory", async () => {
    const { exitCode } = await runCli([
      "--json",
      "workflow",
      "validate",
      "no-such-workflow",
      "--dir",
      FIXTURES,
    ]);
    expect(exitCode).toBe(4);
  });

  test("rejects an empty --dir rather than silently using the default catalog", async () => {
    const { stdout, exitCode } = await runCli(["--json", "workflow", "validate", "--dir", ""]);
    expect(exitCode).toBe(2);
    const envelope = JSON.parse(stdout.trim());
    expect(envelope.ok).toBe(false);
  });
});

describe("workflow validate (parseWorkflow fixture coverage)", () => {
  test("a valid fixture parses with no error", () => {
    const filename = `${FIXTURES}/smoke-bash.yaml`;
    const content = readFileSync(filename, "utf-8");
    const result = parseWorkflow(content, filename);
    expect(result.error).toBeNull();
    expect(result.workflow?.name).toBe("smoke-bash");
    expect(result.workflow?.nodes).toHaveLength(1);
  });

  test("a broken fixture produces a schema error", () => {
    const filename = `${FIXTURES}/broken.yaml`;
    const content = readFileSync(filename, "utf-8");
    const result = parseWorkflow(content, filename);
    expect(result.workflow).toBeNull();
    expect(result.error).not.toBeNull();
  });
});

describe("pr-review workflow node graph", () => {
  const WORKFLOWS = resolve(
    import.meta.dir,
    "..",
    "..",
    "..",
    "packages",
    "workflows",
    "assets",
    "workflows",
  );

  test("pr-review parses without error", () => {
    const filename = `${WORKFLOWS}/pr-review.yaml`;
    const content = readFileSync(filename, "utf-8");
    const result = parseWorkflow(content, filename);
    expect(result.error).toBeNull();
    expect(result.workflow).not.toBeNull();
  });

  test("pr-review contains triage, build-review, and post-review nodes", () => {
    const filename = `${WORKFLOWS}/pr-review.yaml`;
    const content = readFileSync(filename, "utf-8");
    const result = parseWorkflow(content, filename);
    const ids = result.workflow?.nodes.map((n) => n.id) ?? [];
    expect(ids).toContain("triage");
    expect(ids).toContain("build-review");
    expect(ids).toContain("post-review");
  });

  test("triage node is pinned to claude-opus-4.8", () => {
    const filename = `${WORKFLOWS}/pr-review.yaml`;
    const content = readFileSync(filename, "utf-8");
    const result = parseWorkflow(content, filename);
    const triage = result.workflow?.nodes.find((n) => n.id === "triage");
    expect(triage?.model).toBe("claude-opus-4.8");
  });

  test("no node posts a plain comment; post-review uses the batched review verb", () => {
    const filename = `${WORKFLOWS}/pr-review.yaml`;
    const content = readFileSync(filename, "utf-8");
    // The synthesis posts as a single batched PR review — never a plain PR
    // comment — routed through the forge shim (portable to gh/glab) rather than
    // a hardcoded gh reviews-API path.
    expect(content).not.toContain("gh pr comment");
    expect(content).not.toContain("forge pr comment");
    expect(content).toContain("forge pr review-batch");
  });

  function buildReviewBash(): string {
    const filename = `${WORKFLOWS}/pr-review.yaml`;
    const content = readFileSync(filename, "utf-8");
    const node = parseWorkflow(content, filename).workflow?.nodes.find(
      (n) => n.id === "build-review",
    );
    return (node as { bash?: string } | undefined)?.bash ?? "";
  }

  test("build-review awk avoids the gawk-only 3-arg match()", () => {
    const bash = buildReviewBash();
    // `match(str, /re/, arr)` is a GNU-awk extension; BSD awk (macOS) and mawk
    // (Ubuntu CI) reject it, which would fail the node and skip the review post.
    expect(bash).not.toMatch(/match\s*\([^)]*,[^)]*,[^)]*\)/);
    expect(bash).toContain("split($3");
  });

  test("build-review awk anchors added and context lines on a real diff", async () => {
    const program = buildReviewBash().match(/awk '([\s\S]*?)'\s*"\$DIFF"/)?.[1];
    expect(program).toBeTruthy();

    const fixture = [
      "diff --git a/foo.ts b/foo.ts",
      "index 111..222 100644",
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -10,3 +10,4 @@ function x() {",
      "   const a = 1;",
      "+  const b = 2;",
      "   return a;",
      " }",
      "",
    ].join("\n");

    const proc = Bun.spawn(["awk", program as string], {
      stdin: new TextEncoder().encode(fixture),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(0);
    const lines = out.trim().split("\n");
    expect(lines).toContain("foo.ts\t11\t  const b = 2;"); // added line, with content
    expect(lines).toContain("foo.ts\t10\t  const a = 1;"); // context line, now anchorable
  }, 15000);
});

describe("bundled workflows are forge-portable (no direct gh)", () => {
  const WORKFLOWS = resolve(
    import.meta.dir,
    "..",
    "..",
    "..",
    "packages",
    "workflows",
    "assets",
    "workflows",
  );

  // The bundled workflows must call `forge` (portable to gh/glab), never `gh`
  // directly — otherwise they silently regress to GitHub-only. Match any `gh`
  // invocation (a bare `gh` word followed by a subcommand), not a fixed
  // allowlist, so a new GitHub-only verb (`gh workflow`, `gh release`, …) can't
  // slip past. `GitHub`, `high`, and `ghost` are not word-boundary `gh ` matches.
  const files = readdirSync(WORKFLOWS).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  const GH_CALL = /\bgh\s+[a-z]/;
  for (const file of files) {
    test(`${file} calls forge, not gh`, () => {
      const content = readFileSync(resolve(WORKFLOWS, file), "utf-8");
      const offenders = content
        .split("\n")
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => GH_CALL.test(line));
      expect(offenders.map((o) => `${file}:${o.n}: ${o.line.trim()}`)).toEqual([]);
    });
  }
});
