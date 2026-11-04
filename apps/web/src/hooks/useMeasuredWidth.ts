// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { useEffect, useState } from "react";

// Tracks an element's rendered width so an SVG can set its viewBox to match and
// keep labels and strokes at their CSS size instead of scaling with the window.
// Returns a callback ref, so an element that mounts after the first render is still measured.
export function useMeasuredWidth<T extends Element>(
  fallback: number,
): [(el: T | null) => void, number] {
  const [el, setEl] = useState<T | null>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    if (!el) return;
    const measure = () => {
      const measured = Math.round(el.getBoundingClientRect().width);
      if (measured > 0) setWidth(measured);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return [setEl, width];
}
