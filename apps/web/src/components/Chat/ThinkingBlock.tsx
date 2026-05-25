// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").
//
// Renders extended-thinking inline above the answer. Live-only — server
// doesn't persist thinking content, so reload shows only the answer.

import { LightbulbIcon } from "./icons.tsx";

interface ThinkingBlockProps {
  // Accumulated thinking_delta text from the in-flight or completed turn.
  content: string;
  // Open during streaming so the user sees thinking accrue; auto-collapses
  // on `done` so the answer stays the focal point of the bubble.
  streaming: boolean;
}

export function ThinkingBlock({ content, streaming }: ThinkingBlockProps) {
  if (content.length === 0) return null;
  return (
    <details className="thinking-block" open={streaming}>
      <summary className="thinking-summary">
        <LightbulbIcon /> Thinking…
      </summary>
      <div className="thinking-content">{content}</div>
    </details>
  );
}
