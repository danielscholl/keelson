import { z } from "zod";

export default {
  id: "test",
  displayName: "Test Rib",
  registerTools: () => [
    {
      name: "test.tool",
      description: "test tool",
      inputSchema: z.object({}),
      execute: async () => {},
    },
  ],
};
