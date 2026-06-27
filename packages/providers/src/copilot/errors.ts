// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// Classify the raw SDK or HTTP-shaped message into a short, action-oriented
// sentence. The raw message is preserved on fallback so unfamiliar failures
// aren't masked.

export function buildFriendlyCopilotError(err: unknown, hint?: string): string {
  const raw = extractRawMessage(err);
  const lower = raw.toLowerCase();

  if (
    lower.includes("unauthorized") ||
    lower.includes("401") ||
    lower.includes("invalid token") ||
    lower.includes("authentication") ||
    lower.includes("auth failed") ||
    lower.includes("not logged in") ||
    lower.includes("no auth")
  ) {
    return "Copilot authentication failed. Run `copilot auth login` in a terminal, or sign in with a paste token via the Chat panel. If you were already signed in, the credential may have expired.";
  }
  if (
    lower.includes("forbidden") ||
    lower.includes("403") ||
    lower.includes("not entitled") ||
    lower.includes("subscription")
  ) {
    return "Copilot rejected the request. Your account may not be entitled to this model or feature.";
  }
  if (
    lower.includes("rate limit") ||
    lower.includes("rate_limit") ||
    lower.includes("429") ||
    lower.includes("quota")
  ) {
    return "Copilot rate limit or quota exceeded. Try again in a moment.";
  }
  if (
    lower.includes("econnrefused") ||
    lower.includes("etimedout") ||
    lower.includes("network") ||
    lower.includes("fetch failed")
  ) {
    return `Copilot network error: ${raw}`;
  }
  if (lower.includes("module not found") || lower.includes("cannot find module")) {
    return "Copilot SDK is not installed. Run `bun install` to fetch it.";
  }

  return hint ? `Copilot error: ${raw} (${hint})` : `Copilot error: ${raw}`;
}

// Distinguishes a wedged/dead subprocess or broken transport — failures a
// fresh respawn can plausibly clear — from auth/rate-limit/entitlement
// failures, which respawning the same credentials would only repeat. The warm
// client uses this to decide whether to drop and retry on a fresh subprocess.
export function isCopilotConnectionError(err: unknown): boolean {
  const lower = extractRawMessage(err).toLowerCase();
  return (
    lower.includes("not connected") ||
    lower.includes("disconnect") ||
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("etimedout") ||
    lower.includes("epipe") ||
    lower.includes("socket hang up") ||
    lower.includes("socket closed") ||
    lower.includes("broken pipe") ||
    lower.includes("runtime shutdown") ||
    lower.includes("process exited") ||
    lower.includes("worker exited")
  );
}

function extractRawMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(err);
}
