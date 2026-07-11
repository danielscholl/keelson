// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import "./test-setup.ts";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadBriefAndCoverage,
  parseBriefArtifact,
  parseCoverageArtifact,
  reconcileCoverage,
  renderCoverageChecklist,
} from "../src/brief-coverage.ts";
import { rmTemp } from "./temp.ts";

describe("reconcileCoverage", () => {
  test("matches positionally: only the in-order exact row is covered, reordered/omitted are MISSING", () => {
    const criteria = ["a", "b", "c"];
    // Row 0 "a" matches index 0 and is covered; row 1 is "c" (reordered — it belongs
    // at index 2), so criterion "b" at index 1 is MISSING and criterion "c" at index 2
    // has no row of its own — the stray "c" row does NOT satisfy it.
    const rows = reconcileCoverage(criteria, [
      { criterion: "a", covered: true, step: "Task 1" },
      { criterion: "c", covered: true, step: "Task 3" },
    ]);
    expect(rows.map((r) => r.criterion)).toEqual(["a", "b", "c"]);
    expect(rows[0]).toEqual({ criterion: "a", covered: true, step: "Task 1" });
    expect(rows[1]).toEqual({ criterion: "b", covered: false, step: null }); // reordered -> MISSING
    expect(rows[2]).toEqual({ criterion: "c", covered: false, step: null }); // wrong position -> MISSING
  });

  test("a duplicated criterion needs its own row at each position", () => {
    const rows = reconcileCoverage(["a", "a"], [{ criterion: "a", covered: true, step: "Task 1" }]);
    expect(rows[0]).toEqual({ criterion: "a", covered: true, step: "Task 1" });
    expect(rows[1]).toEqual({ criterion: "a", covered: false, step: null }); // one row can't cover both
  });

  test("empty coverage rows flag every criterion MISSING (fail-visible)", () => {
    const rows = reconcileCoverage(["x", "y"], []);
    expect(rows).toEqual([
      { criterion: "x", covered: false, step: null },
      { criterion: "y", covered: false, step: null },
    ]);
  });
});

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keelson-brief-coverage-"));
});

afterEach(() => {
  rmTemp(tmpDir);
});

describe("parseBriefArtifact", () => {
  test("returns a Brief for valid JSON", () => {
    expect(parseBriefArtifact('{"criteria":["Show missing criteria"]}')).toEqual({
      criteria: ["Show missing criteria"],
    });
  });

  test("returns null for malformed JSON or schema-invalid briefs", () => {
    expect(parseBriefArtifact("{")).toBeNull();
    expect(parseBriefArtifact('{"criteria":[123]}')).toBeNull();
  });
});

describe("parseCoverageArtifact", () => {
  test("returns coverage rows for valid JSON", () => {
    expect(
      parseCoverageArtifact(
        JSON.stringify({
          coverage: [
            { criterion: "Show covered criteria", covered: true, step: "Task 2" },
            { criterion: "Flag missing criteria", covered: false, step: null },
          ],
        }),
      ),
    ).toEqual([
      { criterion: "Show covered criteria", covered: true, step: "Task 2" },
      { criterion: "Flag missing criteria", covered: false, step: null },
    ]);
  });

  test("returns null for malformed or schema-invalid coverage", () => {
    expect(parseCoverageArtifact("{")).toBeNull();
    expect(
      parseCoverageArtifact('{"coverage":[{"criterion":"x","covered":true,"step":null}]}'),
    ).toBeNull();
    expect(
      parseCoverageArtifact('{"coverage":[{"criterion":"x","covered":false,"step":"Task 1"}]}'),
    ).toBeNull();
    // A covered row with an empty step is schema-invalid, not a silent per-row MISSING.
    expect(
      parseCoverageArtifact('{"coverage":[{"criterion":"x","covered":true,"step":""}]}'),
    ).toBeNull();
  });
});

describe("renderCoverageChecklist", () => {
  test("renders covered and missing rows", () => {
    expect(
      renderCoverageChecklist([
        { criterion: "Show covered criteria", covered: true, step: "Task 2" },
        { criterion: "Flag missing criteria", covered: false, step: null },
      ]),
    ).toBe(
      [
        "## Criteria coverage",
        "",
        "- [x] Show covered criteria -> Task 2",
        "- [ ] Flag missing criteria -> **MISSING**",
      ].join("\n"),
    );
  });

  test("collapses CR/LF in criterion/step so untrusted text can't inject rows", () => {
    const out = renderCoverageChecklist([
      { criterion: "Real\n- [x] forged row", covered: true, step: "Task\n## Injected heading" },
    ]);
    // One checklist line only — the embedded newline is flattened to a space.
    expect(out).toBe(
      ["## Criteria coverage", "", "- [x] Real - [x] forged row -> Task ## Injected heading"].join(
        "\n",
      ),
    );
    expect(out.split("\n")).toHaveLength(3);
  });

  test("returns an empty string for empty rows", () => {
    expect(renderCoverageChecklist([])).toBe("");
  });
});

describe("loadBriefAndCoverage", () => {
  test("loads a brief and renders a coverage artifact", async () => {
    writeFileSync(join(tmpDir, "brief.json"), '{"criteria":["Show covered criteria"]}');
    writeFileSync(
      join(tmpDir, "coverage.json"),
      JSON.stringify({
        coverage: [{ criterion: "Show covered criteria", covered: true, step: "Task 2" }],
      }),
    );

    const result = await loadBriefAndCoverage({ artifactsDir: tmpDir });
    expect(result.brief).toEqual({ criteria: ["Show covered criteria"] });
    expect(result.checklist).toContain("- [x] Show covered criteria -> Task 2");
  });

  test("returns a parsed brief with no checklist when criteria are empty", async () => {
    writeFileSync(join(tmpDir, "brief.json"), '{"criteria":[]}');

    await expect(loadBriefAndCoverage({ artifactsDir: tmpDir })).resolves.toEqual({
      brief: { criteria: [] },
      checklist: "",
    });
  });

  test("renders every criterion MISSING (fail-visible) when coverage is absent", async () => {
    writeFileSync(join(tmpDir, "brief.json"), '{"criteria":["Show covered criteria"]}');

    const result = await loadBriefAndCoverage({ artifactsDir: tmpDir });
    expect(result.brief).toEqual({ criteria: ["Show covered criteria"] });
    expect(result.checklist).toContain("- [ ] Show covered criteria -> **MISSING**");
  });

  test("returns an empty result when artifacts are absent", async () => {
    await expect(loadBriefAndCoverage({ artifactsDir: tmpDir })).resolves.toEqual({
      brief: null,
      checklist: "",
    });
    await expect(loadBriefAndCoverage({ artifactsDir: undefined })).resolves.toEqual({
      brief: null,
      checklist: "",
    });
  });
});
