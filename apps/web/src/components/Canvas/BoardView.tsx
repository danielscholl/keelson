import type { CanvasBoardView, CanvasTone, RibAction } from "@keelson/shared";
import { type CSSProperties, useEffect, useState } from "react";
import { isSafeLinkScheme } from "../../lib/safeLink.ts";
import { useBoardActions } from "./BoardActionContext.tsx";
import { TableView } from "./TableView.tsx";

type BoardSection = CanvasBoardView["sections"][number];
type Segment = { label: string; n: number; tone?: CanvasTone };

function scalarText(value: string | number | boolean | null): string {
  return value === null ? "—" : String(value);
}

function barPct(value: number, total: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((value / total) * 100)));
}

function copy(text: string) {
  void navigator.clipboard?.writeText(text);
}

function makeKeyer() {
  const seen = new Map<string, number>();
  return (base: string) => {
    const dup = seen.get(base) ?? 0;
    seen.set(base, dup + 1);
    return dup === 0 ? base : `${base}#${dup}`;
  };
}

function Segments({ items }: { items: Segment[] }) {
  const key = makeKeyer();
  return (
    <div className="cvb-segments">
      {items.map((s) => (
        <span key={key(JSON.stringify(s))} className="cvb-segment" data-tone={s.tone}>
          <span className="cvb-segment-n">{s.n}</span> {s.label}
        </span>
      ))}
    </div>
  );
}

// Action buttons dispatch to the owning rib via the board-action context (a
// surface region / the canvas drawer provides it, keyed off the snapshot
// namespace). With no provider in scope the buttons render disabled.
function ActionsSection({ section }: { section: Extract<BoardSection, { kind: "actions" }> }) {
  const ctx = useBoardActions();
  const [pending, setPending] = useState<string | null>(null);
  const key = makeKeyer();
  return (
    <div className="cvb-actions">
      {section.items.map((a) => (
        <button
          type="button"
          key={key(a.type)}
          className={`cvb-action-button${a.destructive ? " is-destructive" : ""}`}
          data-tone={a.tone}
          disabled={!ctx || pending === a.type}
          onClick={async () => {
            if (!ctx || pending === a.type) return;
            if (a.destructive && !window.confirm(`${a.label}?`)) return;
            setPending(a.type);
            try {
              await ctx.run({ type: a.type });
            } finally {
              setPending(null);
            }
          }}
        >
          {a.glyph && (
            <span className="cvb-action-glyph" aria-hidden="true">
              {a.glyph}
            </span>
          )}
          {a.label}
        </button>
      ))}
    </div>
  );
}

// Copy-on-reveal: dispatches the field's `copyAction` to the owning rib and
// writes the returned `data` to the clipboard. The secret is fetched on click
// and never held in React state — the local binding goes out of scope when the
// handler returns. A brief flash reflects success/failure before reverting.
function CopyActionButton({ action, label }: { action: RibAction; label?: string }) {
  const ctx = useBoardActions();
  const [state, setState] = useState<"idle" | "busy" | "ok" | "fail">("idle");
  useEffect(() => {
    if (state !== "ok" && state !== "fail") return;
    const timer = setTimeout(() => setState("idle"), 1200);
    return () => clearTimeout(timer);
  }, [state]);
  const onClick = async () => {
    if (!ctx || state === "busy") return;
    setState("busy");
    try {
      const result = await ctx.reveal(action);
      if (result.ok && result.data != null) {
        await navigator.clipboard?.writeText(String(result.data));
        setState("ok");
      } else {
        setState("fail");
      }
    } catch {
      setState("fail");
    }
  };
  const glyph = state === "busy" ? "…" : state === "ok" ? "✓" : state === "fail" ? "✕" : "copy";
  const flash = state === "ok" || state === "fail" ? ` flash-${state}` : "";
  return (
    <button
      type="button"
      className={`cvb-copy${flash}`}
      aria-label={`Copy ${label ?? "value"}`}
      disabled={!ctx || state === "busy"}
      onClick={onClick}
    >
      {glyph}
    </button>
  );
}

function Section({ section }: { section: BoardSection }) {
  switch (section.kind) {
    case "stats": {
      const key = makeKeyer();
      return (
        <div className="cvb-stats">
          {section.items.map((s) => (
            <div key={key(JSON.stringify(s))} className="cvb-stat">
              <span className="cvb-stat-value" data-tone={s.tone}>
                {scalarText(s.value)}
              </span>
              <span className="cvb-stat-label">{s.label}</span>
              {s.sub && <span className="cvb-stat-sub">{s.sub}</span>}
            </div>
          ))}
        </div>
      );
    }
    case "segments":
      return <Segments items={section.items} />;
    case "bars": {
      const key = makeKeyer();
      return (
        <div className="cvb-bars">
          {section.items.map((b) => (
            <div key={key(JSON.stringify(b))} className="cvb-bar">
              <div className="cvb-bar-head">
                <span className="cvb-bar-label">{b.label}</span>
                <span className="cvb-bar-trailing">
                  {b.trailing ?? `${barPct(b.value, b.total)}%`}
                </span>
              </div>
              <div className="cvb-bar-track">
                <div
                  className="cvb-bar-fill"
                  data-tone={b.tone}
                  style={{ width: `${barPct(b.value, b.total)}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      );
    }
    case "table":
      return (
        <TableView
          view={{
            view: "table",
            columns: section.columns,
            rows: section.rows,
            caption: section.caption,
          }}
        />
      );
    case "cards": {
      const key = makeKeyer();
      return (
        <div className="cvb-cards">
          {section.items.map((c) => {
            const fieldKey = makeKeyer();
            return (
              <div key={key(JSON.stringify(c))} className="cvb-card">
                <div className="cvb-card-head">
                  {c.dot && <span className="cvb-card-dot" data-tone={c.dot} />}
                  {isSafeLinkScheme(c.href) ? (
                    <a
                      className="cvb-link cvb-card-title"
                      href={c.href}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {c.title}
                    </a>
                  ) : (
                    <span className="cvb-card-title">{c.title}</span>
                  )}
                  {c.pill && (
                    <span className="cvb-pill" data-tone={c.pill.tone}>
                      {c.pill.label}
                    </span>
                  )}
                </div>
                {c.bar && (
                  <div className="cvb-bar-track cvb-card-bar">
                    <div
                      className="cvb-bar-fill"
                      style={{ width: `${barPct(c.bar.value, c.bar.total)}%` }}
                    />
                  </div>
                )}
                {c.fields && c.fields.length > 0 && (
                  <div className="cvb-card-fields">
                    {c.fields.map((f) => (
                      <span key={fieldKey(JSON.stringify(f))} className="cvb-field">
                        {f.label && <span className="cvb-field-label">{f.label}</span>}
                        {isSafeLinkScheme(f.href) ? (
                          <a
                            className="cvb-link"
                            href={f.href}
                            target="_blank"
                            rel="noopener noreferrer"
                            data-tone={f.tone}
                          >
                            {scalarText(f.value)}
                          </a>
                        ) : (
                          <span className="cvb-field-value" data-tone={f.tone}>
                            {scalarText(f.value)}
                          </span>
                        )}
                        {f.copyAction && (
                          <CopyActionButton
                            action={{ type: f.copyAction.type, payload: f.copyAction.payload }}
                            label={f.label}
                          />
                        )}
                        {f.copyable && f.value !== null && (
                          <button
                            type="button"
                            className="cvb-copy"
                            aria-label={`Copy ${f.label ?? "value"}`}
                            onClick={() => copy(String(f.value))}
                          >
                            copy
                          </button>
                        )}
                      </span>
                    ))}
                  </div>
                )}
                {c.footnote && <div className="cvb-card-footnote">{c.footnote}</div>}
              </div>
            );
          })}
        </div>
      );
    }
    case "rows": {
      const key = makeKeyer();
      return (
        <div className="cvb-rows">
          {section.items.map((r) => (
            <div key={key(JSON.stringify(r))} className="cvb-row">
              {r.glyph && <span className="cvb-glyph" data-tone={r.glyph} />}
              {r.chip && (
                <span className="cvb-chip" data-tone={r.chip.tone}>
                  {r.chip.label}
                </span>
              )}
              {isSafeLinkScheme(r.href) ? (
                <a
                  className="cvb-link cvb-row-text"
                  href={r.href}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {r.text}
                </a>
              ) : (
                <span className="cvb-row-text">{r.text}</span>
              )}
              {r.trailing && <span className="cvb-row-trailing">{r.trailing}</span>}
            </div>
          ))}
        </div>
      );
    }
    case "actions":
      return <ActionsSection section={section} />;
    case "columns": {
      const colKey = makeKeyer();
      const template = section.columns.map((c) => `minmax(0, ${c.weight ?? 1}fr)`).join(" ");
      return (
        <div className="cvb-columns" style={{ "--cvb-cols": template } as CSSProperties}>
          {section.columns.map((col) => {
            const sectionKey = makeKeyer();
            return (
              <div key={colKey(JSON.stringify(col))} className="cvb-column">
                {col.sections.map((s) => (
                  <SectionBlock key={sectionKey(JSON.stringify(s))} section={s} />
                ))}
              </div>
            );
          })}
        </div>
      );
    }
    default: {
      const exhaustive: never = section;
      return exhaustive;
    }
  }
}

// A section's title strip + body. Shared by the board's top level and by the
// columns layout so a nested leaf section renders identically to a top-level one.
function SectionBlock({ section }: { section: BoardSection }) {
  return (
    <section className="cvb-section">
      {section.title && <div className="cvb-section-title">{section.title}</div>}
      <Section section={section} />
    </section>
  );
}

// The board's header strip (status pill + chip + title + segments). Rendered
// inline at the top of a full board, and standalone as the collapsed form of a
// surface region.
export function BoardHeader({ view }: { view: Pick<CanvasBoardView, "title" | "header"> }) {
  if (!view.title && !view.header) return null;
  return (
    <div className="cvb-header">
      {view.header?.status && (
        <span className="cvb-header-status" data-tone={view.header.status.tone}>
          {view.header.status.label}
        </span>
      )}
      {view.header?.chip && <span className="cvb-chip cvb-header-chip">{view.header.chip}</span>}
      {view.title && <span className="cvb-title">{view.title}</span>}
      {view.header?.segments && view.header.segments.length > 0 && (
        <Segments items={view.header.segments} />
      )}
    </div>
  );
}

export function BoardView({ view }: { view: CanvasBoardView }) {
  const key = makeKeyer();
  return (
    <div className="canvas-view-board">
      <BoardHeader view={view} />
      {view.sections.map((section) => (
        <SectionBlock key={key(JSON.stringify(section))} section={section} />
      ))}
    </div>
  );
}
