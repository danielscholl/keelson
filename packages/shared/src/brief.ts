// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { z } from "zod";

export const briefSchema = z
  .object({
    sourceUrl: z.string().optional(),
    title: z.string().optional(),
    criteria: z.array(z.string()).default([]),
  })
  .strict();

export type Brief = z.infer<typeof briefSchema>;
