// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { isAbsolute, resolve } from "node:path";

import type { WorkflowFrame } from "@keelson/shared";
import type { RunStreamEvent } from "@keelson/workflows";
import { EXIT_BAD_ARGS, EXIT_FAIL, EXIT_NO_SERVER, EXIT_NOT_FOUND, EXIT_OK } from "../exit.ts";
import { listProjects } from "../http/projects-client.ts";
import { attachRun, HttpError, isServerDownError, startRun } from "../http/workflow-client.ts";
import {
  MemoryRequiresServerError,
  runHeadless,
  WorkflowNotFoundError,
} from "../in-process/run-workflow.ts";
import { emit } from "../output.ts";
import { probeServer } from "../server-probe.ts";

export interface WorkflowRunOptions {
  json: boolean;
  inputs: string[];
  // commander encodes `--watch` and `--no-watch` into the same `watch`
  // field — `true`, `false`, or `undefined` for "not specified". The
  // resolver below treats `undefined` as "auto from TTY".
  watch?: boolean;
  provider?: string;
  baseUrl?: string;
  // Named project — server resolves to project's root_path. When given
  // alongside `workingDir`, `workingDir` wins and the project is recorded
  // for display.
  project?: string;
  // Explicit working directory override. Defaults to `process.cwd()` for the
  // in-process path; for the HTTP path, when neither --project nor
  // --working-dir is given, we send `process.cwd()` so the server doesn't
  // reject the request.
  workingDir?: string;
  // Per-run isolation override: forces a worktree run (`true`), or forces
  // in-place when the YAML defaulted to worktree (`false`). Undefined →
  // honor the workflow's YAML default.
  worktree?: boolean;
}

function parseInputs(pairs: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of pairs) {
    const eq = raw.indexOf("=");
    if (eq <= 0) {
      throw new Error(`invalid --inputs value '${raw}'; expected 'key=value'`);
    }
    const key = raw.slice(0, eq);
    out[key] = raw.slice(eq + 1);
  }
  return out;
}

// `--watch` defaults to true when stdout is a TTY (mirrors git's pager
// heuristic) and false on a pipe so `--json` streams cleanly into another
// tool. Explicit `--watch` / `--no-watch` always win — commander encodes
// `--no-watch` as `watch: false`, so the explicit-false check has to be
// strict (a missing flag is undefined, not false).
function resolveWatch(opts: WorkflowRunOptions): boolean {
  if (opts.watch === false) return false;
  if (opts.watch === true) return true;
  return process.stdout.isTTY === true;
}

// Format executor-emitted events (in-process path). Has access to
// `event.result` and `event.summary` because the executor's RunStreamEvent
// is the richer shape; the HTTP/WS wire frame is a sibling type below.
function formatHumanEvent(event: RunStreamEvent): string {
  switch (event.type) {
    case "run_started":
      return `▶ run ${event.runId.slice(0, 8)} (${event.workflowName})`;
    case "node_started":
      return `  · ${event.nodeId} …`;
    case "node_done": {
      const icon =
        event.result.status === "succeeded" ? "✓" : event.result.status === "skipped" ? "○" : "✗";
      const err = event.result.error ? ` — ${event.result.error}` : "";
      return `  ${icon} ${event.nodeId}${err}`;
    }
    case "node_event":
      if (event.event.type === "node_log") return `    ${event.event.line}`;
      if (event.event.type === "node_warning") return `    warning: ${event.event.message}`;
      return "";
    case "run_warning":
      return `! ${event.message}`;
    case "run_done":
      return `■ ${event.status} (${event.summary.completedAtMs - event.summary.startedAtMs}ms)`;
    default:
      return "";
  }
}

// Format wire frames from the server WS. Shape is workflowFrameSchema in
// @keelson/shared — node_done is flat (status+error at top level, no
// nested result), run_done carries no summary, and node_log / node_chunk
// are top-level events instead of being wrapped in `node_event`.
function formatWorkflowFrame(frame: WorkflowFrame): string {
  switch (frame.type) {
    case "run_started":
      return `▶ run ${frame.runId.slice(0, 8)} (${frame.workflowName})`;
    case "node_started":
      return `  · ${frame.nodeId} …`;
    case "node_done": {
      const icon = frame.status === "succeeded" ? "✓" : frame.status === "skipped" ? "○" : "✗";
      const err = frame.error ? ` — ${frame.error}` : "";
      return `  ${icon} ${frame.nodeId}${err}`;
    }
    case "node_log":
      return `    ${frame.line}`;
    case "node_chunk":
      return "";
    case "run_warning":
      return `! ${frame.message}`;
    case "run_done":
      return `■ ${frame.status}`;
    case "approval_awaiting":
      return `⏸ ${frame.nodeId} awaiting approval — ${frame.message}`;
    default:
      return "";
  }
}

// CLI `--project` accepts either a project name or a UUID (the project add /
// list / remove surfaces all use the human name). The server only matches by
// id, so we resolve the name → id via `/api/projects` before POSTing. UUIDs
// pass through unchanged so scripts that already cached an id keep working.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class ProjectNotFoundError extends Error {
  constructor(nameOrId: string) {
    super(`no project named '${nameOrId}'`);
    this.name = "ProjectNotFoundError";
  }
}

async function resolveProjectId(baseUrl: string, nameOrId: string): Promise<string> {
  if (UUID_PATTERN.test(nameOrId)) return nameOrId;
  const projects = await listProjects(baseUrl);
  const match = projects.find((p) => p.name === nameOrId);
  if (!match) {
    throw new ProjectNotFoundError(nameOrId);
  }
  return match.id;
}

async function runViaHttp(
  name: string,
  inputs: Record<string, string>,
  baseUrl: string,
  watch: boolean,
  json: boolean,
  body: {
    project?: string;
    workingDir?: string;
    isolation?: "worktree" | "none";
  },
): Promise<never> {
  const projectId =
    body.project !== undefined ? await resolveProjectId(baseUrl, body.project) : undefined;
  const { runId } = await startRun(baseUrl, name, {
    inputs,
    ...(projectId !== undefined ? { projectId } : {}),
    ...(body.workingDir !== undefined ? { workingDir: body.workingDir } : {}),
    ...(body.isolation !== undefined ? { isolation: body.isolation } : {}),
  });
  // Echo the run's target and id up front so the human-mode operator can see
  // what the run is acting against before frames start arriving. The header
  // is printed from the POST response rather than the run_started frame: the
  // WS attach can lose the race against a fast first node, and the id is what
  // `workflow respond` / `workflow status` need.
  if (watch && !json) {
    const targetParts: string[] = [];
    if (body.project) targetParts.push(`project=${body.project}`);
    if (body.workingDir) targetParts.push(`cwd=${body.workingDir}`);
    if (body.isolation) targetParts.push(`isolation=${body.isolation}`);
    if (targetParts.length > 0) {
      process.stdout.write(`◆ target: ${targetParts.join(" ")}\n`);
    }
    process.stdout.write(`▶ run ${runId.slice(0, 8)} (${name})\n`);
  }

  // Always attach the WS so we can wait for the terminal status — the CLI's
  // contract is that exit code reflects the run's outcome, so even
  // --no-watch can't exit until run_done arrives. In --no-watch mode we
  // just suppress per-event human output (and skip the events array in the
  // JSON envelope) so scripted callers get a single concise envelope at
  // the end instead of a stream.
  const frames: WorkflowFrame[] = [];
  let terminalStatus: string | null = null;
  await attachRun({
    baseUrl,
    runId,
    onFrame: (frame) => {
      if (watch) frames.push(frame);
      if (frame.type === "run_done") terminalStatus = frame.status;
      if (watch && !json && frame.type !== "run_started") {
        const line = formatWorkflowFrame(frame);
        if (line) process.stdout.write(`${line}\n`);
      }
    },
  });
  if (terminalStatus === null) {
    // The WS closed before a run_done arrived — server restart, network
    // blip, or the runId being purged from the store. Don't silently emit
    // `ok: true, status: null`; scripted callers would misread that as
    // completion. Surface a transport error and let them retry.
    emit(
      {
        error: `workflow run ${runId} ended without a terminal frame (server unreachable mid-run?)`,
        code: "WS_NO_TERMINAL",
      },
      { json },
    );
    process.exit(EXIT_FAIL);
  }
  if (json) {
    emit(
      {
        data: {
          runId,
          mode: "http",
          status: terminalStatus,
          ...(watch ? { events: frames } : {}),
        },
      },
      { json },
    );
  }
  process.exit(terminalStatus === "succeeded" ? EXIT_OK : EXIT_FAIL);
}

async function runInProcess(
  name: string,
  inputs: Record<string, string>,
  opts: WorkflowRunOptions,
  watch: boolean,
): Promise<never> {
  // Mirror the HTTP path: only buffer events when --watch is on. Long
  // prompt workflows emit many node_chunk frames, and a --no-watch
  // scripted caller doesn't want them in the envelope.
  const events: RunStreamEvent[] = [];
  // In-process has no project store to consult, so --project is a no-op
  // here; --working-dir wins, falling back to the invoking process's cwd.
  // The HTTP path is where named projects resolve.
  const rawCwd = opts.workingDir ?? process.cwd();
  const cwd = isAbsolute(rawCwd) ? rawCwd : resolve(process.cwd(), rawCwd);
  // Map the boolean CLI flag onto the three-state isolation directive the
  // headless runner expects. `undefined` falls through to the workflow YAML.
  const isolation: "worktree" | "none" | "auto" =
    opts.worktree === true ? "worktree" : opts.worktree === false ? "none" : "auto";
  try {
    const result = await runHeadless({
      name,
      inputs,
      cwd,
      provider: opts.provider,
      isolation,
      onEvent: (ev) => {
        if (watch) events.push(ev);
        if (!opts.json && watch) {
          const line = formatHumanEvent(ev);
          if (line) process.stdout.write(`${line}\n`);
        }
      },
    });
    if (opts.json) {
      emit(
        {
          data: {
            runId: result.runId,
            mode: "in-process",
            status: result.summary.status,
            summary: result.summary,
            ...(watch ? { events } : {}),
          },
        },
        { json: true },
      );
    }
    process.exit(result.summary.status === "succeeded" ? EXIT_OK : EXIT_FAIL);
  } catch (err) {
    if (err instanceof WorkflowNotFoundError) {
      emit({ error: err.message, code: "WORKFLOW_NOT_FOUND" }, { json: opts.json });
      process.exit(EXIT_NOT_FOUND);
    }
    if (err instanceof MemoryRequiresServerError) {
      emit({ error: err.message, code: "NO_SERVER" }, { json: opts.json });
      process.exit(EXIT_NO_SERVER);
    }
    // Headless setup errors (unknown provider, fixture parse failures, etc.)
    // must still produce a JSON envelope in --json mode. Rethrowing would
    // leak an unstructured Bun stack trace, breaking the machine-readable
    // contract operators are scripting against.
    const message = err instanceof Error ? err.message : String(err);
    emit({ error: message, code: "RUN_FAILED" }, { json: opts.json });
    process.exit(EXIT_FAIL);
  }
}

export async function runWorkflowRun(name: string, opts: WorkflowRunOptions): Promise<never> {
  let inputs: Record<string, string>;
  try {
    inputs = parseInputs(opts.inputs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Malformed `--inputs` is a usage error — exit 2, not 1, so scripts
    // can distinguish "bad invocation" from "workflow failed at runtime".
    emit({ error: message, code: "BAD_INPUTS" }, { json: opts.json });
    process.exit(EXIT_BAD_ARGS);
  }

  const watch = resolveWatch(opts);
  const baseUrl = opts.baseUrl;
  const info = baseUrl ? null : await probeServer();
  const effectiveBase = baseUrl ?? info?.baseUrl;

  if (effectiveBase) {
    try {
      // When neither --project nor --working-dir is given, send process.cwd()
      // so the server's "projectId or workingDir is required" gate doesn't
      // reject the call — mirrors the in-process default and preserves the
      // pre-projects behavior of "run against my shell's cwd".
      // Resolve --working-dir to an absolute path relative to the *CLI's*
      // shell cwd, not the long-running server's cwd. Without this, a user
      // invoking `keelson workflow run foo --working-dir .` over HTTP would
      // pin the run to whatever directory `keelson service` was launched in.
      const rawCwd = opts.workingDir ?? (opts.project ? undefined : process.cwd());
      const cwd =
        rawCwd === undefined
          ? undefined
          : isAbsolute(rawCwd)
            ? rawCwd
            : resolve(process.cwd(), rawCwd);
      const isolation =
        opts.worktree === true ? "worktree" : opts.worktree === false ? "none" : undefined;
      return await runViaHttp(name, inputs, effectiveBase, watch, opts.json, {
        ...(opts.project !== undefined ? { project: opts.project } : {}),
        ...(cwd !== undefined ? { workingDir: cwd } : {}),
        ...(isolation !== undefined ? { isolation } : {}),
      });
    } catch (err) {
      if (err instanceof ProjectNotFoundError) {
        emit({ error: err.message, code: "PROJECT_NOT_FOUND" }, { json: opts.json });
        process.exit(EXIT_NOT_FOUND);
      }
      if (err instanceof HttpError && err.status === 404) {
        emit({ error: err.message, code: "WORKFLOW_NOT_FOUND" }, { json: opts.json });
        process.exit(EXIT_NOT_FOUND);
      }
      if (isServerDownError(err)) {
        // Explicit --base-url was given but unreachable. Don't silently
        // downgrade to in-process — the operator picked HTTP for a reason
        // (e.g. wanted the SPA to observe the run). Surface NO_SERVER so
        // scripted callers can decide whether to retry or pivot.
        emit(
          {
            error: `server at ${effectiveBase} is not reachable`,
            code: "NO_SERVER",
          },
          { json: opts.json },
        );
        process.exit(EXIT_NO_SERVER);
      }
      const message = err instanceof Error ? err.message : String(err);
      emit({ error: message, code: "RUN_FAILED" }, { json: opts.json });
      process.exit(EXIT_FAIL);
    }
  }

  // Named projects only exist in the server catalog. If the operator picked
  // one explicitly and we got here (server down + no --base-url), the
  // in-process path would silently target `process.cwd()` — the wrong tree
  // for a mutating workflow. Surface NO_SERVER so scripted callers retry
  // instead of trampling the caller's shell directory.
  if (opts.project !== undefined) {
    emit(
      {
        error: `--project '${opts.project}' requires the server (start \`keelson service\`)`,
        code: "NO_SERVER",
      },
      { json: opts.json },
    );
    process.exit(EXIT_NO_SERVER);
  }

  return await runInProcess(name, inputs, opts, watch);
}
