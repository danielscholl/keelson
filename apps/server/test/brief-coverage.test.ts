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
  test("emits one row per criterion in brief order, flagging omitted/reordered as MISSING", () => {
    const criteria = ["a", "b", "c"];
    // Model omitted "b" and covered "a" (with a step); "c" claims covered but no step.
    const rows = reconcileCoverage(criteria, [
      { criterion: "c", covered: true, step: null },
      { criterion: "a", covered: true, step: "Task 1" },
    ]);
    expect(rows.map((r) => r.criterion)).toEqual(["a", "b", "c"]);
    expect(rows[0]).toEqual({ criterion: "a", covered: true, step: "Task 1" });
    expect(rows[1]).toEqual({ criterion: "b", covered: false, step: null }); // omitted -> MISSING
    expect(rows[2]).toEqual({ criterion: "c", covered: false, step: null }); // no step -> MISSING
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
