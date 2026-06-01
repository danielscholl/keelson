// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

// Node-level `notebook:` block — a deterministic, declarative append to the
// project notebook when the node completes. Mirrors `memory.writeback`'s
// `on: success | always` gate; the executor resolves `append` like any other
// body template and hands the result to the run's notebook adapter.

import { z } from "zod";

export const nodeNotebookBlockSchema = z
  .object({
    // Resolved against $inputs.* / $nodeId.output before append, like writeback content.
    append: z.string().min(1),
    // Notebook section to append under; the store defaults it when omitted.
    section: z.string().min(1).optional(),
    on: z.enum(["success", "always"]).default("success"),
  })
  .strict();

export type NodeNotebookBlock = z.infer<typeof nodeNotebookBlockSchema>;
