import { describe, expect, test } from "bun:test";
import { APPROVAL_MESSAGE_MAX_CHARS, capApprovalMessage } from "../src/workflows-handler.ts";

describe("capApprovalMessage", () => {
  test("a message within the cap passes through unchanged", () => {
    const message = "x".repeat(APPROVAL_MESSAGE_MAX_CHARS);
    expect(capApprovalMessage(message)).toBe(message);
  });

  test("a longer message keeps its head and says how much was dropped", () => {
    const capped = capApprovalMessage("y".repeat(APPROVAL_MESSAGE_MAX_CHARS + 10));
    expect(capped.startsWith("y".repeat(APPROVAL_MESSAGE_MAX_CHARS))).toBe(true);
    expect(capped).toContain("[truncated 10 characters");
  });
});
