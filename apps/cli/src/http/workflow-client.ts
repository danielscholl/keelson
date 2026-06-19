// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import type { ListWorkflowsResponse, WorkflowFrame } from "@keelson/shared";
import { normalizeBase, originHeader } from "./base.ts";

export type { ListWorkflowsResponse, WorkflowSummary } from "@keelson/shared";

export interface StartRunResponse {
  runId: string;
}

export interface WorkflowRunSummary {
  runId: string;
  workflowName: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
  conversationId: string | null;
}

export interface ListRunsResponse {
  runs: WorkflowRunSummary[];
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

// Bun's `fetch` / `WebSocket` report a closed/unused TCP port with several
// codes depending on context — collapse them all to a single "server is
// down" signal so every CLI command can branch uniformly.
const SERVER_DOWN_CODES: ReadonlySet<string> = new Set([
  "ConnectionRefused",
  "ECONNREFUSED",
  "FailedToOpenSocket",
  "ConnectionClosed",
  "ECONNRESET",
]);

export function isServerDownError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && SERVER_DOWN_CODES.has(code)) return true;
  const cause = (err as { cause?: unknown }).cause;
  if (cause && typeof cause === "object" && "code" in cause) {
    const causeCode = (cause as { code?: unknown }).code;
    return typeof causeCode === "string" && SERVER_DOWN_CODES.has(causeCode);
  }
  return false;
}

function url(baseUrl: string, path: string): string {
  return `${normalizeBase(baseUrl)}${path}`;
}

function defaultHeaders(baseUrl: string): Record<string, string> {
  return {
    accept: "application/json",
    origin: originHeader(baseUrl),
  };
}

export async function listWorkflows(baseUrl: string): Promise<ListWorkflowsResponse> {
  const res = await fetch(url(baseUrl, "/api/workflows"), { headers: defaultHeaders(baseUrl) });
  if (!res.ok) throw new HttpError(res.status, `GET /api/workflows failed: ${res.status}`);
  return (await res.json()) as ListWorkflowsResponse;
}

export async function listPersistedWorktreePaths(baseUrl: string): Promise<string[]> {
  const res = await fetch(url(baseUrl, "/api/workflows/worktree-paths"), {
    headers: defaultHeaders(baseUrl),
  });
  if (!res.ok) {
    throw new HttpError(res.status, `GET /api/workflows/worktree-paths failed: ${res.status}`);
  }
  const body = (await res.json()) as { paths?: unknown };
  if (!Array.isArray(body.paths)) return [];
  return body.paths.filter((p): p is string => typeof p === "string");
}

export interface StartRunBody {
  inputs: Record<string, string>;
  projectId?: string;
  workingDir?: string;
  isolation?: "worktree" | "none";
}

export async function startRun(
  baseUrl: string,
  name: string,
  body: StartRunBody,
): Promise<StartRunResponse> {
  const res = await fetch(url(baseUrl, `/api/workflows/${encodeURIComponent(name)}/runs`), {
    method: "POST",
    headers: { ...defaultHeaders(baseUrl), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new HttpError(
      res.status,
      `POST /workflows/${name}/runs failed: ${res.status} ${errBody}`,
    );
  }
  return (await res.json()) as StartRunResponse;
}

export async function getRun(baseUrl: string, runId: string): Promise<unknown> {
  const res = await fetch(url(baseUrl, `/api/workflows/runs/${encodeURIComponent(runId)}`), {
    headers: defaultHeaders(baseUrl),
  });
  if (res.status === 404) throw new HttpError(404, `run '${runId}' not found`);
  if (!res.ok)
    throw new HttpError(res.status, `GET /workflows/runs/${runId} failed: ${res.status}`);
  return await res.json();
}

export type RunRefResolution = { runId: string } | { error: string; ambiguous: boolean };

// `workflow run --watch` prints the run id abbreviated to its first 8 chars
// (runId.slice(0, 8)), so `status` / `respond` accept that abbreviation
// git-style: an exact id wins, otherwise a prefix that uniquely identifies one
// run resolves to its full id. A prefix matching several runs is rejected
// (caller asks for more characters) rather than answering the wrong run.
// Transport / unexpected-status failures throw (so callers' server-down
// handling still fires); only the resolution outcomes are returned.
export async function resolveRunRef(baseUrl: string, ref: string): Promise<RunRefResolution> {
  // Exact id is the common case (a full UUID, or one copied from the SPA) and
  // is correct even for a run older than the prefix scan's feed window below.
  const exact = await fetch(url(baseUrl, `/api/workflows/runs/${encodeURIComponent(ref)}`), {
    headers: defaultHeaders(baseUrl),
  });
  if (exact.ok) return { runId: ref };
  if (exact.status !== 404) {
    throw new HttpError(exact.status, `resolve run '${ref}' failed: ${exact.status}`);
  }
  // Prefix fallback: scan the run feed (newest first) for ids starting with the
  // abbreviation. The feed is capped, but a run you are answering is recent —
  // it was just printed by the watch stream.
  const res = await fetch(url(baseUrl, "/api/workflows/runs?limit=1000"), {
    headers: defaultHeaders(baseUrl),
  });
  if (!res.ok) throw new HttpError(res.status, `resolve run '${ref}' failed: ${res.status}`);
  const body = (await res.json()) as { runs?: Array<{ runId?: unknown }> };
  const matches = (body.runs ?? [])
    .map((r) => (typeof r.runId === "string" ? r.runId : ""))
    .filter((id) => id.startsWith(ref));
  const [first] = matches;
  if (matches.length === 1 && first) return { runId: first };
  if (matches.length === 0) return { error: `run '${ref}' not found`, ambiguous: false };
  const shown = matches.slice(0, 4).map((id) => id.slice(0, 12));
  return {
    error: `run id '${ref}' is ambiguous — ${matches.length} runs match (${shown.join(", ")}${
      matches.length > shown.length ? ", …" : ""
    }); use more characters`,
    ambiguous: true,
  };
}

export async function listRunsByName(
  baseUrl: string,
  workflowName: string,
): Promise<ListRunsResponse> {
  const res = await fetch(url(baseUrl, `/api/workflows/${encodeURIComponent(workflowName)}/runs`), {
    headers: defaultHeaders(baseUrl),
  });
  if (!res.ok)
    throw new HttpError(res.status, `GET /workflows/${workflowName}/runs failed: ${res.status}`);
  return (await res.json()) as ListRunsResponse;
}

export async function listPausedRuns(baseUrl: string): Promise<ListRunsResponse> {
  const res = await fetch(url(baseUrl, "/api/workflows/runs?status=paused"), {
    headers: defaultHeaders(baseUrl),
  });
  if (!res.ok)
    throw new HttpError(res.status, `GET /workflows/runs?status=paused failed: ${res.status}`);
  return (await res.json()) as ListRunsResponse;
}

export async function resumeRun(
  baseUrl: string,
  runId: string,
  body: { nodeId: string; text: string; pauseId?: string },
): Promise<void> {
  const payload =
    body.pauseId !== undefined
      ? { nodeId: body.nodeId, text: body.text, pauseId: body.pauseId }
      : { nodeId: body.nodeId, text: body.text };
  const res = await fetch(url(baseUrl, `/api/workflows/runs/${encodeURIComponent(runId)}/resume`), {
    method: "POST",
    headers: { ...defaultHeaders(baseUrl), "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (res.status === 404) throw new HttpError(404, `run '${runId}' not found or already terminal`);
  if (res.status === 409) {
    const detail = await res.text().catch(() => "");
    throw new HttpError(
      409,
      `no pending approval for node '${body.nodeId}'${detail ? `: ${detail}` : ""}`,
    );
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new HttpError(
      res.status,
      `POST /workflows/runs/${runId}/resume failed: ${res.status} ${detail}`,
    );
  }
}

export interface AttachRunOptions {
  baseUrl: string;
  runId: string;
  onFrame: (frame: WorkflowFrame) => void;
  signal?: AbortSignal;
}

// Open the per-run WebSocket and forward parsed frames until the server
// emits a terminal `run_done` (the server closes the socket on terminal).
// Resolves on close; rejects on socket error or invalid envelope.
export function attachRun(opts: AttachRunOptions): Promise<void> {
  const wsUrl = `${normalizeBase(opts.baseUrl).replace(/^http/, "ws")}/api/workflows/runs/${encodeURIComponent(opts.runId)}/ws`;
  return new Promise((resolve, reject) => {
    // Same origin-gating as the HTTP routes — the server's
    // handleWorkflowRunUpgrade rejects sockets without a loopback Origin.
    // Bun's WebSocket constructor accepts a non-standard `headers` option
    // (Bun.WebSocketOptions) that the standard `WebSocket` typings don't
    // model, so we satisfy TS by widening to the constructor's argument.
    const WS = WebSocket as unknown as new (
      url: string,
      options?: { headers?: Record<string, string> },
    ) => WebSocket;
    const ws = new WS(wsUrl, { headers: { origin: originHeader(opts.baseUrl) } });
    const cleanup = () => {
      opts.signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      try {
        ws.close(1000, "client abort");
      } catch {
        // ignore
      }
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    ws.addEventListener("message", (ev) => {
      try {
        const data = JSON.parse(String(ev.data)) as WorkflowFrame;
        opts.onFrame(data);
      } catch (err) {
        cleanup();
        try {
          ws.close(1003, "bad frame");
        } catch {
          // ignore
        }
        reject(err);
      }
    });
    ws.addEventListener("close", () => {
      cleanup();
      resolve();
    });
    ws.addEventListener("error", (ev) => {
      cleanup();
      const message = ev instanceof ErrorEvent ? ev.message : "websocket error";
      reject(new Error(message));
    });
  });
}
