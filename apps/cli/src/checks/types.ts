// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export type CheckCategory = "toolchain" | "server" | "db" | "auth" | "workflows";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
  hint?: string;
}

export interface CategoryResult {
  category: CheckCategory;
  checks: CheckResult[];
}

export interface DoctorSummary {
  ok: number;
  warn: number;
  fail: number;
  skip: number;
  total: number;
}

export interface DoctorReport {
  categories: CategoryResult[];
  summary: DoctorSummary;
  strict: boolean;
}

export function tally(categories: readonly CategoryResult[]): DoctorSummary {
  const summary: DoctorSummary = { ok: 0, warn: 0, fail: 0, skip: 0, total: 0 };
  for (const cat of categories) {
    for (const c of cat.checks) {
      summary[c.status] += 1;
      summary.total += 1;
    }
  }
  return summary;
}
