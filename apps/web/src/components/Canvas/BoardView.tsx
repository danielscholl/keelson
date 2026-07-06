import type { CanvasBoardView, CanvasTone, RibAction } from "@keelson/shared";
import {
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { isSafeLinkScheme } from "../../lib/safeLink.ts";
import { ConfirmModal, type ConfirmModalMode } from "../ConfirmModal.tsx";
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

// A "pulse" strip: a glowing toned bullet + muted `{n} {label}`, segments joined
// by `·` (via CSS). Zero-count segments are dropped so the strip collapses to
// just what's live; an all-zero strip renders nothing.
export function Segments({ items }: { items: Segment[] }) {
  const key = makeKeyer();
  const visible = items.filter((s) => s.n > 0);
  if (visible.length === 0) return null;
  return (
    <div className="cvb-segments">
      {visible.map((s) => (
        <span key={key(JSON.stringify(s))} className="cvb-segment">
          <span className="cvb-segment-bullet" data-tone={s.tone ?? "neutral"} aria-hidden="true" />
          <span className="cvb-segment-text">
            {s.n} {s.label}
          </span>
        </span>
      ))}
    </div>
  );
}

type ActionItem = Extract<BoardSection, { kind: "actions" }>["items"][number];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Collected field values merge over a static object payload (so the rib reads a
// typed-in `topic` the same way it reads any other payload key); a non-object
// static payload is dropped when fields are present rather than nested.
function mergePayload(staticPayload: unknown, collected?: Record<string, string>): unknown {
  if (!collected) return staticPayload;
  return { ...(isPlainObject(staticPayload) ? staticPayload : {}), ...collected };
}

function actionConfirmMode(item: ActionItem): ConfirmModalMode {
  if (item.confirm?.irreversible && item.confirm.subject) {
    return {
      kind: "typed",
      expectedValue: item.confirm.subject,
      label: item.confirm.label ?? `Type ${item.confirm.subject} to confirm`,
    };
  }
  return { kind: "simple" };
}

function actionConfirmTitle(item: ActionItem): string {
  return item.confirm?.title ?? item.label;
}

function actionConfirmBody(item: ActionItem): string {
  return (
    item.confirm?.body ??
    `Are you sure you want to ${item.label.charAt(0).toLowerCase()}${item.label.slice(1)}?`
  );
}

// One action button. With no `fields` it dispatches on click (confirming first
// when destructive). With `fields` it toggles an inline form and dispatches the
// collected values on submit, so a payload-carrying action can gather its input.
// A tabs section lifts the form's open state to itself via `open`/`onOpenChange`
// so opening one item closes its siblings; uncontrolled (both absent) elsewhere.
function ActionItemButton({
  item,
  open: controlledOpen,
  onOpenChange,
}: {
  item: ActionItem;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const ctx = useBoardActions();
  const fields = item.fields ?? [];
  const hasFields = fields.length > 0;
  // `expanded` (an always-open form with no disclosure button) contradicts the
  // one-open-panel model, so a controlled (tabs) item ignores it.
  const expanded = hasFields && item.expanded === true && onOpenChange === undefined;
  const [pending, setPending] = useState(false);
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = (next: boolean) => {
    if (onOpenChange) onOpenChange(next);
    else setLocalOpen(next);
  };
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmValues, setConfirmValues] = useState<Record<string, string> | undefined>(undefined);

  const dispatch = async (collected?: Record<string, string>) => {
    if (!ctx || pending) return;
    setPending(true);
    setError(null);
    try {
      const payload = mergePayload(item.payload, collected);
      const result = await ctx.run(
        payload !== undefined ? { type: item.type, payload } : { type: item.type },
      );
      if (result.ok) {
        setOpen(false);
        setValues({});
      } else {
        setError(result.error);
      }
    } finally {
      setPending(false);
    }
  };

  const requestDispatch = (collected?: Record<string, string>) => {
    if (!item.destructive) {
      void dispatch(collected);
      return;
    }
    setConfirmValues(collected);
    setConfirmOpen(true);
  };

  const onButtonClick = () => {
    if (!ctx || pending) return;
    if (hasFields) {
      setError(null);
      setOpen(!open);
      return;
    }
    requestDispatch();
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const missing = fields.find((f) => f.required && !values[f.name]?.trim());
    if (missing) {
      setError(`${missing.label} is required`);
      return;
    }
    requestDispatch(values);
  };

  return (
    <div className="cvb-action">
      {!expanded && (
        <button
          type="button"
          className={`cvb-action-button${item.destructive ? " is-destructive" : ""}`}
          data-tone={item.tone}
          disabled={!ctx || pending}
          aria-expanded={hasFields ? open : undefined}
          onClick={onButtonClick}
        >
          {item.glyph && (
            <span className="cvb-action-glyph" aria-hidden="true">
              {item.glyph}
            </span>
          )}
          {item.label}
        </button>
      )}
      {hasFields && (expanded || open) && (
        <form className="cvb-action-form" onSubmit={onSubmit}>
          {fields.map((f) => {
            const id = `cvb-af-${item.type}-${f.name}`;
            return (
              <div key={f.name} className="cvb-action-field">
                <label className="cvb-action-field-label" htmlFor={id}>
                  {f.label}
                </label>
                {f.multiline ? (
                  <textarea
                    id={id}
                    className="cvb-action-field-input"
                    placeholder={f.placeholder}
                    value={values[f.name] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                  />
                ) : (
                  <input
                    id={id}
                    type="text"
                    className="cvb-action-field-input"
                    placeholder={f.placeholder}
                    value={values[f.name] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                  />
                )}
              </div>
            );
          })}
          {error && <p className="cvb-action-form-error">{error}</p>}
          <div className="cvb-action-form-controls">
            <button
              type="submit"
              className="cvb-action-button"
              data-tone={item.tone}
              disabled={!ctx || pending}
            >
              {expanded && item.glyph && (
                <span className="cvb-action-glyph" aria-hidden="true">
                  {item.glyph}
                </span>
              )}
              {item.label}
            </button>
            {!expanded && (
              <button type="button" className="cvb-action-button" onClick={() => setOpen(false)}>
                Cancel
              </button>
            )}
          </div>
        </form>
      )}
      <ConfirmModal
        open={confirmOpen}
        title={actionConfirmTitle(item)}
        body={actionConfirmBody(item)}
        mode={actionConfirmMode(item)}
        confirmLabel={item.confirm?.confirmLabel ?? item.label}
        cancelLabel={item.confirm?.cancelLabel}
        danger
        onConfirm={() => {
          setConfirmOpen(false);
          void dispatch(confirmValues);
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}

function CardOverflowActions({ cardTitle, actions }: { cardTitle: string; actions: ActionItem[] }) {
  const ctx = useBoardActions();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState<ActionItem | null>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | TouchEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        menuRef.current?.contains(target) ||
        triggerRef.current?.contains(target) ||
        !(target instanceof Element)
      ) {
        return;
      }
      setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("touchstart", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("touchstart", close);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const target = itemRefs.current[activeIndex];
    target?.focus();
  }, [open, activeIndex]);

  useEffect(
    () => () => {
      if (longPressRef.current) clearTimeout(longPressRef.current);
    },
    [],
  );

  const runAction = async (item: ActionItem) => {
    if (!ctx || pending) return;
    setPending(true);
    try {
      const payload = mergePayload(item.payload);
      const result = await ctx.run(
        payload !== undefined ? { type: item.type, payload } : { type: item.type },
      );
      if (result.ok) setOpen(false);
    } finally {
      setPending(false);
    }
  };

  const triggerAction = (item: ActionItem) => {
    if (item.destructive) {
      setOpen(false);
      setConfirming(item);
      return;
    }
    void runAction(item);
  };

  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % actions.length);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + actions.length) % actions.length);
      return;
    }
    if (e.key === "Home") {
      e.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (e.key === "End") {
      e.preventDefault();
      setActiveIndex(actions.length - 1);
    }
  };

  const scheduleLongPress = (pointerType: string) => {
    if (pointerType !== "touch" && pointerType !== "pen") return;
    if (longPressRef.current) clearTimeout(longPressRef.current);
    longPressRef.current = setTimeout(() => {
      setOpen(true);
      setActiveIndex(0);
    }, 450);
  };

  const clearLongPress = () => {
    if (!longPressRef.current) return;
    clearTimeout(longPressRef.current);
    longPressRef.current = null;
  };

  if (actions.length === 0) return null;
  const fallbackAction = actions[0]!;
  const actionKey = makeKeyer();

  return (
    <div className={`cvb-card-overflow${open ? " is-open" : ""}`}>
      <button
        ref={triggerRef}
        type="button"
        className="cvb-card-overflow-trigger"
        aria-label={`${cardTitle} actions`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!ctx || pending}
        onClick={() => {
          setOpen((v) => !v);
          setActiveIndex(0);
        }}
        onPointerDown={(e) => scheduleLongPress(e.pointerType)}
        onPointerUp={clearLongPress}
        onPointerCancel={clearLongPress}
        onContextMenu={(e) => {
          e.preventDefault();
          setOpen(true);
          setActiveIndex(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen(true);
            setActiveIndex(0);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
      >
        ⋯
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          className="cvb-card-overflow-menu"
          onKeyDown={onMenuKeyDown}
          aria-label={`${cardTitle} destructive actions`}
        >
          {actions.map((action, index) => (
            <button
              key={actionKey(action.type)}
              ref={(el) => {
                itemRefs.current[index] = el;
              }}
              type="button"
              role="menuitem"
              className="cvb-card-overflow-item"
              tabIndex={index === activeIndex ? 0 : -1}
              disabled={pending}
              onMouseEnter={() => setActiveIndex(index)}
              onFocus={() => setActiveIndex(index)}
              onClick={() => triggerAction(action)}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
      <ConfirmModal
        open={confirming !== null}
        title={actionConfirmTitle(confirming ?? fallbackAction)}
        body={actionConfirmBody(confirming ?? fallbackAction)}
        mode={actionConfirmMode(confirming ?? fallbackAction)}
        confirmLabel={
          (confirming ?? fallbackAction).confirm?.confirmLabel ??
          (confirming ?? fallbackAction).label
        }
        cancelLabel={(confirming ?? fallbackAction).confirm?.cancelLabel}
        danger
        onConfirm={() => {
          if (!confirming) return;
          setConfirming(null);
          void runAction(confirming);
        }}
        onCancel={() => {
          setConfirming(null);
          triggerRef.current?.focus();
        }}
      />
    </div>
  );
}

// Action buttons dispatch to the owning rib via the board-action context (a
// surface region / the canvas drawer provides it, keyed off the snapshot
// namespace). With no provider in scope the buttons render disabled.
function ActionsSection({ section }: { section: Extract<BoardSection, { kind: "actions" }> }) {
  const key = makeKeyer();
  const tabs = section.tabs === true;
  // Tabs own their items' form-open state so exactly one form exists at a time;
  // indexed (not typed) so two items sharing a `type` stay independent.
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const layout = tabs ? " cvb-actions--tabs" : section.wrap ? " cvb-actions--wrap" : "";
  return (
    <div className={`cvb-actions${layout}`}>
      {section.items.map((a, i) => (
        <ActionItemButton
          key={key(a.type)}
          item={a}
          {...(tabs
            ? {
                open: openIndex === i,
                // A close only clears the slot when THIS item holds it — a
                // fieldless sibling's post-dispatch close must not fold the
                // open tab.
                onOpenChange: (o: boolean) =>
                  setOpenIndex((cur) => (o ? i : cur === i ? null : cur)),
              }
            : {})}
        />
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
    // Confirm the clipboard can receive the value before revealing anything — no
    // point fetching (and auditing) a secret we can't deliver.
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText) {
      setState("fail");
      return;
    }
    setState("busy");
    try {
      const result = await ctx.reveal(action);
      if (result.ok && result.data != null) {
        await clipboard.writeText(String(result.data));
        setState("ok");
      } else {
        setState("fail");
      }
    } catch {
      setState("fail");
    }
  };
  const glyph = state === "busy" ? "…" : state === "ok" ? "✓" : state === "fail" ? "✕" : "⧉";
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
        <div
          className="cvb-stats"
          style={{ "--cvb-stat-cols": section.items.length } as CSSProperties}
        >
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
      const inline = section.inline === true;
      return (
        <div className={`cvb-bars${inline ? " cvb-bars--inline" : ""}`}>
          {section.items.map((b) => {
            const track = (
              <div className="cvb-bar-track">
                <div
                  className="cvb-bar-fill"
                  data-tone={b.tone}
                  style={{ width: `${barPct(b.value, b.total)}%` }}
                />
              </div>
            );
            const trailing = (
              <span className="cvb-bar-trailing">
                {b.trailing ?? `${barPct(b.value, b.total)}%`}
              </span>
            );
            return (
              <div key={key(JSON.stringify(b))} className="cvb-bar">
                {inline ? (
                  <>
                    <span className="cvb-bar-label">{b.label}</span>
                    {track}
                    {trailing}
                  </>
                ) : (
                  <>
                    <div className="cvb-bar-head">
                      <span className="cvb-bar-label">{b.label}</span>
                      {trailing}
                    </div>
                    {track}
                  </>
                )}
              </div>
            );
          })}
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
        <div className={`cvb-cards${section.boxed ? " cvb-cards--boxed" : ""}`}>
          {section.items.map((c) => {
            const fieldKey = makeKeyer();
            return (
              <div key={key(JSON.stringify(c))} className="cvb-card">
                <div className="cvb-card-head">
                  {c.dot && <span className="cvb-card-dot" data-tone={c.dot} />}
                  {isSafeLinkScheme(c.href) ? (
                    <a
                      className={`cvb-link cvb-card-title${c.mono ? " cvb-card-title--mono" : ""}`}
                      href={c.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      data-tone={c.titleTone}
                    >
                      {c.title}
                    </a>
                  ) : (
                    <span
                      className={`cvb-card-title${c.mono ? " cvb-card-title--mono" : ""}`}
                      data-tone={c.titleTone}
                    >
                      {c.title}
                    </span>
                  )}
                  {c.pill && (
                    <span className="cvb-pill" data-tone={c.pill.tone}>
                      {c.pill.label}
                    </span>
                  )}
                  {(() => {
                    // Destructive actions hide in the overflow (⋯) menu unless they
                    // opt into `inline` — then they render as a visible, still
                    // confirm-guarded button below, alongside the non-destructive verbs.
                    const overflowActions =
                      c.actions?.filter((action) => action.destructive && !action.inline) ?? [];
                    return overflowActions.length > 0 ? (
                      <CardOverflowActions cardTitle={c.title} actions={overflowActions} />
                    ) : null;
                  })()}
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
                            label={f.label ?? (f.value !== null ? String(f.value) : undefined)}
                          />
                        )}
                        {f.copyable && f.value !== null && (
                          <button
                            type="button"
                            className="cvb-copy"
                            aria-label={`Copy ${f.label ?? String(f.value)}`}
                            onClick={() => copy(String(f.value))}
                          >
                            ⧉
                          </button>
                        )}
                      </span>
                    ))}
                  </div>
                )}
                {c.footnote && <div className="cvb-card-footnote">{c.footnote}</div>}
                {c.reason && (
                  <div className="cvb-card-reason">
                    {c.reason.label && (
                      <span className="cvb-card-reason-label">{c.reason.label} </span>
                    )}
                    {c.reason.text}
                  </div>
                )}
                {(() => {
                  const inline = c.actions?.filter((a) => !a.destructive || a.inline) ?? [];
                  return inline.length > 0 ? (
                    <div className="cvb-actions cvb-card-actions">
                      {inline.map((a) => (
                        <ActionItemButton key={fieldKey(JSON.stringify(a))} item={a} />
                      ))}
                    </div>
                  ) : null;
                })()}
              </div>
            );
          })}
        </div>
      );
    }
    case "rows": {
      const key = makeKeyer();
      return (
        <div className={`cvb-rows${section.boxed ? " cvb-rows--boxed" : ""}`}>
          {section.items.map((r) => {
            const rowKey = key(JSON.stringify(r));
            const body = (
              <>
                {r.icon && (
                  <span className="cvb-row-icon" aria-hidden="true">
                    {r.icon}
                  </span>
                )}
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
              </>
            );
            if (!r.detail) {
              return (
                <div key={rowKey} className="cvb-row">
                  {body}
                </div>
              );
            }
            return (
              <details key={rowKey} className="cvb-row-details">
                <summary className="cvb-row">
                  {body}
                  <span className="cvb-row-caret" aria-hidden="true">
                    ▸
                  </span>
                </summary>
                <div className="cvb-row-detail">{r.detail}</div>
              </details>
            );
          })}
        </div>
      );
    }
    case "actions":
      return <ActionsSection section={section} />;
    case "grid": {
      const key = makeKeyer();
      return (
        <div className="cvb-grid">
          {section.cells.map((cell) =>
            isSafeLinkScheme(cell.href) ? (
              <a
                key={key(JSON.stringify(cell))}
                className="cvb-grid-cell cvb-grid-cell--link"
                href={cell.href}
                target="_blank"
                rel="noopener noreferrer"
              >
                <span className="cvb-grid-label">{cell.label}</span>
                <span className="cvb-grid-badge" data-tone={cell.badge.tone}>
                  {cell.badge.text}
                </span>
              </a>
            ) : (
              <div key={key(JSON.stringify(cell))} className="cvb-grid-cell">
                <span className="cvb-grid-label">{cell.label}</span>
                <span className="cvb-grid-badge" data-tone={cell.badge.tone}>
                  {cell.badge.text}
                </span>
              </div>
            ),
          )}
        </div>
      );
    }
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

// A board's section stack without the header strip. A surface region renders
// this directly so its own gradient lane head owns the title/chip/pulse.
export function BoardBody({ view }: { view: Pick<CanvasBoardView, "sections"> }) {
  const key = makeKeyer();
  return (
    <div className="canvas-view-board">
      {view.sections.map((section) => (
        <SectionBlock key={key(JSON.stringify(section))} section={section} />
      ))}
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
