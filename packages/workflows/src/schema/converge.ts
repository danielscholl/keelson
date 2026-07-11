import { z } from "zod";

export const convergeConfigSchema = z.object({
  gate: z.string().min(1, "converge requires 'converge.gate' (a node id)"),
  max_rounds: z
    .number()
    .int()
    .min(1, "'converge.max_rounds' must be between 1 and 10")
    .max(10, "'converge.max_rounds' must be between 1 and 10"),
  on_exhaust: z.enum(["fail", "approval"]).default("fail"),
});

export type ConvergeConfig = z.infer<typeof convergeConfigSchema>;
