// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import {
  type AgentRef,
  type AgentSummary,
  agentSummarySchema,
  listAgentsResponseSchema,
  type OpenChatSeed,
  openChatSeedSchema,
} from "@keelson/shared";
import type { Hono } from "hono";

export interface AgentsRoutesDeps {
  agentListers: Map<string, () => Promise<readonly AgentSummary[]>>;
  agentResolvers: Map<string, (slug: string) => Promise<OpenChatSeed | null>>;
}

// GET /api/agents + POST /api/agents/:ribId/:slug/resolve. The aggregated list is
// the source a rib's slash command (e.g. chamber's /mind) reads to open an agent
// as a seeded chat; resolve lazily builds one agent's seed on selection. Read-only
// — no origin guard (matches GET /api/ribs); a failing rib degrades to zero agents
// rather than blanking the whole list.
export function agentsRoutes(app: Hono, deps: AgentsRoutesDeps): void {
  const { agentListers, agentResolvers } = deps;

  app.get("/api/agents", async (c) => {
    const lists = await Promise.all(
      [...agentListers.entries()].map(async ([ribId, lister]): Promise<AgentRef[]> => {
        try {
          const agents = await lister();
          const refs: AgentRef[] = [];
          for (const a of agents) {
            // Validate each summary; one malformed agent is dropped, not fatal.
            const parsed = agentSummarySchema.safeParse(a);
            if (parsed.success) refs.push({ ...parsed.data, ribId });
          }
          return refs;
        } catch {
          return [];
        }
      }),
    );
    return c.json(listAgentsResponseSchema.parse({ agents: lists.flat() }));
  });

  app.post("/api/agents/:ribId/:slug/resolve", async (c) => {
    const ribId = c.req.param("ribId");
    const slug = c.req.param("slug");
    const resolver = agentResolvers.get(ribId);
    if (!resolver) return c.json({ error: "rib has no agents" }, 404);
    let seed: OpenChatSeed | null;
    try {
      seed = await resolver(slug);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
    if (!seed) return c.json({ error: `unknown agent: ${slug}` }, 404);
    const parsed = openChatSeedSchema.safeParse(seed);
    if (!parsed.success) return c.json({ error: "rib returned a malformed agent seed" }, 500);
    return c.json(parsed.data);
  });
}
