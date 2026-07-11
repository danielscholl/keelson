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
  renderCoverageChecklist,
} from "../src/brief-coverage.ts";
import { rmTemp } from "./temp.ts";

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

  test("returns a parsed brief with no checklist when coverage is absent", async () => {
    writeFileSync(join(tmpDir, "brief.json"), '{"criteria":["Show covered criteria"]}');

    await expect(loadBriefAndCoverage({ artifactsDir: tmpDir })).resolves.toEqual({
      brief: { criteria: ["Show covered criteria"] },
      checklist: "",
    });
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
