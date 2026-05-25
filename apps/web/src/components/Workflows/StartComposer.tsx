// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { type KeyboardEvent, useState } from "react";

export interface StartComposerProps {
  // Empty → run with no args. The input remains optional even after W6
  // lands named inputs; that flow will mount a different composer.
  onStart: (args: string) => Promise<void> | void;
  // True between the Start click and the API returning a runId — keeps
  // the button latched and the input read-only so a double-fire can't
  // start two runs on the same intent.
  starting: boolean;
}

// Pre-start composer mirroring the chat composer pattern — single
// bordered card with a transparent textarea and an embedded Send-style
// button bottom-right. Single-row visual default but a real textarea so
// pasted multi-line content (task descriptions, diffs, stack traces)
// reaches `$ARGUMENTS` intact. Same Enter/Shift+Enter ergonomics as
// chat keeps the muscle memory consistent across the two surfaces.
export function StartComposer({ onStart, starting }: StartComposerProps) {
  const [text, setText] = useState("");

  const submit = async () => {
    if (starting) return;
    await onStart(text);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div className="start-composer">
      <textarea
        className="start-composer-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Optional arguments — Enter to start, Shift+Enter for newline"
        rows={1}
        disabled={starting}
        aria-label="Workflow arguments"
      />
      <div className="start-composer-row">
        <span className="start-composer-spacer" />
        <button
          type="button"
          className="chat-send"
          onClick={() => void submit()}
          disabled={starting}
        >
          {starting ? "Starting…" : "Start"}
        </button>
      </div>
    </div>
  );
}
