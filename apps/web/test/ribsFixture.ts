import type { RibSummary } from "@keelson/shared";

// Every useRibs mock reads this: mock.module is process-global, so whichever
// file's mock is live, a test sets its manifest here.
export const ribFixture: { ribs: RibSummary[] } = { ribs: [] };
