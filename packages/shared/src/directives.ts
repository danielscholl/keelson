// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// Named prompt directives the harness owns. The chat system prompt injects a
// subset and workflow prompt nodes reference them as `$DIRECTIVES.<name>`.
// `@keelson/workflows` mirrors the record verbatim to keep its dep graph free;
// `test/wire-mirrors.test.ts` guards the two copies against drift.

import { z } from "zod";

export const DIRECTIVES = Object.freeze({
  verify:
    "When you change code that can be run, built, or type-checked, run a real check that exercises the change before reporting it done: the project's tests, type-checker, or build, or the changed command itself.",
  continue:
    "When a step doesn't need the operator's input, keep going, and put status notes in the same message as your next action. Stop and ask only when you can't continue without them, or before anything destructive: deleting data, force-pushing, or changing anything outside this repository.",
  confirm: "Mark anything you couldn't confirm, and say where you looked.",
  review:
    "List only problems you'd block the merge for. For each one, give the file and line, why it's wrong, and how to show it fails.",
} as const);

export type DirectiveName = keyof typeof DIRECTIVES;

export const DIRECTIVE_NAMES = Object.freeze(Object.keys(DIRECTIVES) as DirectiveName[]);

export const directiveNameSchema = z.enum(["verify", "continue", "confirm", "review"]);

export function renderDirectives(names: readonly DirectiveName[]): string {
  return names.map((name) => DIRECTIVES[name]).join("\n\n");
}
