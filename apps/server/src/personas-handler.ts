// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import {
  listPersonasResponseSchema,
  type OpenChatSeed,
  openChatSeedSchema,
  type PersonaRef,
  type PersonaSummary,
  personaSummarySchema,
} from "@keelson/shared";
import type { Hono } from "hono";

export interface PersonasRoutesDeps {
  personaListers: Map<string, () => Promise<readonly PersonaSummary[]>>;
  personaResolvers: Map<string, (slug: string) => Promise<OpenChatSeed | null>>;
}

// GET /api/personas + POST /api/personas/:ribId/:slug/resolve. The aggregated
// list is the source for the `/mind` command across both chat surfaces; resolve
// lazily builds one persona's seed on selection. Read-only — no origin guard
// (matches GET /api/ribs); a failing rib degrades to zero personas rather than
// blanking the whole list.
export function personasRoutes(app: Hono, deps: PersonasRoutesDeps): void {
  const { personaListers, personaResolvers } = deps;

  app.get("/api/personas", async (c) => {
    const lists = await Promise.all(
      [...personaListers.entries()].map(async ([ribId, lister]): Promise<PersonaRef[]> => {
        try {
          const personas = await lister();
          const refs: PersonaRef[] = [];
          for (const p of personas) {
            // Validate each summary; one malformed persona is dropped, not fatal.
            const parsed = personaSummarySchema.safeParse(p);
            if (parsed.success) refs.push({ ...parsed.data, ribId });
          }
          return refs;
        } catch {
          return [];
        }
      }),
    );
    return c.json(listPersonasResponseSchema.parse({ personas: lists.flat() }));
  });

  app.post("/api/personas/:ribId/:slug/resolve", async (c) => {
    const ribId = c.req.param("ribId");
    const slug = c.req.param("slug");
    const resolver = personaResolvers.get(ribId);
    if (!resolver) return c.json({ error: "rib has no personas" }, 404);
    let seed: OpenChatSeed | null;
    try {
      seed = await resolver(slug);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
    if (!seed) return c.json({ error: `unknown persona: ${slug}` }, 404);
    const parsed = openChatSeedSchema.safeParse(seed);
    if (!parsed.success) return c.json({ error: "rib returned a malformed persona seed" }, 500);
    return c.json(parsed.data);
  });
}
