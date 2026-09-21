// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
import { classifyModelVendor } from "./model-vendor.ts";

describe("classifyModelVendor", () => {
  test.each([
    ["copilot", "claude-sonnet-5", "anthropic"],
    ["copilot", "gpt-6-astra", "openai"],
    ["copilot", "grok-4.6", "xai"],
    ["pi", "google/gemini-3.7-flash", "google"],
    ["pi", "openai/o3-mini", "openai"],
    ["gateway", "meta/llama-4", "meta"],
  ])("classifies %s/%s as %s", (provider, model, vendor) => {
    expect(classifyModelVendor(provider, model)).toBe(vendor);
  });

  test("uses native provider identity when a model alias is opaque", () => {
    expect(classifyModelVendor("claude", "default")).toBe("anthropic");
    expect(classifyModelVendor("codex", "account-default")).toBe("openai");
  });

  test("does not invent a vendor for dynamic providers", () => {
    expect(classifyModelVendor("copilot", "auto")).toBeUndefined();
    expect(classifyModelVendor("my-gateway", "local-model")).toBeUndefined();
  });
});
