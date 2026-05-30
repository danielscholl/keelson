import { describe, expect, test } from "bun:test";
import { parseWorkflowDescription } from "../src/description.ts";

describe("parseWorkflowDescription", () => {
  test("empty input returns empty object", () => {
    expect(parseWorkflowDescription("")).toEqual({});
    expect(parseWorkflowDescription(null)).toEqual({});
    expect(parseWorkflowDescription(undefined)).toEqual({});
  });

  test("text without section headers falls back to body", () => {
    const result = parseWorkflowDescription("Just a plain description.");
    expect(result).toEqual({ body: "Just a plain description." });
  });

  test("recognizes the structured section labels", () => {
    const result = parseWorkflowDescription(
      [
        "Use when: starting a new run",
        "Triggers: smoke, sanity",
        "Does: walks the DAG end-to-end",
        "NOT for: production traffic",
      ].join("\n"),
    );
    expect(result.useWhen).toBe("starting a new run");
    expect(result.triggers).toBe("smoke, sanity");
    expect(result.does).toBe("walks the DAG end-to-end");
    expect(result.notFor).toBe("production traffic");
  });

  test("pre-section prose lands in body", () => {
    const result = parseWorkflowDescription(
      ["A leading paragraph.", "", "Use when: later"].join("\n"),
    );
    expect(result.body).toBe("A leading paragraph.");
    expect(result.useWhen).toBe("later");
  });
});
