import { describe, expect, it } from "bun:test";
import type { Rib, RibContext } from "../src/rib.ts";
import {
  listRibsResponseSchema,
  ribActionResponseSchema,
  ribActionSchema,
  ribAuthStatusSchema,
  ribIdFromKey,
  ribSurfaceDescriptorSchema,
  ribViewDescriptorSchema,
} from "../src/rib.ts";

describe("ribIdFromKey", () => {
  it("extracts the rib id from a namespaced key", () => {
    expect(ribIdFromKey("rib:demo")).toBe("demo");
    expect(ribIdFromKey("rib:demo:quality")).toBe("demo");
    expect(ribIdFromKey("rib:demo:a:b")).toBe("demo");
    expect(ribIdFromKey("rib:my-rib:x")).toBe("my-rib");
  });

  it("returns null for a key outside any rib namespace", () => {
    expect(ribIdFromKey("notarib:x")).toBeNull();
    expect(ribIdFromKey("rib:")).toBeNull();
    expect(ribIdFromKey("rib:Bad-CAPS")).toBeNull();
    expect(ribIdFromKey("")).toBeNull();
  });
});

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
          surfaces: [],
          hasOnAction: true,
          auth: { authenticated: true },
        },
      ],
    });
    expect(res.ribs[0]?.id).toBe("osdu");
  });
});

describe("rib surface descriptor schema", () => {
  it("round-trips a surface with a collapsible header and a row of columns", () => {
    const s = ribSurfaceDescriptorSchema.parse({
      id: "cimpl",
      title: "CIMPL",
      layout: {
        header: { key: "rib:osdu:topology", collapsible: true, collapsed: true },
        rows: [{ columns: [{ key: "rib:osdu:quality" }, { key: "rib:osdu:security" }] }],
      },
    });
    expect(s.title).toBe("CIMPL");
    expect(s.layout.header?.collapsed).toBe(true);
    expect(s.layout.rows[0]?.columns).toHaveLength(2);
  });

  it("allows an empty rows array (no lanes declared yet)", () => {
    expect(
      ribSurfaceDescriptorSchema.safeParse({ id: "x", title: "X", layout: { rows: [] } }).success,
    ).toBe(true);
  });

  it("carries an optional refresh workflow on header and column regions", () => {
    const s = ribSurfaceDescriptorSchema.parse({
      id: "cimpl",
      title: "CIMPL",
      layout: {
        header: { key: "rib:osdu:cluster", collapsible: true, workflow: "osdu-cluster" },
        rows: [{ columns: [{ key: "rib:osdu:quality", workflow: "osdu-quality" }] }],
      },
    });
    expect(s.layout.header?.workflow).toBe("osdu-cluster");
    expect(s.layout.rows[0]?.columns[0]?.workflow).toBe("osdu-quality");
  });

  it("carries an optional cadenceMs on header, banner, and column regions", () => {
    const s = ribSurfaceDescriptorSchema.parse({
      id: "cimpl",
      title: "CIMPL",
      layout: {
        header: { key: "rib:osdu:cluster", workflow: "osdu-cluster", cadenceMs: 600_000 },
        banner: { key: "rib:osdu:release", workflow: "osdu-release", cadenceMs: 1_800_000 },
        rows: [
          {
            columns: [{ key: "rib:osdu:quality", workflow: "osdu-quality", cadenceMs: 7_200_000 }],
          },
        ],
      },
    });
    expect(s.layout.header?.cadenceMs).toBe(600_000);
    expect(s.layout.banner?.cadenceMs).toBe(1_800_000);
    expect(s.layout.rows[0]?.columns[0]?.cadenceMs).toBe(7_200_000);
  });

  it("rejects a cadenceMs below the 30s floor or non-integer", () => {
    expect(
      ribSurfaceDescriptorSchema.safeParse({
        id: "x",
        title: "X",
        layout: { banner: { key: "rib:osdu:release", cadenceMs: 29_999 }, rows: [] },
      }).success,
    ).toBe(false);
    expect(
      ribSurfaceDescriptorSchema.safeParse({
        id: "x",
        title: "X",
        layout: { banner: { key: "rib:osdu:release", cadenceMs: 60_000.5 }, rows: [] },
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown field, an empty region key, and a column-less row", () => {
    expect(
      ribSurfaceDescriptorSchema.safeParse({ id: "x", title: "X", layout: { rows: [] }, extra: 1 })
        .success,
    ).toBe(false);
    expect(
      ribSurfaceDescriptorSchema.safeParse({
        id: "x",
        title: "X",
        layout: { banner: { key: "" }, rows: [] },
      }).success,
    ).toBe(false);
    expect(
      ribSurfaceDescriptorSchema.safeParse({
        id: "x",
        title: "X",
        layout: { rows: [{ columns: [] }] },
      }).success,
    ).toBe(false);
  });

  it("rejects collapse flags on a banner region (only header/footer collapse)", () => {
    expect(
      ribSurfaceDescriptorSchema.safeParse({
        id: "x",
        title: "X",
        layout: { banner: { key: "rib:osdu:queue", collapsible: true }, rows: [] },
      }).success,
    ).toBe(false);
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
    // The agent-turn seam is optional too — a minimal context omits it (rooms fail closed).
    expect(ctx.runAgentTurn).toBeUndefined();
  });

  it("accepts a context with the C1 agent-turn seam and exposes the dual-handle", async () => {
    const ctx: RibContext = {
      getExec: () => ({
        runJSON: async <T>() => ({ ok: true as const, data: undefined as T }),
        runText: async () => ({ ok: true as const, data: "" }),
      }),
      runAgentTurn: (req) => ({
        result: Promise.resolve({ status: "ok" as const, text: `echo:${req.prompt}` }),
        stream: (async function* () {
          yield { type: "text" as const, content: "echo" };
          yield { type: "done" as const };
        })(),
      }),
    };
    const turn = ctx.runAgentTurn?.({ prompt: "hi" });
    expect((await turn?.result)?.text).toBe("echo:hi");
    const kinds: string[] = [];
    for await (const c of turn?.stream ?? []) kinds.push(c.type);
    expect(kinds).toEqual(["text", "done"]);
  });
});
