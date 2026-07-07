// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { z } from "zod";

// A documentation source a rib contributes to the harness docs catalog. The
// corpus is an `llms.txt`-convention `llms-full.txt` (the complete concatenated
// docs), which the harness fetches once, caches, and slices on demand so only
// the requested section ever enters an agent turn — never the whole corpus.
// A source sets `llmsFullUrl` (fetched server-side) OR inline `content` (a rib
// that bundles its docs, and the path tests use to avoid the network).
export const ribDocsSourceSchema = z
  .object({
    title: z.string().min(1).max(80),
    summary: z.string().min(1).max(280),
    llmsFullUrl: z.string().url().optional(),
    content: z.string().min(1).optional(),
  })
  .strict()
  .refine((s) => s.llmsFullUrl !== undefined || s.content !== undefined, {
    message: "a docs source must set either 'llmsFullUrl' or 'content'",
  });
export type RibDocsSource = z.infer<typeof ribDocsSourceSchema>;
