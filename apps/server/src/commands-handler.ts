// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import {
  type CommandCompletion,
  type CommandInvokeResult,
  type CommandRef,
  commandCompletionSchema,
  commandInvokeResultSchema,
  listCommandCompletionsResponseSchema,
  listCommandsResponseSchema,
  type RibCommandDescriptor,
  ribCommandDescriptorSchema,
} from "@keelson/shared";
import type { Hono } from "hono";

export interface CommandsRoutesDeps {
  commandListers: Map<string, () => Promise<readonly RibCommandDescriptor[]>>;
  commandInvokers: Map<string, (name: string, arg: string) => Promise<CommandInvokeResult>>;
  commandCompleters: Map<
    string,
    (name: string, prefix: string) => Promise<readonly CommandCompletion[]>
  >;
}

// GET /api/commands + GET /api/commands/:ribId/:name/complete + POST .../invoke.
// The aggregated list is what each chat surface merges with its base commands
// (workflow / project / session) to build the slash menu; invoke runs one
// server-side and returns a closed CommandEffect the surface performs. List +
// complete are read-only (no origin guard, matching GET /api/ribs); a failing rib
// degrades to zero rather than blanking the menu.
export function commandsRoutes(app: Hono, deps: CommandsRoutesDeps): void {
  const { commandListers, commandInvokers, commandCompleters } = deps;

  app.get("/api/commands", async (c) => {
    const lists = await Promise.all(
      [...commandListers.entries()].map(async ([ribId, lister]): Promise<CommandRef[]> => {
        try {
          const commands = await lister();
          const refs: CommandRef[] = [];
          for (const cmd of commands) {
            // Validate each descriptor; one malformed command is dropped, not fatal.
            const parsed = ribCommandDescriptorSchema.safeParse(cmd);
            if (parsed.success) refs.push({ ...parsed.data, ribId });
          }
          return refs;
        } catch {
          return [];
        }
      }),
    );
    // Dedupe by name across ribs — first registered wins, so a later rib can't
    // shadow an earlier rib's command (mirrors the global tool-name rule).
    const seen = new Set<string>();
    const commands: CommandRef[] = [];
    for (const ref of lists.flat()) {
      if (seen.has(ref.name)) continue;
      seen.add(ref.name);
      commands.push(ref);
    }
    return c.json(listCommandsResponseSchema.parse({ commands }));
  });

  app.get("/api/commands/:ribId/:name/complete", async (c) => {
    const completer = commandCompleters.get(c.req.param("ribId"));
    if (!completer) return c.json(listCommandCompletionsResponseSchema.parse({ completions: [] }));
    try {
      const raw = await completer(c.req.param("name"), c.req.query("prefix") ?? "");
      const completions: CommandCompletion[] = [];
      for (const item of raw) {
        const parsed = commandCompletionSchema.safeParse(item);
        if (parsed.success) completions.push(parsed.data);
      }
      return c.json(listCommandCompletionsResponseSchema.parse({ completions }));
    } catch {
      return c.json(listCommandCompletionsResponseSchema.parse({ completions: [] }));
    }
  });

  app.post("/api/commands/:ribId/:name/invoke", async (c) => {
    const invoker = commandInvokers.get(c.req.param("ribId"));
    if (!invoker) return c.json({ error: "rib has no commands" }, 404);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const rawArg = (body as { arg?: unknown } | null)?.arg;
    const arg = typeof rawArg === "string" ? rawArg : "";
    let result: CommandInvokeResult;
    try {
      result = await invoker(c.req.param("name"), arg);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
    const parsed = commandInvokeResultSchema.safeParse(result);
    if (!parsed.success) return c.json({ error: "rib returned a malformed command result" }, 500);
    // A rib-level failure ({ ok: false }) is still a 200 — the surface renders the
    // error inline; only a malformed or throwing rib is a 5xx.
    return c.json(parsed.data);
  });
}
