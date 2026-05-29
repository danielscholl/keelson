// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import type { SlashCommandFamily } from "../../lib/slashCommands.ts";

export interface CommandCallPayload {
  command: string;
  args: string;
  family: SlashCommandFamily;
  result?: { ok: boolean; message: string; runId?: string; workflowName?: string };
}

interface CommandCallBlockProps {
  commandCall: CommandCallPayload;
  onOpenRun?: (workflowName: string, runId: string) => void;
}

function familyLabel(family: SlashCommandFamily): string {
  return family.toUpperCase();
}

export function CommandCallBlock({ commandCall, onOpenRun }: CommandCallBlockProps) {
  const { command, args, family, result } = commandCall;
  const isRunning = result === undefined;
  const isError = result !== undefined && !result.ok;
  const runLink =
    result?.ok && result.runId && result.workflowName
      ? { runId: result.runId, workflowName: result.workflowName }
      : null;
  return (
    <details className="command-call-block" open={isRunning || isError}>
      <summary className="command-call-summary">
        <span className="command-call-name">/{command}</span>
        <span
          className={`tool-source-chip tool-source-${family}`}
          role="img"
          aria-label={`command family: ${familyLabel(family)}`}
        >
          {familyLabel(family)}
        </span>
        {isRunning ? (
          <span className="tool-calls-running-dot" role="img" aria-label="running" />
        ) : null}
        {isError ? (
          <span className="tool-calls-error-badge" title="command failed">
            failed
          </span>
        ) : null}
      </summary>
      <div className="command-call-body">
        {args.length > 0 ? (
          <pre className="command-call-args">{args}</pre>
        ) : (
          <pre className="command-call-args command-call-args-empty">(no args)</pre>
        )}
        {result !== undefined ? (
          <pre
            className={
              isError ? "command-call-result command-call-result-error" : "command-call-result"
            }
          >
            {result.message}
          </pre>
        ) : null}
        {runLink && onOpenRun ? (
          <button
            type="button"
            className="command-call-open-run"
            onClick={() => onOpenRun(runLink.workflowName, runLink.runId)}
          >
            Open in Workflows →
          </button>
        ) : null}
      </div>
    </details>
  );
}
