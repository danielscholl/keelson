// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { z } from "zod";
import { ribIdSchema } from "./rib.ts";

// A slash command a rib contributes to the chat composer's slash menu, surfaced
// at GET /api/commands. `name` rides a `/<name>` affordance (lowercase kebab, so
// it stays slash-safe). `argument`, when set, describes the single positional
// argument for type-ahead; `completes` means the rib serves completions for it
// via `completeCommand`. Static metadata — the surfaces merge these with their
// own base commands (workflow / project / session) into one menu.
export const ribCommandDescriptorSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9-]*$/, "command name must be lowercase kebab-case"),
    description: z.string().min(1).max(280),
    argument: z
      .object({
        hint: z.string().min(1).max(64),
        completes: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type RibCommandDescriptor = z.infer<typeof ribCommandDescriptorSchema>;

// The aggregated wire shape from GET /api/commands — each descriptor namespaced
// with its owning rib so the surface routes invoke/complete back and can
// disambiguate a name two ribs both expose.
export const commandRefSchema = ribCommandDescriptorSchema.extend({ ribId: ribIdSchema }).strict();
export type CommandRef = z.infer<typeof commandRefSchema>;

export const listCommandsResponseSchema = z
  .object({ commands: z.array(commandRefSchema) })
  .strict();
export type ListCommandsResponse = z.infer<typeof listCommandsResponseSchema>;

// What invoking a command does — a closed, fail-closed union the surface
// performs. `open-agent` opens one of the rib's agents as a seeded chat (the
// surface resolves the seed through the agents seam, GET /api/agents/.../resolve);
// `run-workflow` starts a catalog workflow with the typed argument as $ARGUMENTS;
// `message` renders inline markdown (the no-arg "list" case). New variants are
// non-breaking via the `effect` discriminator.
export const commandEffectSchema = z.discriminatedUnion("effect", [
  z.object({ effect: z.literal("message"), markdown: z.string().min(1).max(8000) }).strict(),
  z
    .object({
      effect: z.literal("open-agent"),
      ribId: ribIdSchema,
      slug: z.string().min(1).max(64),
    })
    .strict(),
  z
    .object({
      effect: z.literal("run-workflow"),
      workflow: z.string().min(1),
      args: z.string().optional(),
    })
    .strict(),
]);
export type CommandEffect = z.infer<typeof commandEffectSchema>;

// Result of POST /api/commands/:ribId/:name/invoke (and what a rib's
// `invokeCommand` returns). A success carries exactly one effect; a failure
// carries a message the surface renders inline.
export const commandInvokeResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), effect: commandEffectSchema }).strict(),
  z.object({ ok: z.literal(false), error: z.string() }).strict(),
]);
export type CommandInvokeResult = z.infer<typeof commandInvokeResultSchema>;

// One argument completion item for the type-ahead
// (GET /api/commands/:ribId/:name/complete?prefix=).
export const commandCompletionSchema = z
  .object({ value: z.string().min(1), description: z.string().optional() })
  .strict();
export type CommandCompletion = z.infer<typeof commandCompletionSchema>;

export const listCommandCompletionsResponseSchema = z
  .object({ completions: z.array(commandCompletionSchema) })
  .strict();
export type ListCommandCompletionsResponse = z.infer<typeof listCommandCompletionsResponseSchema>;
