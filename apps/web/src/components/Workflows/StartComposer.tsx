// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { Project } from "@keelson/shared";
import { type KeyboardEvent, useEffect, useState } from "react";

export interface StartRequest {
  args: string;
  projectId: string;
  isolation: "worktree" | "none" | null;
}

export interface StartComposerProps {
  // Caller-supplied project list + current selection. The composer requires
  // a selected project — the Start button stays latched until one is picked.
  projects: Project[];
  selectedProjectId: string | null;
  onSelectProject: (projectId: string) => void;
  // Empty → run with no args. The input remains optional; future named-input
  // flows will mount a different composer.
  onStart: (req: StartRequest) => Promise<void> | void;
  // True between the Start click and the API returning a runId — keeps
  // the button latched and the input read-only so a double-fire can't
  // start two runs on the same intent.
  starting: boolean;
  // YAML's default for this workflow. When defined, the checkbox is
  // pre-checked / pre-cleared accordingly. The user's choice overrides at
  // run time (and only at run time — the YAML is the persistent default).
  yamlIsolationDefault?: boolean;
}

// Pre-start composer mirroring the chat composer pattern — single
// bordered card with a transparent textarea and an embedded Send-style
// button bottom-right. Single-row visual default but a real textarea so
// pasted multi-line content (task descriptions, diffs, stack traces)
// reaches `$ARGUMENTS` intact. Same Enter/Shift+Enter ergonomics as
// chat keeps the muscle memory consistent across the two surfaces.
export function StartComposer({
  projects,
  selectedProjectId,
  onSelectProject,
  onStart,
  starting,
  yamlIsolationDefault,
}: StartComposerProps) {
  const [text, setText] = useState("");
  const [isolated, setIsolated] = useState<boolean>(yamlIsolationDefault === true);
  // Re-sync when the parent flips to a workflow with a different YAML default
  // (the composer is reused across catalog rows when entering pre-start mode).
  useEffect(() => {
    setIsolated(yamlIsolationDefault === true);
  }, [yamlIsolationDefault]);
  const canStart = !starting && !!selectedProjectId && projects.length > 0;

  const submit = async () => {
    if (!canStart || !selectedProjectId) return;
    // Only send the override when the user diverged from the YAML default,
    // so an unchanged checkbox doesn't pin the run's policy on the server.
    const isolation: "worktree" | "none" | null =
      yamlIsolationDefault === undefined
        ? isolated
          ? "worktree"
          : null
        : isolated === yamlIsolationDefault
          ? null
          : isolated
            ? "worktree"
            : "none";
    await onStart({ args: text, projectId: selectedProjectId, isolation });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div className="start-composer">
      <div className="start-composer-target">
        <label className="start-composer-target-label">
          Project
          <select
            value={selectedProjectId ?? ""}
            onChange={(e) => onSelectProject(e.target.value)}
            disabled={starting || projects.length === 0}
          >
            {projects.length === 0 ? (
              <option value="">no projects — add one in the Projects tab</option>
            ) : (
              <>
                {selectedProjectId === null && <option value="">select a project…</option>}
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {p.rootPath}
                  </option>
                ))}
              </>
            )}
          </select>
        </label>
        <label className="start-composer-isolation">
          <input
            type="checkbox"
            checked={isolated}
            onChange={(e) => setIsolated(e.target.checked)}
            disabled={starting}
          />
          <span>
            Run in isolated git worktree
            {yamlIsolationDefault === true && <em> · workflow default</em>}
          </span>
        </label>
      </div>
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
          disabled={!canStart}
        >
          {starting ? "Starting…" : "Start"}
        </button>
      </div>
    </div>
  );
}
