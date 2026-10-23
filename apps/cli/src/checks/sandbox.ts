// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { collectSandboxStatus, type SandboxStatusDeps } from "../commands/sandbox.ts";
import type { CategoryResult, CheckResult } from "./types.ts";

export type SandboxDeps = SandboxStatusDeps;

// Unavailable is a failure only when the sandbox is on: sandboxed turns and
// nodes would fail closed. With it off, it is a heads-up.
export async function runSandboxCheck(deps: SandboxDeps = {}): Promise<CategoryResult> {
  const status = await collectSandboxStatus(deps);
  const on = status.floor || status.default;
  const checks: CheckResult[] = [
    {
      name: "mode",
      status: "ok",
      detail: status.floor
        ? "required (KEELSON_SANDBOX=required)"
        : on
          ? "on by default"
          : "off by default",
    },
  ];
  if (!status.executor.ok) {
    checks.push({
      name: "runtime",
      status: on ? "fail" : "warn",
      detail: status.executor.reason,
      hint: status.executor.installHint,
    });
  } else {
    const version = status.executor.version ? ` ${status.executor.version}` : "";
    checks.push({
      name: "runtime",
      status: "ok",
      detail: `seatbelt via ${status.executor.path}${version}`,
    });
    checks.push(
      status.probe?.ok === false
        ? {
            name: "probe",
            status: on ? "fail" : "warn",
            detail: status.probe.detail,
            hint: "reinstall with `keelson sandbox install`",
          }
        : { name: "probe", status: "ok", detail: "dry run passed" },
    );
  }
  return { category: "sandbox", checks };
}
