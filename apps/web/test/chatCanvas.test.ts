import { describe, expect, test } from "bun:test";
import { CANVAS_OPEN_THRESHOLD, shouldOfferCanvas } from "../src/lib/chatCanvas.ts";

const long = "x".repeat(CANVAS_OPEN_THRESHOLD + 1);
const short = "x".repeat(CANVAS_OPEN_THRESHOLD - 1);

describe("shouldOfferCanvas", () => {
  test("a finished, long assistant answer qualifies", () => {
    expect(shouldOfferCanvas("assistant", long, false)).toBe(true);
  });

  test("a still-streaming answer does not (content is still growing)", () => {
    expect(shouldOfferCanvas("assistant", long, true)).toBe(false);
  });

  test("a short assistant answer reads fine in the bubble", () => {
    expect(shouldOfferCanvas("assistant", short, false)).toBe(false);
  });

  test("the threshold is exclusive — exactly THRESHOLD chars does not qualify", () => {
    expect(shouldOfferCanvas("assistant", "x".repeat(CANVAS_OPEN_THRESHOLD), false)).toBe(false);
  });

  test("only assistant rows qualify — user/system/command are not markdown-rendered", () => {
    expect(shouldOfferCanvas("user", long, false)).toBe(false);
    expect(shouldOfferCanvas("system", long, false)).toBe(false);
    expect(shouldOfferCanvas("command", long, false)).toBe(false);
  });

  test("length is measured after trimming whitespace", () => {
    expect(shouldOfferCanvas("assistant", `${" ".repeat(5000)}hi`, false)).toBe(false);
  });
});
