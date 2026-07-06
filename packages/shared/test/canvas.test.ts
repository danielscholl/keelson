import { describe, expect, it } from "bun:test";
import {
  CANVAS_HTML_ACTION_CHANNEL,
  canvasDocumentSchema,
  canvasHtmlActionSchema,
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

  it("parses cells carrying badges (value + grade chips, and badge-only)", () => {
    const v = canvasViewSchema.parse({
      view: "table",
      columns: [{ key: "service" }, { key: "quality" }, { key: "fail" }],
      rows: [
        {
          service: "storage",
          // coverage % beside R/S/M grade chips
          quality: {
            value: "85%",
            tone: "ok",
            badges: [
              { text: "A", tone: "ok" },
              { text: "C", tone: "warn" },
            ],
          },
          // a filled count chip with no leading value
          fail: { badges: [{ text: "34", tone: "error" }] },
        },
      ],
    });
    expect(v.view).toBe("table");
  });

  it("rejects an empty wrapped cell and a badge missing text / with extra key (strict)", () => {
    expect(() =>
      canvasViewSchema.parse({
        view: "table",
        columns: [{ key: "a" }],
        rows: [{ a: {} }],
      }),
    ).toThrow();
    expect(() =>
      canvasViewSchema.parse({
        view: "table",
        columns: [{ key: "a" }],
        rows: [{ a: { badges: [{ text: "X", weight: 1 }] } }],
      }),
    ).toThrow();
    expect(() =>
      canvasViewSchema.parse({
        view: "table",
        columns: [{ key: "a" }],
        rows: [{ a: { badges: [{ tone: "ok" }] } }],
      }),
    ).toThrow();
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
              icon: "⎈",
              chip: { label: "CLUSTER", tone: "info" },
              text: "job started",
              href: "https://x.test",
              trailing: "21m",
            },
            { glyph: "ok", text: "Services", trailing: "29/29 ready" },
            {
              glyph: "info",
              text: "review passed",
              detail: "Full synthesis:\nboth reviewers agreed.",
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

  it("rejects a rows item with an empty icon", () => {
    expect(() =>
      canvasViewSchema.parse({
        view: "board",
        sections: [{ kind: "rows", items: [{ icon: "", text: "x" }] }],
      }),
    ).toThrow();
  });

  it("rejects a rows item detail that is empty or over the cap", () => {
    expect(() =>
      canvasViewSchema.parse({
        view: "board",
        sections: [{ kind: "rows", items: [{ text: "x", detail: "" }] }],
      }),
    ).toThrow();
    expect(() =>
      canvasViewSchema.parse({
        view: "board",
        sections: [{ kind: "rows", items: [{ text: "x", detail: "y".repeat(4001) }] }],
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

  it("parses an actions section with wrap, and rejects a non-boolean wrap", () => {
    const v = canvasViewSchema.parse({
      view: "board",
      sections: [{ kind: "actions", wrap: true, items: [{ type: "pick", label: "Pick" }] }],
    });
    expect(v.view).toBe("board");
    expect(() =>
      canvasViewSchema.parse({
        view: "board",
        sections: [{ kind: "actions", wrap: "yes", items: [{ type: "x", label: "X" }] }],
      }),
    ).toThrow();
  });

  it("parses an actions section with tabs, and rejects a non-boolean tabs", () => {
    const v = canvasViewSchema.parse({
      view: "board",
      sections: [{ kind: "actions", tabs: true, items: [{ type: "pick", label: "Pick" }] }],
    });
    expect(v.view).toBe("board");
    expect(() =>
      canvasViewSchema.parse({
        view: "board",
        sections: [{ kind: "actions", tabs: "yes", items: [{ type: "x", label: "X" }] }],
      }),
    ).toThrow();
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

  it("parses an action item with input fields, and rejects duplicate field names", () => {
    const ok = canvasViewSchema.parse({
      view: "board",
      sections: [
        {
          kind: "actions",
          items: [
            {
              type: "room-start",
              label: "Start room",
              fields: [{ name: "topic", label: "Topic", multiline: true }],
            },
          ],
        },
      ],
    });
    expect(ok.view).toBe("board");
    // Duplicate field names collide in the UI's keyed form state — reject them.
    expect(() =>
      canvasViewSchema.parse({
        view: "board",
        sections: [
          {
            kind: "actions",
            items: [
              {
                type: "room-start",
                label: "Start room",
                fields: [
                  { name: "topic", label: "Topic" },
                  { name: "topic", label: "Again" },
                ],
              },
            ],
          },
        ],
      }),
    ).toThrow();
  });

  it("parses an expanded action item, and rejects a non-boolean expanded", () => {
    const ok = canvasViewSchema.parse({
      view: "board",
      sections: [
        {
          kind: "actions",
          items: [
            {
              type: "describe-own",
              label: "Author",
              tone: "brand",
              expanded: true,
              fields: [{ name: "brief", label: "Brief", multiline: true }],
            },
          ],
        },
      ],
    });
    expect(ok.view).toBe("board");
    expect(() =>
      canvasViewSchema.parse({
        view: "board",
        sections: [
          {
            kind: "actions",
            items: [{ type: "x", label: "X", expanded: "yes" }],
          },
        ],
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

  it("parses destructive action confirm metadata and enforces typed-confirm requirements", () => {
    const ok = canvasViewSchema.parse({
      view: "board",
      sections: [
        {
          kind: "actions",
          items: [
            {
              type: "retire",
              label: "Retire chamber",
              destructive: true,
              confirm: {
                irreversible: true,
                subject: "cluster-a",
                label: "Type cluster name",
                title: "Retire chamber",
                body: "This cannot be undone.",
                confirmLabel: "Retire",
                cancelLabel: "Cancel",
              },
            },
          ],
        },
      ],
    });
    expect(ok.view).toBe("board");

    expect(() =>
      canvasViewSchema.parse({
        view: "board",
        sections: [
          {
            kind: "actions",
            items: [
              {
                type: "retire",
                label: "Retire chamber",
                destructive: true,
                confirm: { irreversible: true },
              },
            ],
          },
        ],
      }),
    ).toThrow();
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

  it("parses card-attached actions and rejects unknown keys on nested actions", () => {
    const ok = canvasViewSchema.parse({
      view: "board",
      sections: [
        {
          kind: "cards",
          items: [
            {
              title: "PostgreSQL",
              actions: [{ type: "delete", label: "Delete", destructive: true }],
            },
          ],
        },
      ],
    });
    expect(ok.view).toBe("board");

    expect(() =>
      canvasViewSchema.parse({
        view: "board",
        sections: [
          {
            kind: "cards",
            items: [
              {
                title: "PostgreSQL",
                actions: [{ type: "delete", label: "Delete", confirm: { subject: "x", bogus: 1 } }],
              },
            ],
          },
        ],
      }),
    ).toThrow();
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

  it("parses a people field and a stacked card", () => {
    const v = canvasViewSchema.parse({
      view: "board",
      sections: [
        {
          kind: "cards",
          items: [
            {
              title: "architecture debate",
              stacked: true,
              fields: [
                {
                  label: "with",
                  people: [
                    { name: "Mycroft", tone: "id-amber" },
                    { name: "Jarvis", tone: "id-teal" },
                    { name: "Athena" },
                  ],
                },
                { label: "started", value: "2h ago" },
              ],
            },
          ],
        },
      ],
    });
    const cards = v.view === "board" ? v.sections[0] : undefined;
    const card = cards?.kind === "cards" ? cards.items[0] : undefined;
    expect(card?.stacked).toBe(true);
    expect(card?.fields?.[0]?.people?.length).toBe(3);
  });

  it("rejects a field carrying both value and people, or neither", () => {
    const board = (field: Record<string, unknown>) => ({
      view: "board",
      sections: [{ kind: "cards", items: [{ title: "x", fields: [field] }] }],
    });
    expect(() =>
      canvasViewSchema.parse(board({ value: "v", people: [{ name: "Mycroft" }] })),
    ).toThrow();
    expect(() => canvasViewSchema.parse(board({ label: "with" }))).toThrow();
  });

  it("rejects value-affordances and empty/nameless entries on a people field", () => {
    const board = (field: Record<string, unknown>) => ({
      view: "board",
      sections: [{ kind: "cards", items: [{ title: "x", fields: [field] }] }],
    });
    for (const bad of [
      { people: [{ name: "Mycroft" }], tone: "ok" },
      { people: [{ name: "Mycroft" }], href: "https://x.test" },
      { people: [{ name: "Mycroft" }], copyable: true },
      { people: [{ name: "Mycroft" }], copyAction: { type: "reveal" } },
      { people: [] },
      { people: [{ name: "" }] },
      { people: [{ tone: "id-blue" }] },
    ]) {
      expect(() => canvasViewSchema.parse(board(bad))).toThrow();
    }
  });

  it("parses the accent tone everywhere a tone is accepted", () => {
    const v = canvasViewSchema.parse({
      view: "board",
      header: { status: { label: "ok", tone: "accent" } },
      sections: [
        { kind: "segments", items: [{ label: "x", n: 1, tone: "accent" }] },
        {
          kind: "cards",
          items: [{ title: "id", titleTone: "accent", pill: { label: "svc", tone: "accent" } }],
        },
      ],
    });
    expect(v.view).toBe("board");
  });

  it("parses every reserved identity tone across board tone sites", () => {
    for (const tone of ["id-blue", "id-amber", "id-teal", "id-rose", "id-olive"]) {
      const v = canvasViewSchema.parse({
        view: "board",
        header: { status: { label: "ok", tone } },
        sections: [
          { kind: "segments", items: [{ label: "x", n: 1, tone }] },
          {
            kind: "cards",
            items: [{ title: "member", titleTone: tone, dot: tone, pill: { label: "role", tone } }],
          },
          { kind: "rows", items: [{ text: "turn", glyph: tone, chip: { label: "edie", tone } }] },
          { kind: "grid", cells: [{ label: "R1", badge: { text: "edie", tone } }] },
        ],
      });
      expect(v.view).toBe("board");
    }
  });

  it("parses a card with a toned monospace title and a labelled reason line", () => {
    const v = canvasViewSchema.parse({
      view: "board",
      sections: [
        {
          kind: "cards",
          items: [
            {
              title: "CVE-2024-1234",
              titleTone: "error",
              mono: true,
              pill: { label: "wellbore-ddms", tone: "info" },
              reason: { label: "why flagged:", text: "stale-61d, unowned" },
            },
          ],
        },
      ],
    });
    const cards = v.view === "board" ? v.sections[0] : undefined;
    expect(cards?.kind === "cards" && cards.items[0]?.mono).toBe(true);
    expect(cards?.kind === "cards" && cards.items[0]?.reason?.label).toBe("why flagged:");
  });

  it("rejects an unknown key on a card reason and an empty reason text (strict)", () => {
    expect(() =>
      canvasViewSchema.parse({
        view: "board",
        sections: [{ kind: "cards", items: [{ title: "x", reason: { text: "y", bogus: true } }] }],
      }),
    ).toThrow();
    expect(() =>
      canvasViewSchema.parse({
        view: "board",
        sections: [{ kind: "cards", items: [{ title: "x", reason: { text: "" } }] }],
      }),
    ).toThrow();
  });

  it("parses a grid section with toned badges, incl. inside a column", () => {
    const v = canvasViewSchema.parse({
      view: "board",
      sections: [
        {
          kind: "grid",
          title: "SAST",
          cells: [
            { label: "partition", href: "https://sonar.test", badge: { text: "A", tone: "ok" } },
            { label: "legal", badge: { text: "—", tone: "neutral" } },
          ],
        },
        {
          kind: "columns",
          columns: [
            { sections: [{ kind: "grid", cells: [{ label: "s", badge: { text: "E" } }] }] },
          ],
        },
      ],
    });
    expect(v.view).toBe("board");
  });

  it("rejects a grid cell missing a badge or carrying an extra key (strict)", () => {
    expect(() =>
      canvasViewSchema.parse({
        view: "board",
        sections: [{ kind: "grid", cells: [{ label: "s" }] }],
      }),
    ).toThrow();
    expect(() =>
      canvasViewSchema.parse({
        view: "board",
        sections: [{ kind: "grid", cells: [{ label: "s", badge: { text: "A" }, bogus: true }] }],
      }),
    ).toThrow();
  });

  it("parses an inline bars section", () => {
    const v = canvasViewSchema.parse({
      view: "board",
      sections: [
        {
          kind: "bars",
          inline: true,
          items: [{ label: "svc", value: 3, total: 9, tone: "error", trailing: "2 crit · 1 high" }],
        },
      ],
    });
    const bars = v.view === "board" ? v.sections[0] : undefined;
    expect(bars?.kind === "bars" && bars.inline).toBe(true);
  });
});

describe("getRunArtifactResponseSchema", () => {
  it("round-trips a path + content pair", () => {
    const res = getRunArtifactResponseSchema.parse({ path: "plan.md", content: "# Plan\n" });
    expect(res).toEqual({ path: "plan.md", content: "# Plan\n" });
  });
});

describe("canvasHtmlActionSchema", () => {
  it("accepts a well-formed action with a payload", () => {
    const action = canvasHtmlActionSchema.parse({
      channel: CANVAS_HTML_ACTION_CHANNEL,
      type: "suspend-cluster",
      payload: { cluster: "demo" },
    });
    expect(action.type).toBe("suspend-cluster");
    expect(action.payload).toEqual({ cluster: "demo" });
  });

  it("accepts an action without a payload", () => {
    expect(
      canvasHtmlActionSchema.safeParse({ channel: CANVAS_HTML_ACTION_CHANNEL, type: "ping" })
        .success,
    ).toBe(true);
  });

  it("rejects a foreign channel so stray postMessage traffic is ignored", () => {
    expect(
      canvasHtmlActionSchema.safeParse({ channel: "some-other-channel", type: "ping" }).success,
    ).toBe(false);
  });

  it("rejects an empty or missing type", () => {
    expect(
      canvasHtmlActionSchema.safeParse({ channel: CANVAS_HTML_ACTION_CHANNEL, type: "" }).success,
    ).toBe(false);
    expect(canvasHtmlActionSchema.safeParse({ channel: CANVAS_HTML_ACTION_CHANNEL }).success).toBe(
      false,
    );
  });

  it("rejects an unknown key — the frame cannot smuggle a target rib id", () => {
    expect(
      canvasHtmlActionSchema.safeParse({
        channel: CANVAS_HTML_ACTION_CHANNEL,
        type: "ping",
        ribId: "other-rib",
      }).success,
    ).toBe(false);
  });
});
