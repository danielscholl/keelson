// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").
//
// Renders text that may contain ANSI SGR escapes as styled spans. Named/256
// colors map to the .ansi-*-fg/bg classes in app.css; 24-bit truecolor has no
// class, so it rides an inline rgb() style (see the light-mode override there).
// Plain text is a classless passthrough — a safe drop-in for a rendered string.

import Anser from "anser";
import { type CSSProperties, Fragment, memo, useMemo } from "react";

function spanAttrs(entry: Anser.AnserJsonEntry): {
  className?: string;
  style?: CSSProperties;
} {
  const classes: string[] = [];
  const style: CSSProperties = {};
  if (entry.fg === "ansi-truecolor" && entry.fg_truecolor) {
    style.color = `rgb(${entry.fg_truecolor})`;
  } else if (entry.fg) {
    classes.push(`${entry.fg}-fg`);
  }
  if (entry.bg === "ansi-truecolor" && entry.bg_truecolor) {
    style.backgroundColor = `rgb(${entry.bg_truecolor})`;
  } else if (entry.bg) {
    classes.push(`${entry.bg}-bg`);
  }
  for (const decoration of entry.decorations) classes.push(`ansi-${decoration}`);
  return {
    className: classes.length > 0 ? classes.join(" ") : undefined,
    style: Object.keys(style).length > 0 ? style : undefined,
  };
}

// Memoized on `text`: a streaming run re-renders as each log frame lands, and
// reparsing the whole cumulative trace on every one of those is quadratic.
export const AnsiText = memo(function AnsiText({ text }: { text: string }) {
  const parts = useMemo(() => {
    const chunks = Anser.ansiToJson(text, { use_classes: true, remove_empty: true });
    // Key by each chunk's start offset — stable and unique within a render, and
    // not the array index (which would tie identity to position).
    let offset = 0;
    return chunks.map((entry) => {
      const key = `${offset}:${entry.content.length}`;
      offset += entry.content.length;
      return { entry, key };
    });
  }, [text]);
  return (
    <span className="ansi-text">
      {parts.map(({ entry, key }) => {
        const { className, style } = spanAttrs(entry);
        // A plain (unstyled) chunk needs no wrapper — emit its text directly.
        if (!className && !style) return <Fragment key={key}>{entry.content}</Fragment>;
        return (
          <span key={key} className={className} style={style}>
            {entry.content}
          </span>
        );
      })}
    </span>
  );
});
