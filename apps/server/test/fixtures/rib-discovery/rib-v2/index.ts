// A fixture rib exercising every v2 contract hook: view descriptor, action
// descriptor, composeBundle, a workflow contribution bound to a namespaced
// snapshot key (with a fail-closed validator), an action handler, and an
// auth-status probe that reads a namespaced credential.

import type { Rib } from "@keelson/shared";
import { z } from "zod";

const rib: Rib = {
  id: "v2",
  displayName: "V2 Rib",
  views: [{ key: "rib:v2:summary", canvasKind: "view", title: "V2 Summary" }],
  actions: [{ type: "ping", label: "Ping" }],
  registerTools: () => [
    { name: "v2.tool", description: "v2 tool", inputSchema: z.object({}), execute: async () => {} },
  ],
  composeBundle: async () => ({ ok: true }),
  contributeWorkflows: () => [
    {
      definition: {
        name: "v2-live",
        description: "rib-contributed bash workflow",
        nodes: [{ id: "emit", bash: "echo hi" }],
      },
      bindSnapshotKey: "rib:v2:summary",
      validate: (data: unknown) => {
        const v = data as { view?: unknown };
        if (!v || typeof v !== "object" || typeof v.view !== "string") {
          throw new Error("expected a view payload");
        }
        return data;
      },
    },
  ],
  onAction: (action) => ({ ok: true, data: { echoed: action.type } }),
  authStatus: async (ctx) => {
    const token = await ctx.getCredential?.("token");
    return { authenticated: Boolean(token) };
  },
};

export default rib;
