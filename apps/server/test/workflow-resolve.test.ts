// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import { diceCoefficient, resolveWorkflowName } from "../src/workflow-resolve.ts";

const CATALOG = [
  "architect",
  "fix-issue",
  "memory",
  "plan-act-evaluate",
  "pr-review",
  "smoke-test",
];

describe("diceCoefficient", () => {
  test("identical normalized names score 1", () => {
    expect(diceCoefficient("smoke-test", "smoke test")).toBe(1);
    expect(diceCoefficient("Smoke-Test", "smoketest")).toBe(1);
  });

  test("unrelated names score low", () => {
    expect(diceCoefficient("deploy", "architect")).toBeLessThan(0.3);
  });

  test("a single-character typo still scores high", () => {
    expect(diceCoefficient("smoketst", "smoke-test")).toBeGreaterThan(0.7);
  });
});

describe("resolveWorkflowName — strict tiers run", () => {
  test("exact name", () => {
    expect(resolveWorkflowName("smoke-test", CATALOG)).toEqual({
      kind: "match",
      name: "smoke-test",
    });
  });

  test("case-insensitive", () => {
    expect(resolveWorkflowName("Fix-Issue", CATALOG)).toEqual({ kind: "match", name: "fix-issue" });
  });

  test("missing hyphen (normalized)", () => {
    expect(resolveWorkflowName("smoketest", CATALOG)).toEqual({
      kind: "match",
      name: "smoke-test",
    });
  });

  test("spaces for hyphens (normalized)", () => {
    expect(resolveWorkflowName("plan act evaluate", CATALOG)).toEqual({
      kind: "match",
      name: "plan-act-evaluate",
    });
  });
});

describe("resolveWorkflowName — a typo suggests, never auto-runs", () => {
  test("a one-letter typo surfaces the intended name as a suggestion", () => {
    // Deliberately NOT a match: fuzzy auto-run can't be made safe for
    // state-changing workflows (e.g. "preview" is one edit from pr-review).
    const r = resolveWorkflowName("smoketst", CATALOG);
    expect(r.kind).toBe("suggest");
    if (r.kind === "suggest") expect(r.candidates).toContain("smoke-test");
  });
});

describe("resolveWorkflowName — weak guess suggests", () => {
  test("a short abbreviation suggests rather than runs", () => {
    expect(resolveWorkflowName("arch", CATALOG)).toEqual({
      kind: "suggest",
      candidates: ["architect"],
    });
  });

  test("a partial prefix Dice underweights still surfaces as a suggestion", () => {
    const r = resolveWorkflowName("fix", CATALOG);
    expect(r.kind).toBe("suggest");
    if (r.kind === "suggest") expect(r.candidates).toContain("fix-issue");
  });

  test("a normalized collision suggests every colliding name", () => {
    // Both normalize to "smoketest", so the input can't disambiguate — surface
    // both rather than guessing.
    expect(resolveWorkflowName("smoketest", ["smoke-test", "smoke_test"])).toEqual({
      kind: "suggest",
      candidates: ["smoke-test", "smoke_test"],
    });
  });

  test("a partial shared by similar names suggests rather than auto-running one", () => {
    // "review" is a substring of both — a partial, not a whole-name typo — so it
    // surfaces suggestions instead of confidently starting pr-review.
    const r = resolveWorkflowName("review", ["pr-review", "code-review"]);
    expect(r.kind).toBe("suggest");
    if (r.kind === "suggest") expect(r.candidates).toContain("pr-review");
  });
});

describe("resolveWorkflowName — partial names never auto-run", () => {
  // Prefixes / abbreviations can score high on Dice but are not whole-name
  // typos; auto-running them would guess at a state-changing workflow.
  test("a prefix or abbreviation degrades to a suggestion", () => {
    for (const input of ["smoket", "fixissu", "plan-act"]) {
      const r = resolveWorkflowName(input, CATALOG);
      expect(r.kind).toBe("suggest");
    }
  });
});

describe("resolveWorkflowName — name with arguments never auto-runs", () => {
  // High Dice against the name, but the extra length means it's really
  // name+args — auto-running would silently drop the arguments, so suggest.
  test("a name plus an issue number degrades to a suggestion", () => {
    const r = resolveWorkflowName("fix issue #123", CATALOG);
    expect(r.kind).toBe("suggest");
    if (r.kind === "suggest") expect(r.candidates).toContain("fix-issue");
  });

  test("a name plus trailing words degrades to a suggestion", () => {
    const r = resolveWorkflowName("smoke test now", CATALOG);
    expect(r.kind).toBe("suggest");
    if (r.kind === "suggest") expect(r.candidates).toContain("smoke-test");
  });

  test("a name plus a SHORT issue number still degrades to a suggestion", () => {
    // The length ratio alone can't catch these (fixissue1 is one char over
    // fix-issue) — the whitespace/trailing-digit fingerprints do.
    for (const input of ["fix issue #1", "fix issue #12", "fix-issue 7"]) {
      const r = resolveWorkflowName(input, CATALOG);
      expect(r.kind).toBe("suggest");
      if (r.kind === "suggest") expect(r.candidates).toContain("fix-issue");
    }
  });
});

describe("resolveWorkflowName — no match", () => {
  test("an unrelated term returns none", () => {
    expect(resolveWorkflowName("deploy", CATALOG)).toEqual({ kind: "none" });
  });

  test("blank input returns none", () => {
    expect(resolveWorkflowName("   ", CATALOG)).toEqual({ kind: "none" });
  });
});
