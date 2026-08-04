// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { bundledWorkflowsDir } from "../src/seed.ts";

const tmps: string[] = [];
type WorkflowNode = { id: string; bash?: string };

const document = parse(
  readFileSync(join(bundledWorkflowsDir(), "plan-act-evaluate.yaml"), "utf8"),
) as { nodes: WorkflowNode[] };

afterEach(() => {
  while (tmps.length) rmSync(tmps.pop() as string, { recursive: true, force: true });
});

function reportScript(): string {
  const node = document.nodes.find((candidate) => candidate.id === "report");
  if (!node?.bash) throw new Error("Missing report node bash in plan-act-evaluate");
  return node.bash;
}

// Runs the real `report` node against a temp artifacts dir holding only
// plan.md; every other artifact it reads has a documented fallback, and an
// absent PR number skips the forge calls.
function reportGoal(planMd: string): string[] {
  const artifacts = mkdtempSync(join(tmpdir(), "keelson-pae-goal-"));
  tmps.push(artifacts);
  writeFileSync(join(artifacts, "plan.md"), planMd);

  const proc = Bun.spawnSync({
    cmd: ["bash", "-c", reportScript()],
    env: { ...(process.env as Record<string, string>), KEELSON_ARTIFACTS_DIR: artifacts },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  const out = proc.stdout.toString();

  const lines = out.split("\n");
  const start = lines.findIndex((line) => /^\s*Goal:\s/.test(line));
  if (start === -1) throw new Error(`No Goal line in report output:\n${out}`);
  const end = lines.findIndex((line, i) => i > start && /^\s*Plan:\s/.test(line));
  const first = (lines[start] as string).replace(/^\s*Goal:\s+/, "");
  const rest = lines.slice(start + 1, end === -1 ? undefined : end);
  return [first, ...rest].map((line) => line.trim()).filter((line) => line.length > 0);
}

const hasShellTools =
  Bun.spawnSync({ cmd: ["bash", "-c", "command -v awk"], stdout: "ignore", stderr: "ignore" })
    .exitCode === 0;
const shellDescribe = hasShellTools ? describe : describe.skip;

shellDescribe("plan-act-evaluate report goal extraction", () => {
  test("plain goal section", () => {
    expect(reportGoal("## Goal\n\nShip the parser rewrite.\n")).toEqual([
      "Ship the parser rewrite.",
    ]);
  });

  test("a fenced heading neither ends the section nor reaches the summary", () => {
    const plan = [
      "## Goal",
      "",
      "Make the renderer emit sections correctly, e.g.:",
      "",
      "```markdown",
      "## Overview",
      "```",
      "",
      "Restore parity with the legacy pipeline.",
      "",
      "## Constraints",
      "",
      "- not part of the goal",
      "",
    ].join("\n");
    expect(reportGoal(plan)).toEqual([
      "Make the renderer emit sections correctly, e.g.:",
      "Restore parity with the legacy pipeline.",
    ]);
  });

  test("tilde fences are tracked independently of backticks", () => {
    const plan = [
      "## Goal",
      "",
      "Normalize headings, for example:",
      "",
      "~~~markdown",
      "## Legacy",
      "~~~",
      "",
      "Then drop the shim.",
      "",
      "## Constraints",
      "",
      "- not part of the goal",
      "",
    ].join("\n");
    expect(reportGoal(plan)).toEqual(["Normalize headings, for example:", "Then drop the shim."]);
  });

  test("a real following heading still ends the section", () => {
    const plan = ["## Goal", "", "Ship the thing.", "", "## Constraints", "", "Hidden.", ""].join(
      "\n",
    );
    expect(reportGoal(plan)).toEqual(["Ship the thing."]);
  });

  test("an unclosed fence does not swallow the rest of the plan", () => {
    const plan = [
      "## Goal",
      "",
      "Fix the parser.",
      "",
      "```text",
      "unterminated",
      "",
      "## Constraints",
      "",
      "Hidden.",
      "",
    ].join("\n");
    const goal = reportGoal(plan);
    expect(goal[0]).toBe("Fix the parser.");
    expect(goal).not.toContain("Hidden.");
  });

  test("a longer opening fence is not closed by a shorter interior one", () => {
    const plan = [
      "## Goal",
      "",
      "Render nested fences correctly, e.g.:",
      "",
      "````markdown",
      "```json",
      '{"x":1}',
      "```",
      "",
      "## Overview",
      "````",
      "",
      "Keep the trailing prose.",
      "",
      "## Constraints",
      "",
      "Hidden.",
      "",
    ].join("\n");
    expect(reportGoal(plan)).toEqual([
      "Render nested fences correctly, e.g.:",
      "Keep the trailing prose.",
    ]);
  });

  test("a longer opening tilde fence is not closed by a shorter interior one", () => {
    const plan = [
      "## Goal",
      "",
      "Normalize nested tilde fences:",
      "",
      "~~~~markdown",
      "~~~text",
      "LEAK-MARKER",
      "~~~",
      "~~~~",
      "",
      "Keep the trailing prose.",
      "",
      "## Constraints",
      "",
      "Hidden.",
      "",
    ].join("\n");
    expect(reportGoal(plan)).toEqual([
      "Normalize nested tilde fences:",
      "Keep the trailing prose.",
    ]);
  });

  test("a run carrying an info string does not close the fence", () => {
    const plan = [
      "## Goal",
      "",
      "Show a sample:",
      "",
      "```text",
      "sample",
      "```markdown",
      "LEAK-MARKER",
      "```",
      "",
      "Keep the trailing prose.",
      "",
      "## Constraints",
      "",
      "Hidden.",
      "",
    ].join("\n");
    expect(reportGoal(plan)).toEqual(["Show a sample:", "Keep the trailing prose."]);
  });

  test("goal stays capped at three lines", () => {
    const plan = ["## Goal", "", "one", "two", "three", "four", ""].join("\n");
    expect(reportGoal(plan)).toEqual(["one", "two", "three"]);
  });

  test("a plan with no goal section falls back", () => {
    expect(reportGoal("## Constraints\n\n- nothing here\n")).toEqual(["(see plan: (none))"]);
  });
});
