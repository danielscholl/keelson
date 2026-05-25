import { afterEach, describe, expect, test } from "bun:test";
import type { ToolDefinition } from "@keelson/shared";
import {
  clearRegistry,
  getRegisteredTools,
  getToolByName,
  isRegisteredTool,
  registerTool,
} from "../src/registry.ts";

function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `test tool ${name}`,
    inputSchema: { type: "object", properties: {} },
    handler: async () => ({ ok: true, data: null }),
  } as unknown as ToolDefinition;
}

describe("skills/registry", () => {
  afterEach(() => {
    clearRegistry();
  });

  test("register then lookup round-trips", () => {
    const tool = makeTool("alpha");
    registerTool(tool);
    expect(isRegisteredTool("alpha")).toBe(true);
    expect(getToolByName("alpha")).toBe(tool);
    expect(getRegisteredTools()).toHaveLength(1);
  });

  test("duplicate registration throws", () => {
    registerTool(makeTool("beta"));
    expect(() => registerTool(makeTool("beta"))).toThrow(
      /already registered/i,
    );
  });

  test("missing tool reports the available set", () => {
    registerTool(makeTool("gamma"));
    expect(() => getToolByName("delta")).toThrow(/Unknown tool 'delta'/);
    expect(() => getToolByName("delta")).toThrow(/gamma/);
  });
});
