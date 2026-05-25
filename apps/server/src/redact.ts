// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

// Log redaction. While runWithRedaction's scope is active, any console.*
// call containing a matching substring is rewritten to [REDACTED]. Only
// console.{log,warn,error,info,debug} are covered — bypassing routes need
// to come through console or be added here.

import { AsyncLocalStorage } from "node:async_hooks";

interface RedactionContext {
  values: string[];
}

const als = new AsyncLocalStorage<RedactionContext>();

// `fn` runs with the redaction context active. Async work that awaits inside
// `fn` inherits the same context (this is the load-bearing AsyncLocalStorage
// guarantee), so the wrap survives `await c.json(...)` and friends.
export function runWithRedaction<T>(
  values: readonly string[],
  fn: () => T,
): T {
  const filtered = values.filter((v) => typeof v === "string" && v.length > 0);
  return als.run({ values: filtered }, fn);
}

const REDACTED = "[REDACTED]";

// Pure helper, exported for testing. Replaces every occurrence of every
// non-empty value with `[REDACTED]`. Non-string args pass through unchanged
// — we intentionally do NOT recurse into objects (a redactor that walks
// into errors / circulars is a denial-of-service risk; the route handler is
// responsible for not logging secret-bearing objects in the first place).
export function scrubArg(arg: unknown, values: readonly string[]): unknown {
  if (typeof arg !== "string" || values.length === 0) return arg;
  let out = arg;
  for (const v of values) {
    if (typeof v !== "string" || v.length === 0) continue;
    out = out.split(v).join(REDACTED);
  }
  return out;
}

type ConsoleMethod = "log" | "warn" | "error" | "info" | "debug";
const METHODS: readonly ConsoleMethod[] = [
  "log",
  "warn",
  "error",
  "info",
  "debug",
] as const;

const INSTALLED_MARKER = "__keelsonRedactInstalled" as const;

type ConsoleLike = Pick<Console, ConsoleMethod> & {
  [INSTALLED_MARKER]?: boolean;
};

// Wraps `target`'s console methods in-place. Idempotent: re-wrapping a target
// already wrapped by this function is a no-op (the install marker is the
// guard). Pure helper exported for tests so they can install on a fake target
// without disturbing the global console.
export function wrapConsole(target: ConsoleLike): void {
  if (target[INSTALLED_MARKER]) return;
  for (const m of METHODS) {
    const original = target[m].bind(target);
    const wrapped = (...args: unknown[]): void => {
      const store = als.getStore();
      if (!store) {
        original(...args);
        return;
      }
      original(...args.map((a) => scrubArg(a, store.values)));
    };
    target[m] = wrapped as ConsoleLike[ConsoleMethod];
  }
  Object.defineProperty(target, INSTALLED_MARKER, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

// Production entrypoint: wraps the global console. Call once at module load
// before anything else runs that might log a value the route handler will
// later place into a redaction scope.
export function installRedactedConsole(): void {
  wrapConsole(globalThis.console as ConsoleLike);
}
