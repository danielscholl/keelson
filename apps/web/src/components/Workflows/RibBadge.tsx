import { ribAccent } from "../../lib/rib.ts";

export interface RibBadgeProps {
  ribId: string;
  // Human label; falls back to the id when the rib isn't in the active set.
  label?: string;
  title?: string;
}

// A small color-coded chip identifying which rib a workflow / run belongs to.
// The color is derived from the rib id (see ribAccent) so it's consistent
// across the catalog and the runs feed.
export function RibBadge({ ribId, label, title }: RibBadgeProps) {
  const accent = ribAccent(ribId);
  return (
    <span
      className="rib-badge"
      style={{ color: accent.color, background: accent.bg, borderColor: accent.border }}
      title={title ?? `Provided by the ${label ?? ribId} rib`}
    >
      {label ?? ribId}
    </span>
  );
}
