import type { CanvasKind, RibSummary } from "@keelson/shared";

export function canvasKindForKey(ribs: RibSummary[], key: string): CanvasKind {
  return ribs.flatMap((rib) => rib.views).find((view) => view.key === key)?.canvasKind ?? "view";
}
