// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");

// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseWorkflow } from "../src/loader.ts";
import type { DagNode } from "../src/schema/index.ts";

const WORKFLOW_PATH = join(import.meta.dir, "../assets/workflows/hillclimb.yaml");

function load() {
  const source = readFileSync(WORKFLOW_PATH, "utf8");
  const result = parseWorkflow(source, WORKFLOW_PATH);
  if (result.error !== null || result.workflow === null) {
    throw new Error(result.error?.error ?? "hillclimb did not parse");
  }
  return { source, workflow: result.workflow };
}

function node(id: string): DagNode {
  const found = load().workflow.nodes.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`hillclimb has no node '${id}'`);
  return found;
}

const compact = (text: string | undefined) => (text ?? "").replace(/\s+/g, " ");

describe("hillclimb workflow contract", () => {
  test("parses with the four-section description header", () => {
    const { workflow } = load();
    expect(workflow.name).toBe("hillclimb");
    for (const section of ["Use when:", "Triggers:", "Does:", "NOT for:"]) {
      expect(workflow.description).toContain(section);
    }
  });

  test("holds no project lock, so the nested eval runs can start", () => {
    expect(load().workflow.mutates_checkout).toBe(false);
  });

  test("every node a gate reads from declares a structured output contract", () => {
    for (const id of ["propose-1", "propose-2", "propose-3"]) {
      const propose = node(id);
      expect(propose.output_format).toMatchObject({
        type: "object",
        required: ["changed", "root_cause", "change_summary"],
      });
      expect(propose.output_schema as unknown).toEqual(propose.output_format);
    }
    const bucket = node("bucket");
    expect(bucket.output_format).toMatchObject({
      type: "object",
      required: ["buckets", "ambiguous", "recommendation"],
    });
    expect(bucket.output_schema as unknown).toEqual(bucket.output_format);
    for (const id of ["preflight", "baseline", "round-1", "round-2", "round-3", "collect"]) {
      expect(node(id).output_schema?.type).toBe("object");
    }
    expect(node("round-1").output_schema?.required).toContain("continue");
    expect(node("collect").output_schema?.required).toContain("remaining_failures");
  });

  test("rounds chain on the previous round's continue flag and always settle", () => {
    expect(node("propose-1").depends_on).toEqual(["baseline"]);
    expect(node("propose-2").when).toBe("$round-1.output.continue == 'true'");
    expect(node("propose-3").when).toBe("$round-2.output.continue == 'true'");
    for (const id of ["round-1", "round-2", "round-3"]) {
      expect(node(id).trigger_rule).toBe("all_done");
      expect(node(id).bash).toBe(node("round-1").bash);
    }
    expect(node("collect").depends_on).toEqual(["round-1", "round-2", "round-3"]);
    expect(node("collect").trigger_rule).toBe("all_done");
    expect(node("bucket").when).toBe("$collect.output.remaining_failures > '0'");
    expect(node("report").trigger_rule).toBe("none_failed_min_one_success");
  });

  test("the proposer edits only the target and never copies failures into it", () => {
    for (const id of ["propose-1", "propose-2", "propose-3"]) {
      const propose = node(id);
      expect(propose.allowed_tools).toEqual(["Read", "Glob", "Grep", "Edit"]);
      expect(propose.context).toBe("fresh");
      expect(propose.model).toBe("deep");
      const prompt = compact(propose.prompt);
      expect(prompt).toContain("ONE change");
      expect(prompt).toContain("Never paste text from an output file");
      expect(prompt).toContain("never name a case id");
      expect(prompt).toContain("Never add a special case for one input");
      expect(prompt).toContain("Edit prompt text only");
      expect(prompt).toContain("$ARTIFACTS_DIR/train-view/");
      expect(prompt).not.toContain("test-view");
      expect(prompt).not.toContain("final-view");
    }
  });

  test("the proposer's view is built from the train split alone", () => {
    const baseline = node("baseline").bash ?? "";
    const round = node("round-1").bash ?? "";
    for (const body of [baseline, round]) {
      const views = [...body.matchAll(/hc-view" "[^"]+" "([^"]+)" (\w+)/g)];
      expect(views.length).toBeGreaterThan(0);
      for (const [, dest, split] of views) {
        expect(dest).toBe("$A/train-view");
        expect(split).toBe("train");
      }
    }
    const collect = node("collect").bash ?? "";
    expect(collect).toContain('hc-view" "$A/kept.json" "$A/final-view" all');
  });

  test("keep and revert follow the compare decision", () => {
    const round = node("round-1").bash ?? "";
    expect(round).toContain('eval compare "$A/kept.json" "$A/round-$N.json"');
    expect(round).toContain('if [ "$DECISION" != "keep" ]; then');
    expect(round).toContain('git -C "$REPO" commit -q');
    expect(round).toContain('flat "revert" "$REASON"');
  });

  test("the report closes with the confirm directive", () => {
    expect(node("report").prompt).toContain("$DIRECTIVES.confirm");
    expect(node("report").allowed_tools).toEqual([]);
    expect(node("report").model).toBe("balanced");
  });
});
