// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// Generic pending-approval registry — the round-trip an `ask` policy decision
// rides. It generalizes the workflow `approval` handler's pause/resume into a
// surface-agnostic store keyed by a fresh id per pause, so chat, rib, and
// workflow `prompt` turns can all pause a tool call for human approval. The
// policy engine opens a pause via `request`; the snapshot WS publishes the open
// set (redacted) and POST /api/approvals/:id resolves one via `resolve`.

import type { ApprovalDecision, ApprovalRequest, PendingApprovalView } from "@keelson/shared";

export interface ApprovalRegistryOptions {
  // Fired after every add/resolve so the composition root can recompose the
  // POLICY_APPROVALS_SNAPSHOT_KEY frame; a throwing hook never breaks a settle.
  onChange?: () => void;
  // How long an unanswered approval stays open before it auto-rejects (deny).
  // <= 0 disables the timer. Default 5 minutes — a backstop so an abandoned
  // prompt can't pin a turn forever.
  timeoutMs?: number;
}

export interface ApprovalRegistry {
  // Open a pending approval; resolves when a human accepts/rejects, the timeout
  // elapses, or `signal` aborts. NEVER rejects the returned promise — callers
  // get a decision either way and fail closed on anything but "accept", so a
  // torn-down turn (abort) or an abandoned prompt (timeout) both deny.
  request(req: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision>;
  // Resolve an open approval by id. Returns false when the id is unknown
  // (already settled, timed out, or never existed) so the route maps it to 404.
  resolve(id: string, decision: ApprovalDecision): boolean;
  // The open approvals as redacted views (no tool args), oldest-first.
  list(): PendingApprovalView[];
  // Reject every open approval — server shutdown / test teardown.
  clear(): void;
}

interface Entry {
  view: PendingApprovalView;
  settle: (decision: ApprovalDecision) => void;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export function createApprovalRegistry(opts: ApprovalRegistryOptions = {}): ApprovalRegistry {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const entries = new Map<string, Entry>();

  const notify = (): void => {
    try {
      opts.onChange?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[approvals] onChange hook threw: ${msg}`);
    }
  };

  return {
    request(req, signal) {
      // A turn that was already cancelled before the gate opened denies without
      // ever surfacing a prompt nobody could answer.
      if (signal?.aborted) return Promise.resolve("reject");

      const id = crypto.randomUUID();
      const view: PendingApprovalView = {
        id,
        surface: req.surface,
        policyId: req.policyId,
        reason: req.reason,
        createdAt: new Date().toISOString(),
        ...(req.tool !== undefined ? { tool: req.tool } : {}),
        ...(req.ribId !== undefined ? { ribId: req.ribId } : {}),
        ...(req.provider !== undefined ? { provider: req.provider } : {}),
      };

      return new Promise<ApprovalDecision>((resolvePromise) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onAbort = (): void => settle("reject");
        // Single-shot: delete from the map FIRST so a racing timeout/abort/
        // resolve can't double-settle, then tear down listeners and resolve.
        const settle = (decision: ApprovalDecision): void => {
          if (!entries.has(id)) return;
          entries.delete(id);
          if (timer !== undefined) clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          notify();
          resolvePromise(decision);
        };

        entries.set(id, { view, settle });
        if (timeoutMs > 0) {
          timer = setTimeout(() => settle("reject"), timeoutMs);
          // Don't let an open prompt keep the process alive on shutdown.
          (timer as { unref?: () => void }).unref?.();
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        notify();
      });
    },

    resolve(id, decision) {
      const entry = entries.get(id);
      if (!entry) return false;
      entry.settle(decision);
      return true;
    },

    list() {
      return [...entries.values()].map((e) => e.view);
    },

    clear() {
      // Snapshot the entries first: settle mutates the map mid-iteration.
      for (const entry of [...entries.values()]) entry.settle("reject");
    },
  };
}
