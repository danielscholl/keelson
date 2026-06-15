// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import {
  firstClause,
  formatTokens,
  formatUsageMeter,
  parseRunArg,
  parseSlashCommand,
  relativeAge,
} from "../src/interactive/format.ts";

describe("relativeAge", () => {
  const now = new Date("2026-06-12T12:00:00.000Z");

  test("buckets by recency", () => {
    expect(relativeAge("2026-06-12T11:59:30.000Z", now)).toBe("just now");
    expect(relativeAge("2026-06-12T11:45:00.000Z", now)).toBe("15m ago");
    expect(relativeAge("2026-06-12T03:00:00.000Z", now)).toBe("9h ago");
    expect(relativeAge("2026-06-05T12:00:00.000Z", now)).toBe("7d ago");
  });

  test("tolerates garbage input", () => {
    expect(relativeAge("not-a-date", now)).toBe("unknown");
  });
});

describe("formatTokens", () => {
  test("scales units", () => {
    expect(formatTokens(340)).toBe("340");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(200_000)).toBe("200k");
    expect(formatTokens(1_500_000)).toBe("1.5M");
  });
});

describe("formatUsageMeter", () => {
  test("prefers context fill when the provider reports a window", () => {
    const meter = formatUsageMeter(
      { inputTokens: 10, outputTokens: 5, contextTokens: 24_000, contextWindow: 200_000 },
      { input: 10, output: 5 },
    );
    expect(meter).toBe("12%/200k");
  });

  test("falls back to cumulative spend", () => {
    expect(formatUsageMeter(undefined, { input: 1234, output: 340 })).toBe("↑1.2k ↓340");
  });

  test("placeholder before any usage arrives", () => {
    expect(formatUsageMeter(undefined, { input: 0, output: 0 })).toBe("—");
  });
});

describe("firstClause", () => {
  test("keeps only the lead sentence of structured catalog descriptions", () => {
    expect(firstClause("Use when: you want a roster. Triggers: 'show roster'. Does: stuff.")).toBe(
      "Use when: you want a roster.",
    );
  });

  test("bounds unpunctuated descriptions", () => {
    const out = firstClause("x".repeat(200));
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("parseSlashCommand", () => {
  test("splits name and argument", () => {
    expect(parseSlashCommand("/run smoke-test env=ci")).toEqual({
      name: "run",
      arg: "smoke-test env=ci",
    });
    expect(parseSlashCommand("/new")).toEqual({ name: "new", arg: "" });
  });

  test("rejects non-commands", () => {
    expect(parseSlashCommand("/ leading space")).toBeNull();
    expect(parseSlashCommand("/UPPER")).toBeNull();
  });
});

describe("parseRunArg", () => {
  test("extracts workflow name and key=value inputs", () => {
    expect(parseRunArg("smoke-test env=ci retries=2")).toEqual({
      name: "smoke-test",
      inputs: { env: "ci", retries: "2" },
    });
    expect(parseRunArg("smoke-test")).toEqual({ name: "smoke-test", inputs: {} });
  });

  test("rejects empty and malformed input tokens", () => {
    expect(parseRunArg("")).toBeNull();
    expect(parseRunArg("smoke-test notakv")).toBeNull();
    expect(parseRunArg("smoke-test =v")).toBeNull();
  });

  test("keeps values containing '='", () => {
    expect(parseRunArg("wf query=a=b")).toEqual({ name: "wf", inputs: { query: "a=b" } });
  });
});
