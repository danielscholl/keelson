// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").
//
// Renders text that MAY carry ANSI SGR escapes as styled spans, driving the
// .ansi-*-fg/bg + .ansi-<decoration> palette in app.css. Named/256-palette
// colors map to classes (anser emits "ansi-green"; we suffix "-fg"); 24-bit
// truecolor — Rich's Syntax/pygments output — has no class, so it rides an
// inline rgb() style the light-mode override keeps legible. Plain text with no
// escapes renders as-is (anser yields a single classless chunk), so this is a
// safe drop-in wherever a plain string was rendered before.

import Anser from "anser";
import { type CSSProperties, Fragment } from "react";

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

export function AnsiText({ text }: { text: string }) {
  const chunks = Anser.ansiToJson(text, { use_classes: true, remove_empty: true });
  // Key by each chunk's start offset — stable and unique within a render, and
  // not the array index (which would tie identity to position).
  let offset = 0;
  const parts = chunks.map((entry) => {
    const key = `${offset}:${entry.content.length}`;
    offset += entry.content.length;
    return { entry, key };
  });
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
}
