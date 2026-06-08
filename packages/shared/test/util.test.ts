import { describe, expect, it } from "bun:test";
import { expectView } from "../src/canvas.ts";
import { asNonEmptyString, asStringArray, errText } from "../src/util.ts";

describe("errText", () => {
  it("returns the message of an Error", () => {
    expect(errText(new Error("boom"))).toBe("boom");
  });

  it("stringifies a non-Error", () => {
    expect(errText("plain")).toBe("plain");
    expect(errText(42)).toBe("42");
    expect(errText(null)).toBe("null");
    expect(errText(undefined)).toBe("undefined");
  });
});

describe("asNonEmptyString", () => {
  it("trims and returns a non-empty string", () => {
    expect(asNonEmptyString("  hi  ")).toBe("hi");
  });

  it("returns '' for whitespace-only, empty, or non-string input", () => {
    expect(asNonEmptyString("   ")).toBe("");
    expect(asNonEmptyString("")).toBe("");
    expect(asNonEmptyString(undefined)).toBe("");
    expect(asNonEmptyString(123)).toBe("");
    expect(asNonEmptyString(["a"])).toBe("");
  });
});

describe("asStringArray", () => {
  it("keeps only string elements", () => {
    expect(asStringArray(["a", 1, "b", null, "c"])).toEqual(["a", "b", "c"]);
  });

  it("returns [] for non-array input", () => {
    expect(asStringArray("a")).toEqual([]);
    expect(asStringArray(undefined)).toEqual([]);
    expect(asStringArray({ 0: "a" })).toEqual([]);
  });
});

describe("expectView", () => {
  const board = { view: "board", title: "Room", sections: [] };

  it("returns the parsed view when the kind matches", () => {
    const got = expectView("k", "board")(board);
    expect(got.view).toBe("board");
  });

  it("throws with the key and expected kind when the discriminant differs", () => {
    expect(() => expectView("rib:x:topology", "graph")(board)).toThrow(
      'rib:x:topology expects a graph view, got "board"',
    );
  });

  it("throws when the data is not a valid canvas view", () => {
    expect(() => expectView("k", "board")({ view: "nope" })).toThrow();
  });
});
