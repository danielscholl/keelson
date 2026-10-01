// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { sha256 } from "./managed.ts";

// Key order is insertion order in JS, so two equal definitions built by
// different paths (YAML parse vs an in-memory literal) must be re-keyed
// before serializing or they would hash apart.
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    // Null prototype so a literal `__proto__` key lands as an own property
    // instead of silently rewriting the accumulator's prototype.
    const out: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue;
      out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}

export function canonicalWorkflowJson(definition: unknown): string {
  return JSON.stringify(canonicalize(definition));
}

export function workflowDefinitionHash(definition: unknown): string {
  return sha256(canonicalWorkflowJson(definition));
}

export const SHORT_DEFINITION_HASH_LENGTH = 16;

export function shortDefinitionHash(hash: string): string {
  return hash.slice(0, SHORT_DEFINITION_HASH_LENGTH);
}
