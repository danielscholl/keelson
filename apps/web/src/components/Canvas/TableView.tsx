import type { CanvasCell, CanvasTableView, CanvasTone } from "@keelson/shared";

type Tone = CanvasTone;

function normalizeCell(cell: CanvasCell | undefined): { display: string; tone?: Tone } {
  const wrapped =
    cell !== null && typeof cell === "object" ? cell : { value: cell, tone: undefined };
  const display =
    wrapped.value === null || wrapped.value === undefined ? "—" : String(wrapped.value);
  return wrapped.tone ? { display, tone: wrapped.tone } : { display };
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
                const { display, tone } = normalizeCell(row[col.key]);
                return (
                  <td key={col.key} data-tone={tone}>
                    {display}
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
