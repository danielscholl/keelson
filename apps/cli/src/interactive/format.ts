// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import type { TokenUsage } from "@keelson/shared";

export function relativeAge(iso: string, now: Date = new Date()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";
  const seconds = Math.max(0, Math.floor((now.getTime() - then) / 1000));
  if (seconds < 90) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, "")}k`;
  }
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

// Two-measures display: context fill (`12%/200k`) when the provider reports
// a window, else cumulative spend (`↑1.2k ↓340`), else a placeholder.
export function formatUsageMeter(
  latest: TokenUsage | undefined,
  cumulative: { input: number; output: number },
): string {
  if (latest?.contextTokens !== undefined && latest.contextWindow !== undefined) {
    const pct = Math.min(100, Math.round((latest.contextTokens / latest.contextWindow) * 100));
    return `${pct}%/${formatTokens(latest.contextWindow)}`;
  }
  if (cumulative.input > 0 || cumulative.output > 0) {
    return `↑${formatTokens(cumulative.input)} ↓${formatTokens(cumulative.output)}`;
  }
  return "—";
}

// Catalog descriptions follow the multi-sentence "Use when / Triggers / Does /
// NOT for" convention; listings keep only the lead clause.
export function firstClause(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const sentence = /^(.*?[.!?])\s/.exec(flat)?.[1] ?? flat;
  return sentence.length <= max ? sentence : `${sentence.slice(0, max - 1)}…`;
}

export interface ParsedSlashCommand {
  name: string;
  arg: string;
}

export function parseSlashCommand(text: string): ParsedSlashCommand | null {
  const m = /^\/([a-z][a-z0-9-]*)(?:\s+(.*))?$/.exec(text.trim());
  if (!m?.[1]) return null;
  return { name: m[1], arg: (m[2] ?? "").trim() };
}

// `k=v` tokens after the workflow name become run inputs; the rest of the
// tokens must be the name itself.
export function parseRunArg(arg: string): { name: string; inputs: Record<string, string> } | null {
  const tokens = arg.split(/\s+/).filter((t) => t.length > 0);
  const name = tokens.shift();
  if (name === undefined) return null;
  const inputs: Record<string, string> = {};
  for (const token of tokens) {
    const eq = token.indexOf("=");
    if (eq <= 0) return null;
    inputs[token.slice(0, eq)] = token.slice(eq + 1);
  }
  return { name, inputs };
}
