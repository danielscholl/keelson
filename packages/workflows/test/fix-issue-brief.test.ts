// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { bundledWorkflowsDir } from "../src/seed.ts";

const tmps: string[] = [];

afterEach(() => {
  while (tmps.length) rmSync(tmps.pop() as string, { recursive: true, force: true });
});

function extractBrief(body: string): { criteria: string[] } {
  const document = parse(
    readFileSync(join(bundledWorkflowsDir(), "fix-issue.yaml"), "utf8"),
  ) as {
    nodes: Array<{ id: string; bash?: string }>;
  };
  const script = document.nodes.find((node) => node.id === "extract-brief")?.bash;
  if (!script) throw new Error("Missing extract-brief bash node in fix-issue");

  const artifacts = mkdtempSync(join(tmpdir(), "keelson-fix-issue-brief-"));
  tmps.push(artifacts);
  const proc = Bun.spawnSync({
    cmd: ["bash", "-c", script],
    env: {
      ...(process.env as Record<string, string>),
      KEELSON_ARTIFACTS_DIR: artifacts,
      KEELSON_NODE_fetch_issue_OUTPUT: JSON.stringify({
        url: "https://github.com/danielscholl/keelson/issues/720",
        title: "Coverage extraction",
        body,
      }),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(proc.stderr.toString());
  }
  return JSON.parse(readFileSync(join(artifacts, "brief.json"), "utf8")) as {
    criteria: string[];
  };
}

describe("fix-issue brief extraction", () => {
  test.each([
    [
      "exact acceptance criteria",
      "## Acceptance Criteria\n\n- Runs the divergence check\n- Reports missing coverage\n",
      ["Runs the divergence check", "Reports missing coverage"],
    ],
    [
      "trailing parenthetical",
      "## Acceptance criteria (must all hold)\n\n- Keeps structured extraction\n",
      ["Keeps structured extraction"],
    ],
    [
      "requirements synonym",
      "## Requirements\n\n1. Extract numbered requirements\n2. Preserve their order\n",
      ["Extract numbered requirements", "Preserve their order"],
    ],
    [
      "definition of done synonym",
      "## Definition of done\n\n* Coverage runs before approval\n",
      ["Coverage runs before approval"],
    ],
    [
      "success criteria synonym",
      "## Success criteria\n\n- The PR body states the check status\n",
      ["The PR body states the check status"],
    ],
  ])("extracts bullets from a %s heading", (_name, body, criteria) => {
    expect(extractBrief(body).criteria).toEqual(criteria);
  });

  test("leaves a bug-report-shaped prose expectation for fallback extraction", () => {
    const body = `## What happened?

The approval callout omitted the coverage status.

## What did you expect?

The approval callout should state whether the divergence check ran.

## Steps to reproduce

1. Run fix-issue for a prose-only report.
2. Open the approval callout.

## Environment

macOS with the Copilot provider.
`;

    expect(extractBrief(body).criteria).toEqual([]);
  });
});
