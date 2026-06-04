import { describe, expect, it } from "bun:test";
import {
  canvasDocumentSchema,
  canvasKindSchema,
  canvasViewSchema,
  getRunArtifactResponseSchema,
} from "../src/canvas.ts";

describe("canvasDocumentSchema", () => {
  it("round-trips an inline markdown document", () => {
    const doc = canvasDocumentSchema.parse({
      kind: "markdown",
      source: { type: "inline", text: "# Plan" },
      title: "plan-ready",
    });
    expect(doc.kind).toBe("markdown");
    expect(doc.source).toEqual({ type: "inline", text: "# Plan" });
    expect(doc.title).toBe("plan-ready");
  });

  it("round-trips an artifact document without a title", () => {
    const doc = canvasDocumentSchema.parse({
      kind: "markdown",
      source: { type: "artifact", runId: "r1", path: "plan.md" },
    });
    expect(doc.source).toEqual({ type: "artifact", runId: "r1", path: "plan.md" });
    expect(doc.title).toBeUndefined();
  });

  it("accepts the reserved view/html kinds and a snapshot source", () => {
    expect(canvasKindSchema.parse("view")).toBe("view");
    expect(canvasKindSchema.parse("html")).toBe("html");
    const doc = canvasDocumentSchema.parse({
      kind: "view",
      source: { type: "snapshot", key: "osdu.record" },
    });
    expect(doc.source).toEqual({ type: "snapshot", key: "osdu.record" });
  });

  it("rejects an unknown kind", () => {
    expect(() => canvasKindSchema.parse("pdf")).toThrow();
  });

  it("rejects an inline source missing text", () => {
    expect(() =>
      canvasDocumentSchema.parse({ kind: "markdown", source: { type: "inline" } }),
    ).toThrow();
  });

  it("rejects an artifact source missing runId or path", () => {
    expect(() =>
      canvasDocumentSchema.parse({
        kind: "markdown",
        source: { type: "artifact", path: "plan.md" },
      }),
    ).toThrow();
    expect(() =>
      canvasDocumentSchema.parse({ kind: "markdown", source: { type: "artifact", runId: "r1" } }),
    ).toThrow();
  });

  it("rejects unknown keys (strict)", () => {
    expect(() =>
      canvasDocumentSchema.parse({
        kind: "markdown",
        source: { type: "inline", text: "x" },
        foo: "bar",
      }),
    ).toThrow();
  });
});

describe("canvasViewSchema", () => {
  it("parses a table view", () => {
    const v = canvasViewSchema.parse({
      view: "table",
      columns: [{ key: "name", label: "Name" }, { key: "status" }],
      rows: [
        { name: "alpha", status: "ok" },
        { name: "beta", status: null },
      ],
      caption: "records",
    });
    expect(v.view).toBe("table");
  });

  it("parses a table view with toned cells", () => {
    const v = canvasViewSchema.parse({
      view: "table",
      columns: [{ key: "name" }, { key: "gate" }],
      rows: [
        { name: "alpha", gate: { value: "OK", tone: "ok" } },
        { name: "beta", gate: { value: "ERROR", tone: "error" } },
        { name: "gamma", gate: { value: null } },
      ],
    });
    expect(v.view).toBe("table");
  });

  it("rejects a cell with an unknown tone or an extra key (strict)", () => {
    expect(() =>
      canvasViewSchema.parse({
        view: "table",
        columns: [{ key: "a" }],
        rows: [{ a: { value: 1, tone: "danger" } }],
      }),
    ).toThrow();
    expect(() =>
      canvasViewSchema.parse({
        view: "table",
        columns: [{ key: "a" }],
        rows: [{ a: { value: 1, extra: true } }],
      }),
    ).toThrow();
  });

  it("parses a graph view", () => {
    const v = canvasViewSchema.parse({
      view: "graph",
      nodes: [{ id: "a", label: "A", kind: "service" }, { id: "b" }],
      edges: [{ source: "a", target: "b", label: "calls" }],
    });
    expect(v.view).toBe("graph");
  });

  it("rejects an unknown view discriminant", () => {
    expect(() => canvasViewSchema.parse({ view: "pie", slices: [] })).toThrow();
  });

  it("rejects a graph with zero nodes and an edge missing a target", () => {
    expect(() => canvasViewSchema.parse({ view: "graph", nodes: [], edges: [] })).toThrow();
    expect(() =>
      canvasViewSchema.parse({ view: "graph", nodes: [{ id: "a" }], edges: [{ source: "a" }] }),
    ).toThrow();
  });

  it("rejects a table with no columns and unknown keys (strict)", () => {
    expect(() => canvasViewSchema.parse({ view: "table", columns: [], rows: [] })).toThrow();
    expect(() =>
      canvasViewSchema.parse({ view: "table", columns: [{ key: "a" }], rows: [], extra: 1 }),
    ).toThrow();
  });

  it("rejects duplicate column keys", () => {
    expect(() =>
      canvasViewSchema.parse({
        view: "table",
        columns: [{ key: "a" }, { key: "a" }],
        rows: [],
      }),
    ).toThrow(/unique/);
  });

  it("rejects duplicate node ids", () => {
    expect(() =>
      canvasViewSchema.parse({
        view: "graph",
        nodes: [{ id: "a" }, { id: "a" }],
        edges: [],
      }),
    ).toThrow(/unique/);
  });

  it("parses a board view with a header and every section kind", () => {
    const v = canvasViewSchema.parse({
      view: "board",
      title: "Quality",
      header: { chip: "venus", segments: [{ label: "Good", n: 2, tone: "ok" }] },
      sections: [
        {
          kind: "stats",
          title: "KPIs",
          items: [{ label: "Services", value: 23, sub: "core", tone: "neutral" }],
        },
        { kind: "segments", items: [{ label: "Fail", n: 9, tone: "error" }] },
        {
          kind: "bars",
          items: [{ label: "Unit", value: 5072, total: 5083, tone: "ok", trailing: "99.8%" }],
        },
        {
          kind: "table",
          title: "Sonar",
          columns: [{ key: "svc" }, { key: "gate" }],
          rows: [{ svc: "a", gate: { value: "OK", tone: "ok" } }],
        },
        {
          kind: "cards",
          items: [
            {
              title: "Keycloak",
              pill: { label: "ACTIVE", tone: "ok" },
              href: "https://example.test",
              bar: { value: 8, total: 9 },
              fields: [
                { label: "user", value: "admin", copyable: true },
                { value: "open", href: "https://example.test", tone: "neutral" },
              ],
              footnote: "stale-61d",
            },
          ],
        },
        {
          kind: "rows",
          items: [
            {
              glyph: "ok",
              chip: { label: "CLUSTER", tone: "neutral" },
              text: "job started",
              href: "https://x.test",
              trailing: "21m",
            },
          ],
        },
        {
          kind: "actions",
          title: "Actions",
          items: [
            { type: "reconcile", label: "Reconcile" },
            { type: "delete", label: "Delete", tone: "error", destructive: true },
          ],
        },
      ],
    });
    expect(v.view).toBe("board");
  });

  it("rejects an unknown board section kind and an extra section key (strict)", () => {
    expect(() =>
      canvasViewSchema.parse({ view: "board", sections: [{ kind: "timeline", items: [] }] }),
    ).toThrow();
    expect(() =>
      canvasViewSchema.parse({
        view: "board",
        sections: [{ kind: "segments", items: [], extra: 1 }],
      }),
    ).toThrow();
  });

  it("rejects duplicate column keys inside a board table section", () => {
    expect(() =>
      canvasViewSchema.parse({
        view: "board",
        sections: [{ kind: "table", columns: [{ key: "a" }, { key: "a" }], rows: [] }],
      }),
    ).toThrow(/unique/);
  });

  it("rejects an unknown key on a card field (strict)", () => {
    expect(() =>
      canvasViewSchema.parse({
        view: "board",
        sections: [
          { kind: "cards", items: [{ title: "x", fields: [{ value: "v", bogus: true }] }] },
        ],
      }),
    ).toThrow();
  });

  it("parses an actions section with and without tone/destructive", () => {
    const v = canvasViewSchema.parse({
      view: "board",
      sections: [
        {
          kind: "actions",
          items: [
            { type: "reconcile", label: "Reconcile" },
            { type: "suspend", label: "Suspend", tone: "warn", destructive: true },
          ],
        },
      ],
    });
    expect(v.view).toBe("board");
  });

  it("rejects an action item missing type or label, and an unknown key (strict)", () => {
    expect(() =>
      canvasViewSchema.parse({
        view: "board",
        sections: [{ kind: "actions", items: [{ label: "Reconcile" }] }],
      }),
    ).toThrow();
    expect(() =>
      canvasViewSchema.parse({
        view: "board",
        sections: [{ kind: "actions", items: [{ type: "reconcile" }] }],
      }),
    ).toThrow();
    expect(() =>
      canvasViewSchema.parse({
        view: "board",
        sections: [{ kind: "actions", items: [{ type: "x", label: "X", bogus: true }] }],
      }),
    ).toThrow();
  });

  it("parses an action item with a glyph and an opaque payload", () => {
    const v = canvasViewSchema.parse({
      view: "board",
      sections: [
        {
          kind: "actions",
          items: [
            { type: "reconcile", label: "Reconcile", glyph: "↻", payload: { context: "ctx-a" } },
          ],
        },
      ],
    });
    expect(v.view).toBe("board");
  });

  it("parses a board header with a toned status pill", () => {
    const v = canvasViewSchema.parse({
      view: "board",
      header: { status: { label: "✓ Healthy", tone: "ok" }, chip: "kind-osdu" },
      sections: [],
    });
    expect(v.view).toBe("board");
  });

  it("parses a columns section nesting leaf sections", () => {
    const v = canvasViewSchema.parse({
      view: "board",
      sections: [
        {
          kind: "columns",
          columns: [
            {
              weight: 1.4,
              sections: [{ kind: "rows", title: "Lifecycle", items: [{ text: "ready" }] }],
            },
            {
              weight: 1,
              sections: [
                { kind: "actions", title: "Actions", items: [{ type: "reconcile", label: "Go" }] },
              ],
            },
          ],
        },
      ],
    });
    expect(v.view).toBe("board");
  });

  it("rejects a columns section nesting another columns (one level deep)", () => {
    expect(() =>
      canvasViewSchema.parse({
        view: "board",
        sections: [
          {
            kind: "columns",
            columns: [{ sections: [{ kind: "columns", columns: [{ sections: [] }] }] }],
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects duplicate column keys inside a nested table section", () => {
    expect(() =>
      canvasViewSchema.parse({
        view: "board",
        sections: [
          {
            kind: "columns",
            columns: [
              {
                sections: [{ kind: "table", columns: [{ key: "a" }, { key: "a" }], rows: [] }],
              },
            ],
          },
        ],
      }),
    ).toThrow(/unique/);
  });

  it("parses a card with a status dot and a copy-on-reveal credential field", () => {
    const v = canvasViewSchema.parse({
      view: "board",
      sections: [
        {
          kind: "cards",
          items: [
            {
              title: "PostgreSQL",
              dot: "neutral",
              fields: [
                {
                  label: "admin",
                  value: "postgres",
                  copyAction: { type: "reveal-credential", payload: { service: "postgresql" } },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(v.view).toBe("board");
  });

  it("parses boxed rows and boxed cards sections", () => {
    const v = canvasViewSchema.parse({
      view: "board",
      sections: [
        { kind: "rows", boxed: true, items: [{ text: "Context", glyph: "ok", trailing: "kind" }] },
        { kind: "cards", boxed: true, items: [{ title: "Airflow", dot: "ok" }] },
      ],
    });
    const [rows, cards] = v.view === "board" ? v.sections : [];
    expect(rows?.kind === "rows" && rows.boxed).toBe(true);
    expect(cards?.kind === "cards" && cards.boxed).toBe(true);
  });

  it("rejects an unknown key on a copyAction (strict)", () => {
    expect(() =>
      canvasViewSchema.parse({
        view: "board",
        sections: [
          {
            kind: "cards",
            items: [
              { title: "x", fields: [{ value: "v", copyAction: { type: "r", bogus: true } }] },
            ],
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects a field that sets both copyable and copyAction", () => {
    expect(() =>
      canvasViewSchema.parse({
        view: "board",
        sections: [
          {
            kind: "cards",
            items: [
              {
                title: "x",
                fields: [{ value: "v", copyable: true, copyAction: { type: "reveal" } }],
              },
            ],
          },
        ],
      }),
    ).toThrow();
  });
});

describe("getRunArtifactResponseSchema", () => {
  it("round-trips a path + content pair", () => {
    const res = getRunArtifactResponseSchema.parse({ path: "plan.md", content: "# Plan\n" });
    expect(res).toEqual({ path: "plan.md", content: "# Plan\n" });
  });
});
