import { describe, expect, it } from "bun:test";
import type { Rib, RibContext } from "../src/rib.ts";
import {
  listRibsResponseSchema,
  openChatSeedSchema,
  ribActionResponseSchema,
  ribActionSchema,
  ribAuthStatusSchema,
  ribClientEffectSchema,
  ribIdFromKey,
  ribIngestPayloadSchema,
  ribSummarySchema,
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

  it("carries a host-stamped origin and defaults it absent", () => {
    expect(ribActionSchema.parse({ type: "retire" }).origin).toBeUndefined();
    expect(ribActionSchema.parse({ type: "lens-html", origin: "canvas-html" }).origin).toBe(
      "canvas-html",
    );
    // The enum is closed: a frame can't smuggle an unknown origin past the schema.
    expect(ribActionSchema.safeParse({ type: "x", origin: "evil" }).success).toBe(false);
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
          acceptsIngest: true,
          auth: { authenticated: true },
        },
      ],
    });
    expect(res.ribs[0]?.id).toBe("osdu");
    expect(res.ribs[0]?.acceptsIngest).toBe(true);
  });

  it("keeps acceptsIngest optional on the public summary wire schema", () => {
    const summary = ribSummarySchema.parse({
      id: "legacy",
      displayName: "Legacy Rib",
      registered: [],
      views: [],
      surfaces: [],
      hasOnAction: false,
    });
    expect(summary.acceptsIngest ?? false).toBe(false);
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

  it("carries an optional live flag on header, banner, and column regions", () => {
    const s = ribSurfaceDescriptorSchema.parse({
      id: "squad",
      title: "Squad",
      layout: {
        header: { key: "rib:squad:cluster", live: true },
        // banner uses bannerRegionSchema (an .omit of the base) — live must survive it.
        banner: { key: "rib:squad:release", live: true },
        rows: [{ columns: [{ key: "rib:squad:run", workflow: "squad-run", live: true }] }],
      },
    });
    expect(s.layout.header?.live).toBe(true);
    expect(s.layout.banner?.live).toBe(true);
    expect(s.layout.rows[0]?.columns[0]?.live).toBe(true);
  });

  it("defaults live to undefined when omitted", () => {
    const s = ribSurfaceDescriptorSchema.parse({
      id: "squad",
      title: "Squad",
      layout: { rows: [{ columns: [{ key: "rib:squad:run" }] }] },
    });
    expect(s.layout.rows[0]?.columns[0]?.live).toBeUndefined();
  });

  it("carries an optional hideWhenEmpty flag on regions", () => {
    const s = ribSurfaceDescriptorSchema.parse({
      id: "squad",
      title: "Squad",
      layout: {
        header: { key: "rib:squad:cluster", hideWhenEmpty: true },
        banner: { key: "rib:squad:release", hideWhenEmpty: true },
        rows: [{ columns: [{ key: "rib:squad:run", hideWhenEmpty: true }] }],
      },
    });
    expect(s.layout.header?.hideWhenEmpty).toBe(true);
    expect(s.layout.banner?.hideWhenEmpty).toBe(true);
    expect(s.layout.rows[0]?.columns[0]?.hideWhenEmpty).toBe(true);

    const withoutFlag = ribSurfaceDescriptorSchema.parse({
      id: "demo",
      title: "Demo",
      layout: { rows: [{ columns: [{ key: "rib:demo:run" }] }] },
    });
    expect(withoutFlag.layout.rows[0]?.columns[0]?.hideWhenEmpty).toBeUndefined();
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
        layout: { rows: [{ columns: [{ key: "rib:x:a", extra: true }] }] },
      }).success,
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

  it("round-trips an optional surface subtitle", () => {
    const s = ribSurfaceDescriptorSchema.parse({
      id: "chamber",
      title: "Chamber",
      subtitle: "3 rooms · 2 lenses",
      layout: { rows: [] },
    });
    expect(s.subtitle).toBe("3 rooms · 2 lenses");
  });

  it("round-trips collapse flags + a byline on a row-column region", () => {
    const s = ribSurfaceDescriptorSchema.parse({
      id: "chamber",
      title: "Chamber",
      layout: {
        rows: [
          {
            columns: [
              {
                key: "rib:chamber:room-1",
                title: "Room 1",
                byline: "scope: navigation",
                collapsible: true,
                collapsed: true,
              },
            ],
          },
        ],
      },
    });
    const col = s.layout.rows[0]?.columns[0];
    expect(col?.collapsible).toBe(true);
    expect(col?.collapsed).toBe(true);
    expect(col?.byline).toBe("scope: navigation");
  });

  it("round-trips a region groupTitle and a row zoneTitle", () => {
    const s = ribSurfaceDescriptorSchema.parse({
      id: "chamber",
      title: "Chamber",
      layout: {
        rows: [
          {
            zoneTitle: "Rooms",
            columns: [{ key: "rib:chamber:room-1", group: "rooms", groupTitle: "Rooms" }],
          },
        ],
      },
    });
    expect(s.layout.rows[0]?.zoneTitle).toBe("Rooms");
    expect(s.layout.rows[0]?.columns[0]?.groupTitle).toBe("Rooms");
  });

  it("parses a surface and region that set none of the new optional fields", () => {
    const s = ribSurfaceDescriptorSchema.parse({
      id: "cimpl",
      title: "CIMPL",
      layout: { rows: [{ columns: [{ key: "rib:demo:quality" }] }] },
    });
    expect(s.subtitle).toBeUndefined();
    const col = s.layout.rows[0]?.columns[0];
    expect(col?.byline).toBeUndefined();
    expect(col?.groupTitle).toBeUndefined();
    expect(col?.collapsible).toBeUndefined();
    expect(s.layout.rows[0]?.zoneTitle).toBeUndefined();
  });

  it("rejects an over-long byline, subtitle, and groupTitle", () => {
    expect(
      ribSurfaceDescriptorSchema.safeParse({
        id: "x",
        title: "X",
        subtitle: "x".repeat(201),
        layout: { rows: [] },
      }).success,
    ).toBe(false);
    expect(
      ribSurfaceDescriptorSchema.safeParse({
        id: "x",
        title: "X",
        layout: { rows: [{ columns: [{ key: "rib:x:a", byline: "x".repeat(201) }] }] },
      }).success,
    ).toBe(false);
    expect(
      ribSurfaceDescriptorSchema.safeParse({
        id: "x",
        title: "X",
        layout: { rows: [{ columns: [{ key: "rib:x:a", groupTitle: "x".repeat(121) }] }] },
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
    // refreshWorkflow is optional — a rib on an older harness degrades to cadence-only.
    expect(ctx.refreshWorkflow).toBeUndefined();
  });

  it("accepts a context with the refreshWorkflow seam and resolves it", async () => {
    let seen = "";
    const ctx: RibContext = {
      getExec: () => ({
        runJSON: async <T>() => ({ ok: true as const, data: undefined as T }),
        runText: async () => ({ ok: true as const, data: "" }),
      }),
      refreshWorkflow: async (workflowName) => {
        seen = workflowName;
      },
    };
    await expect(ctx.refreshWorkflow?.("chamber-roster")).resolves.toBeUndefined();
    expect(seen).toBe("chamber-roster");
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

describe("rib client effect schema", () => {
  it("round-trips a valid open-chat effect with a full seed", () => {
    const effect = {
      effect: "open-chat" as const,
      seed: {
        systemPrompt: "You are a helpful assistant.",
        name: "Helper",
        openingPrompt: "Hi",
        model: "gpt-5",
        providerId: "openai",
      },
    };
    const parsed = ribClientEffectSchema.parse(effect);
    expect(parsed).toEqual(effect);
    // The seed sub-schema still parses on its own after the union grew.
    expect(openChatSeedSchema.safeParse(effect.seed).success).toBe(true);
  });

  it("round-trips a valid run-workflow effect with workflow + args", () => {
    const effect = {
      effect: "run-workflow" as const,
      workflow: "chamber-genesis",
      args: { ARGUMENTS: "describe your own", topic: "navigation" },
    };
    expect(ribClientEffectSchema.parse(effect)).toEqual(effect);
  });

  it("parses a run-workflow effect with args omitted", () => {
    const parsed = ribClientEffectSchema.parse({
      effect: "run-workflow",
      workflow: "chamber-genesis",
    });
    expect(parsed).toEqual({ effect: "run-workflow", workflow: "chamber-genesis" });
  });

  it("rejects a run-workflow effect with an empty workflow string", () => {
    expect(ribClientEffectSchema.safeParse({ effect: "run-workflow", workflow: "" }).success).toBe(
      false,
    );
  });

  it("rejects a run-workflow effect with an unknown extra field", () => {
    expect(
      ribClientEffectSchema.safeParse({
        effect: "run-workflow",
        workflow: "chamber-genesis",
        extra: 1,
      }).success,
    ).toBe(false);
  });

  it("rejects a run-workflow effect whose args is not a Record<string,string>", () => {
    expect(
      ribClientEffectSchema.safeParse({ effect: "run-workflow", workflow: "g", args: "x" }).success,
    ).toBe(false);
    expect(
      ribClientEffectSchema.safeParse({ effect: "run-workflow", workflow: "g", args: { k: 1 } })
        .success,
    ).toBe(false);
  });

  it("rejects an unknown effect discriminator", () => {
    expect(
      ribClientEffectSchema.safeParse({ effect: "open-url", url: "https://x.test" }).success,
    ).toBe(false);
  });

  it("rejects a malformed open-chat seed after the union grew", () => {
    expect(
      ribClientEffectSchema.safeParse({
        effect: "open-chat",
        seed: { systemPrompt: "x".repeat(8001), name: "Too long" },
      }).success,
    ).toBe(false);
  });

  it("round-trips a valid open-canvas effect with key + title", () => {
    const effect = {
      effect: "open-canvas" as const,
      key: "rib:demo:session-7",
      title: "Session 7",
    };
    expect(ribClientEffectSchema.parse(effect)).toEqual(effect);
  });

  it("parses an open-canvas effect with title omitted", () => {
    const parsed = ribClientEffectSchema.parse({
      effect: "open-canvas",
      key: "rib:demo:session-7",
    });
    expect(parsed).toEqual({ effect: "open-canvas", key: "rib:demo:session-7" });
  });

  it("rejects an open-canvas effect with an empty key", () => {
    expect(ribClientEffectSchema.safeParse({ effect: "open-canvas", key: "" }).success).toBe(false);
  });

  it("rejects an open-canvas effect with an unknown extra field", () => {
    expect(
      ribClientEffectSchema.safeParse({ effect: "open-canvas", key: "rib:demo:x", extra: 1 })
        .success,
    ).toBe(false);
  });

  it("round-trips a valid open-surface effect with surface id and region key", () => {
    const effect = {
      effect: "open-surface" as const,
      surfaceId: "surface:chamber:rooms",
      regionKey: "rib:chamber:room-7",
    };
    expect(ribClientEffectSchema.parse(effect)).toEqual(effect);
  });

  it("parses an open-surface effect with region key omitted", () => {
    const parsed = ribClientEffectSchema.parse({
      effect: "open-surface",
      surfaceId: "surface:chamber:rooms",
    });
    expect(parsed).toEqual({ effect: "open-surface", surfaceId: "surface:chamber:rooms" });
  });

  it("rejects an open-surface effect with an empty surface id or extra field", () => {
    expect(ribClientEffectSchema.safeParse({ effect: "open-surface", surfaceId: "" }).success).toBe(
      false,
    );
    expect(
      ribClientEffectSchema.safeParse({
        effect: "open-surface",
        surfaceId: "surface:chamber:rooms",
        extra: 1,
      }).success,
    ).toBe(false);
  });

  it("still rejects an unknown discriminator after more effect arms were added", () => {
    expect(
      ribClientEffectSchema.safeParse({ effect: "open-url", url: "https://x.test" }).success,
    ).toBe(false);
  });

  it("still parses existing effects after more effect arms were added", () => {
    expect(
      ribClientEffectSchema.safeParse({
        effect: "open-chat",
        seed: { systemPrompt: "Be helpful.", name: "Helper" },
      }).success,
    ).toBe(true);
    expect(
      ribClientEffectSchema.safeParse({ effect: "run-workflow", workflow: "chamber-genesis" })
        .success,
    ).toBe(true);
  });
});

describe("rib ingest payload schema", () => {
  it("accepts text with an optional source conversation id", () => {
    expect(ribIngestPayloadSchema.parse({ text: "Summarize this." })).toEqual({
      text: "Summarize this.",
    });
    expect(
      ribIngestPayloadSchema.parse({ text: "Summarize this.", sourceConversationId: "conv-1" }),
    ).toEqual({ text: "Summarize this.", sourceConversationId: "conv-1" });
  });

  it("rejects empty and oversized text", () => {
    expect(ribIngestPayloadSchema.safeParse({ text: "" }).success).toBe(false);
    expect(ribIngestPayloadSchema.safeParse({ text: "x".repeat(8001) }).success).toBe(false);
  });
});
