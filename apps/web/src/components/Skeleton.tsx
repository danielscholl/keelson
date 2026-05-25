import type { CSSProperties } from "react";

interface SkeletonProps {
  // CSS dimensions — passed through as inline styles so callers don't have
  // to touch bridge.css for one-off sizes. Default is a single text line.
  height?: string;
  width?: string;
  radius?: string;
  className?: string;
}

export function Skeleton({
  height = "1em",
  width = "100%",
  radius = "4px",
  className,
}: SkeletonProps) {
  const style: CSSProperties = { height, width, borderRadius: radius };
  return (
    <span
      className={`skeleton${className ? ` ${className}` : ""}`}
      style={style}
      aria-hidden="true"
    />
  );
}

// Vertically stacked skeletons for list-shaped surfaces (sidebar entries,
// chat bubbles loading). Caller picks the count; small built-in gap keeps
// the rows distinct from a single tall placeholder.
export function SkeletonStack({
  rows,
  height = "2.4em",
  gap = "0.6em",
}: {
  rows: number;
  height?: string;
  gap?: string;
}) {
  return (
    <div className="skeleton-stack" style={{ display: "grid", gap }}>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} height={height} />
      ))}
    </div>
  );
}
