import { CANVAS_ARTIFACT_KEY_PREFIX, type CanvasKind, type RibSummary } from "@keelson/shared";

export function canvasKindForKey(ribs: RibSummary[], key: string): CanvasKind {
  // Published canvas artifacts are harness-owned html pages — no rib manifest
  // declares them, so the namespace itself carries the kind.
  if (key.startsWith(CANVAS_ARTIFACT_KEY_PREFIX)) return "html";
  return ribs.flatMap((rib) => rib.views).find((view) => view.key === key)?.canvasKind ?? "view";
}
