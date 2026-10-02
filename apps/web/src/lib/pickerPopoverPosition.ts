// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

const PICKER_MAX_WIDTH = 460;
const VIEWPORT_GUTTER = 6;

export function pickerPopoverPosition(
  rect: Pick<DOMRectReadOnly, "left" | "right" | "width">,
  viewportWidth: number,
  preferredMinWidth: number,
): { left: string; right: string; minWidth: string } {
  const panelMaxWidth = Math.min(
    PICKER_MAX_WIDTH,
    Math.max(0, viewportWidth - VIEWPORT_GUTTER * 2),
  );
  const left = Math.max(VIEWPORT_GUTTER, Math.round(rect.left));
  const alignRight = left + panelMaxWidth > viewportWidth - VIEWPORT_GUTTER;
  const right = Math.max(
    VIEWPORT_GUTTER,
    Math.min(
      Math.round(viewportWidth - rect.right),
      viewportWidth - VIEWPORT_GUTTER - panelMaxWidth,
    ),
  );

  return {
    left: alignRight ? "auto" : `${left}px`,
    right: alignRight ? `${right}px` : "auto",
    minWidth: `${Math.min(panelMaxWidth, Math.max(preferredMinWidth, Math.round(rect.width)))}px`,
  };
}
