import { describe, expect, it } from "bun:test";
import type { Rib, RibContext } from "../src/rib.ts";
import {
  listRibsResponseSchema,
  ribActionResponseSchema,
  ribActionSchema,
  ribAuthStatusSchema,
  ribViewDescriptorSchema,
} from "../src/rib.ts";

describe("rib v2 wire schemas", () => {
  it("round-trips a view descriptor", () => {
    const v = ribViewDescriptorSchema.parse({
      key: "rib:osdu:graph",
      canvasKind: "view",
      title: "Live graph",
    });
    expect(v).toEqual({ key: "rib:osdu:graph", canvasKind: "view", title: "Live graph" });
  });

  it("rejects a view descriptor with an unknown canvas kind", () => {
    expect(ribViewDescriptorSchema.safeParse({ key: "k", canvasKind: "pie" }).success).toBe(false);
  });

  it("parses an inbound action with an opaque payload", () => {
    const a = ribActionSchema.parse({ type: "refresh", payload: { scope: "all" } });
    expect(a.type).toBe("refresh");
    expect(a.payload).toEqual({ scope: "all" });
  });

  it("rejects an action with an empty type", () => {
    expect(ribActionSchema.safeParse({ type: "" }).success).toBe(false);
  });

  it("round-trips both action-result variants", () => {
    expect(ribActionResponseSchema.parse({ ok: true, data: { n: 1 } })).toEqual({
      ok: true,
      data: { n: 1 },
    });
    expect(ribActionResponseSchema.parse({ ok: false, error: "boom" })).toEqual({
      ok: false,
      error: "boom",
    });
  });

  it("round-trips an auth status", () => {
    expect(ribAuthStatusSchema.parse({ authenticated: false, statusMessage: "no token" })).toEqual({
      authenticated: false,
      statusMessage: "no token",
    });
  });

  it("parses an empty ribs list and a fully-populated summary", () => {
    expect(listRibsResponseSchema.parse({ ribs: [] }).ribs).toEqual([]);
    const res = listRibsResponseSchema.parse({
      ribs: [
        {
          id: "osdu",
          displayName: "OSDU Bridge",
          registered: ["osdu.search"],
          views: [{ key: "rib:osdu:graph", canvasKind: "view" }],
          actions: [{ type: "refresh", label: "Refresh" }],
          hasOnAction: true,
          auth: { authenticated: true },
        },
      ],
    });
    expect(res.ribs[0]?.id).toBe("osdu");
  });
});

describe("rib contract backward-compatibility", () => {
  it("accepts a minimal rib with no v2 hooks", () => {
    const rib: Rib = { id: "legacy", displayName: "Legacy Rib" };
    expect(rib.views).toBeUndefined();
    expect(rib.onAction).toBeUndefined();
  });

  it("accepts a context with no credential accessor", () => {
    const ctx: RibContext = {
      getExec: () => ({
        runJSON: async <T>() => ({ ok: true as const, data: undefined as T }),
        runText: async () => ({ ok: true as const, data: "" }),
      }),
    };
    expect(ctx.getCredential).toBeUndefined();
  });
});
