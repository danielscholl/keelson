import { beforeEach, describe, expect, mock, test } from "bun:test";
import { render } from "@testing-library/react";

// Drive the manifest-revision beacon and observe whether RibsProvider refetches.
// Mocking the two hooks (not api.ts/ws.ts) keeps this file's stubs off the
// modules other suites mock process-globally.
let beaconVersion: number | null = null;
mock.module("../src/hooks/useSnapshot.ts", () => ({
  useSnapshot: () => ({
    status: beaconVersion === null ? "loading" : "live",
    data: { revision: beaconVersion },
    version: beaconVersion,
    composedAt: null,
    reload: () => {},
  }),
}));

let refreshCalls = 0;
const refresh = () => {
  refreshCalls++;
};
mock.module("../src/hooks/useRibs.ts", () => ({
  useRibs: () => ({ status: "ready", ribs: [], error: null, refresh }),
}));

const { RibsProvider } = await import("../src/components/RibsProvider.tsx");

beforeEach(() => {
  refreshCalls = 0;
  beaconVersion = null;
});

describe("RibsProvider manifest beacon", () => {
  test("refetches the manifest on the first observed beacon version", () => {
    beaconVersion = 5;
    render(<RibsProvider>ok</RibsProvider>);
    expect(refreshCalls).toBe(1);
  });

  test("does not refetch again while the version is unchanged", () => {
    beaconVersion = 5;
    const { rerender } = render(<RibsProvider>ok</RibsProvider>);
    expect(refreshCalls).toBe(1);
    rerender(<RibsProvider>ok</RibsProvider>);
    expect(refreshCalls).toBe(1);
  });

  test("refetches exactly once when the version changes", () => {
    beaconVersion = 5;
    const { rerender } = render(<RibsProvider>ok</RibsProvider>);
    expect(refreshCalls).toBe(1);
    beaconVersion = 6;
    rerender(<RibsProvider>ok</RibsProvider>);
    expect(refreshCalls).toBe(2);
  });

  test("does not refetch before the first frame arrives (null version)", () => {
    beaconVersion = null;
    render(<RibsProvider>ok</RibsProvider>);
    expect(refreshCalls).toBe(0);
  });
});
