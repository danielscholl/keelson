// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// Generic dispatch-and-poll tools over the op registry. A long-running tool
// (e.g. a rib's squad_coordinate) returns an op id promptly instead of blocking
// its single MCP POST; these five tools then poll the durable registry:
// run_list discovers, run_status reports, run_events streams cursor-based frames,
// run_cancel aborts a live op, run_steer delivers an operator note to a steerable
// op. Results — and event history — survive a server restart. Reaches chat + MCP
// via the same one-array `harnessTools` injection the workflow tools use.

import type { ToolContext, ToolDefinition } from "@keelson/shared";
import { z } from "zod";
import type { OpEventView, OpRegistry, OpStatusView, OpSummaryView } from "./op-registry.ts";
import { emitResult, truncate } from "./workflow-tools.ts";

// Cap a single run_events page so a chatty op can't flood one turn; the caller
// pages by passing the returned next-cursor back in. The byte budget bounds the
// rendered SIZE (a frame message/data is unbounded), independent of frame count.
const EVENT_PAGE = 100;
const LIST_RENDER_CAP = 100;
const EVENT_BYTE_BUDGET = 8_000;
const FRAME_MSG_CAP = 2_000;
const FRAME_DATA_CAP = 2_000;
const RESULT_CAP = 8_000;
// `kind` is caller-supplied at registration with no length limit; cap it while
// rendering so a long kind can't blow up a 100-row run_list or a run_status line.
const KIND_CAP = 200;

const listInputSchema = z.object({});
const statusInputSchema = z.object({ id: z.string().min(1) });
const eventsInputSchema = z.object({
  id: z.string().min(1),
  cursor: z.number().int().nonnegative().optional(),
});
const cancelInputSchema = z.object({ id: z.string().min(1) });
const steerInputSchema = z.object({
  id: z.string().min(1),
  note: z.string().min(1).max(8_192),
});

function renderSummaryLine(op: OpSummaryView): string {
  const steer = op.steerable ? " (steerable)" : "";
  const done = op.completedAt ? ` completed ${op.completedAt}` : "";
  return `• ${op.id} — ${truncate(op.kind, KIND_CAP)} [${op.status}]${steer} started ${op.createdAt}${done}`;
}

function renderStatus(op: OpStatusView): string {
  const lines = [
    `Op ${op.id} — ${truncate(op.kind, KIND_CAP)} — status ${op.status}.`,
    `owner: ${op.owner} · steerable: ${op.steerable} · started: ${op.createdAt}` +
      (op.completedAt ? ` · completed: ${op.completedAt}` : ""),
  ];
  if (op.error) lines.push(`error: ${truncate(op.error, RESULT_CAP)}`);
  if (op.result !== undefined && op.result !== null) {
    lines.push(`result: ${truncate(JSON.stringify(op.result), RESULT_CAP)}`);
  }
  lines.push(
    op.lastSeq > 0
      ? `${op.lastSeq} event(s) — read them with run_events(id="${op.id}", cursor=0).`
      : "No events yet.",
  );
  return lines.join("\n");
}

// Cap message + data per frame (a rib can log an unbounded string) so a single
// frame can't blow the page byte budget on its own.
function buildFrameLine(e: OpEventView): string {
  const dataStr =
    e.data === null || e.data === undefined
      ? ""
      : ` ${truncate(JSON.stringify(e.data), FRAME_DATA_CAP)}`;
  const msg = e.message ? ` ${truncate(e.message, FRAME_MSG_CAP)}` : "";
  return `[${e.seq}] ${e.kind}${msg}${dataStr}`;
}

function renderEvents(id: string, events: OpEventView[], cursor: number): string {
  if (events.length === 0) {
    return `No events for op ${id} after cursor ${cursor}.`;
  }
  // Workflow ops (wf: id) are a snapshot with an ignored cursor, so render the
  // TAIL: the terminal frame (last) and most-recent nodes are what matter, and
  // paging off the head would make the terminal permanently unreachable.
  if (id.startsWith("wf:")) {
    const tail: string[] = [];
    let usedBytes = 0;
    for (let i = events.length - 1; i >= 0 && tail.length < EVENT_PAGE; i--) {
      const line = buildFrameLine(events[i] as OpEventView);
      if (tail.length > 0 && usedBytes + line.length > EVENT_BYTE_BUDGET) break;
      tail.unshift(line);
      usedBytes += line.length + 1;
    }
    const omitted = events.length - tail.length;
    const note = omitted > 0 ? `\n… (${omitted} earlier node frame(s) omitted)` : "";
    return `workflow snapshot — ${tail.length} of ${events.length} node frame(s) for op ${id} (re-read for current state):\n${tail.join("\n")}${note}`;
  }
  // Native ops: head-first with a durable, incremental cursor.
  const lines: string[] = [];
  let used = 0;
  let lastSeq = cursor;
  let bytesHit = false;
  for (const e of events.slice(0, EVENT_PAGE)) {
    const line = buildFrameLine(e);
    if (lines.length > 0 && used + line.length > EVENT_BYTE_BUDGET) {
      bytesHit = true;
      break;
    }
    lines.push(line);
    used += line.length + 1;
    lastSeq = e.seq;
  }
  const more =
    bytesHit || events.length > lines.length
      ? `\n… more frames remain. Poll run_events(id="${id}", cursor=${lastSeq}) for the next page.`
      : `\nNext cursor: ${lastSeq}. Poll run_events(id="${id}", cursor=${lastSeq}) for new frames.`;
  return `${lines.length} frame(s) for op ${id} after cursor ${cursor}:\n${lines.join("\n")}${more}`;
}

export function createOpTools(deps: { registry: OpRegistry }): ToolDefinition[] {
  const { registry } = deps;

  const runList: ToolDefinition = {
    name: "run_list",
    description:
      "List active operations (long-running work registered on the durable op registry) plus live workflow runs. Each row shows the op id, kind, status, and whether it accepts steering. Use run_status / run_events with an id to inspect one; workflow ops carry a `wf:` id prefix.",
    inputSchema: listInputSchema,
    async execute(input, ctx: ToolContext) {
      const parsed = listInputSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `invalid input: ${parsed.error.message}`, true);
        return;
      }
      const ops = registry.list();
      if (ops.length === 0) {
        emitResult(ctx, "No active operations or runs.");
        return;
      }
      const shown = ops.slice(0, LIST_RENDER_CAP);
      const moreNote =
        ops.length > shown.length
          ? `\n… and ${ops.length - shown.length} more active operation(s) not shown.`
          : "";
      const header =
        ops.length > shown.length
          ? `${ops.length} active operation(s) (showing ${shown.length}):`
          : `${ops.length} operation(s):`;
      emitResult(
        ctx,
        `${header}\n${shown.map(renderSummaryLine).join("\n")}${moreNote}\n\nInspect one with run_status(id="…"); stream its frames with run_events(id="…", cursor=0).`,
      );
    },
  };

  const runStatus: ToolDefinition = {
    name: "run_status",
    description:
      "Report one operation's status and — when it has finished — its terminal result. The result and event history are durable, so this still works after a server restart (an op that was mid-flight at the crash reports 'orphaned'). Pass the op id from run_list or the id a long tool returned.",
    inputSchema: statusInputSchema,
    async execute(input, ctx: ToolContext) {
      const parsed = statusInputSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `invalid input: ${parsed.error.message}`, true);
        return;
      }
      const status = registry.status(parsed.data.id.trim());
      if (!status) {
        emitResult(ctx, `Operation ${parsed.data.id} was not found.`, true);
        return;
      }
      emitResult(ctx, renderStatus(status));
    },
  };

  const runEvents: ToolDefinition = {
    name: "run_events",
    description:
      "Read an operation's progress frames after a cursor (0 for the beginning). Native ops return frames with monotonic seq numbers — pass the highest seq back as `cursor` to poll only new frames. Workflow ops (a `wf:` id) return a full snapshot of node progress each poll (their frames are a live projection). This is the dispatch-and-poll substrate — long tools stream progress here rather than blocking their call.",
    inputSchema: eventsInputSchema,
    async execute(input, ctx: ToolContext) {
      const parsed = eventsInputSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `invalid input: ${parsed.error.message}`, true);
        return;
      }
      const id = parsed.data.id.trim();
      const cursor = parsed.data.cursor ?? 0;
      if (!registry.status(id)) {
        emitResult(ctx, `Operation ${id} was not found.`, true);
        return;
      }
      // Fetch one past the page so renderEvents can still detect "more remain".
      emitResult(ctx, renderEvents(id, registry.events(id, cursor, EVENT_PAGE + 1), cursor));
    },
  };

  const runCancel: ToolDefinition = {
    name: "run_cancel",
    description:
      "Cancel a live operation by id — aborts its execution (the op's terminal row is preserved, not deleted). Fails cleanly if the op is already terminal or has no live execution (e.g. after a server restart).",
    inputSchema: cancelInputSchema,
    state_changing: true,
    async execute(input, ctx: ToolContext) {
      const parsed = cancelInputSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `invalid input: ${parsed.error.message}`, true);
        return;
      }
      const result = registry.cancel(parsed.data.id.trim());
      emitResult(ctx, result.message, !result.ok);
    },
  };

  const runSteer: ToolDefinition = {
    name: "run_steer",
    description:
      "Deliver a steering note to a live operation that declared a steer channel (see the `steerable` flag in run_list). Errors if the op is not steerable, is terminal, or is a workflow run (answer a workflow approval pause with workflow_respond instead).",
    inputSchema: steerInputSchema,
    state_changing: true,
    async execute(input, ctx: ToolContext) {
      const parsed = steerInputSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `invalid input: ${parsed.error.message}`, true);
        return;
      }
      const result = registry.steer(parsed.data.id.trim(), parsed.data.note);
      emitResult(ctx, result.message, !result.ok);
    },
  };

  return [runList, runStatus, runEvents, runCancel, runSteer];
}
