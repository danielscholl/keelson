import type { CanvasCell, CanvasCellBadge, CanvasTableView, CanvasTone } from "@keelson/shared";
import { isSafeLinkScheme } from "../../lib/safeLink";

type Tone = CanvasTone;

function normalizeCell(cell: CanvasCell | undefined): {
  display: string;
  tone?: Tone;
  badges?: CanvasCellBadge[];
  href?: string;
} {
  const obj = cell !== null && typeof cell === "object" ? cell : null;
  const value = obj ? obj.value : cell;
  const badges = obj?.badges?.length ? obj.badges : undefined;
  const href = obj?.href;
  // A badge-only cell shows no dash placeholder; an empty value otherwise reads "—".
  const display = value === null || value === undefined ? (badges ? "" : "—") : String(value);
  return {
    display,
    ...(obj?.tone ? { tone: obj.tone } : {}),
    ...(badges ? { badges } : {}),
    ...(href ? { href } : {}),
  };
}

// Small toned chips beside (or instead of) a cell value — A–E grade chips, a
// filled pass/skip/fail count. Keyed by content so repeats stay stable.
function CellBadges({ badges }: { badges: CanvasCellBadge[] }) {
  const seen = new Map<string, number>();
  return (
    <span className="canvas-cell-badges">
      {badges.map((b) => {
        const base = `${b.text}:${b.tone ?? ""}`;
        const dup = seen.get(base) ?? 0;
        seen.set(base, dup + 1);
        return (
          <span
            key={dup === 0 ? base : `${base}#${dup}`}
            className="canvas-cell-badge"
            data-tone={b.tone}
          >
            {b.text}
          </span>
        );
      })}
    </span>
  );
}

export function TableView({ view }: { view: CanvasTableView }) {
  // Content-derived row keys (a duplicate-occurrence suffix keeps them unique)
  // so we never key on the array index. The suffix can't collide: a row's JSON
  // never ends in another row's "#<n>" shape.
  const seen = new Map<string, number>();
  const keyedRows = view.rows.map((row) => {
    const base = JSON.stringify(row);
    const dup = seen.get(base) ?? 0;
    seen.set(base, dup + 1);
    return { key: dup === 0 ? base : `${base}#${dup}`, row };
  });

  return (
    <div className="canvas-view-table">
      <table>
        {view.caption && <caption>{view.caption}</caption>}
        <thead>
          <tr>
            {view.columns.map((col) => (
              <th key={col.key}>{col.label ?? col.key}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {keyedRows.map(({ key, row }) => (
            <tr key={key}>
              {view.columns.map((col) => {
                const { display, tone, badges, href } = normalizeCell(row[col.key]);
                const displayNode = isSafeLinkScheme(href) ? (
                  <a
                    className="cvb-link"
                    data-tone={tone}
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {display}
                  </a>
                ) : (
                  display
                );
                return (
                  <td key={col.key} data-tone={tone}>
                    {badges ? (
                      <>
                        {display && <span className="canvas-cell-value">{displayNode}</span>}
                        <CellBadges badges={badges} />
                      </>
                    ) : (
                      displayNode
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
