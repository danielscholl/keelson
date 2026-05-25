// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// Mirrors copilot/errors.ts buildFriendlyCopilotError. Classifies a raw SDK or
// HTTP-shaped message into a short, action-oriented sentence. The raw message
// is preserved on fallback so unfamiliar failures aren't masked.

export function buildFriendlyClaudeError(err: unknown, hint?: string): string {
  const raw = extractRawMessage(err);
  const lower = raw.toLowerCase();
  const detail = hint && hint.length > 0 ? ` (${hint})` : "";

  if (
    lower.includes("authentication_failed") ||
    lower.includes("invalid x-api-key") ||
    lower.includes("invalid api key") ||
    lower.includes("unauthorized") ||
    lower.includes("401") ||
    lower.includes("oauth_org_not_allowed")
  ) {
    return `Claude authentication failed. Run \`claude auth login\` in a terminal, or save an ANTHROPIC_API_KEY via the Chat panel.${detail}`;
  }
  if (lower.includes("forbidden") || lower.includes("403") || lower.includes("billing_error")) {
    return `Claude rejected the request. Your account may not have access to this model or feature.${detail}`;
  }
  if (
    lower.includes("rate_limit") ||
    lower.includes("rate limit") ||
    lower.includes("429") ||
    lower.includes("quota") ||
    lower.includes("overloaded") ||
    lower.includes("max_output_tokens")
  ) {
    return `Claude rate limit or quota exceeded. Try again in a moment.${detail}`;
  }
  if (
    lower.includes("error_max_turns") ||
    lower.includes("max_turns") ||
    lower.includes("error_max_budget_usd") ||
    lower.includes("max_budget") ||
    lower.includes("error_max_structured_output_retries")
  ) {
    return `Claude stopped before finishing: hit a configured turn or budget limit. Raise \`maxTurns\` / \`maxBudgetUsd\` or simplify the request.${detail}`;
  }
  if (lower.includes("invalid_request")) {
    return `Claude rejected the request shape. The model returned an invalid_request error; check the prompt or attached tools.${detail}`;
  }
  if (
    lower.includes("econnrefused") ||
    lower.includes("etimedout") ||
    lower.includes("network") ||
    lower.includes("fetch failed") ||
    lower.includes("server_error")
  ) {
    return `Claude network error: ${raw}${detail}`;
  }
  if (lower.includes("module not found") || lower.includes("cannot find module")) {
    return "Claude Agent SDK is not installed. Run `bun install` to fetch it.";
  }

  return `Claude error: ${raw}${detail}`;
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
