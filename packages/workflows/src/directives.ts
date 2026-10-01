// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

// Mirror of `DIRECTIVES` in `@keelson/shared/directives.ts`; intentionally
// duplicated rather than imported to keep this package's dep graph free (the
// shared package's wire-mirrors test guards the two copies against drift).
export const DIRECTIVES: Readonly<Record<string, string>> = Object.freeze({
  verify:
    "When you change code that can be run, built, or type-checked, run a real check that exercises the change before reporting it done: the project's tests, type-checker, or build, or the changed command itself.",
  continue:
    "When a step doesn't need the operator's input, keep going, and put status notes in the same message as your next action. Stop and ask only when you can't continue without them, or before anything destructive: deleting data, force-pushing, or changing anything outside this repository.",
  confirm: "Mark anything you couldn't confirm, and say where you looked.",
  review:
    "List only problems you'd block the merge for. For each one, give the file and line, why it's wrong, and how to show it fails.",
});

export const DIRECTIVE_NAMES: readonly string[] = Object.freeze(Object.keys(DIRECTIVES));

export function resolveDirective(name: string): string | undefined {
  return Object.hasOwn(DIRECTIVES, name) ? DIRECTIVES[name] : undefined;
}
