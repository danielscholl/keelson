// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterEach, describe, expect, mock, test } from "bun:test";
import { SCHEMA_VERSION } from "@keelson/shared";
import { render, screen, waitFor } from "@testing-library/react";
import { ToastHost } from "../src/components/Toast.tsx";
import { useSchemaVersionGate } from "../src/hooks/useSchemaVersionGate.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubConfig(schemaVersion: string | null): ReturnType<typeof mock> {
  const fetchMock = mock(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/api/config")) {
      const body = schemaVersion === null ? {} : { schemaVersion, wireProtocolVersion: "1.0" };
      return Response.json(body);
    }
    return new Response("not found", { status: 404 });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function Probe() {
  useSchemaVersionGate();
  return null;
}

const renderGate = () =>
  render(
    <ToastHost>
      <Probe />
    </ToastHost>,
  );

describe("useSchemaVersionGate", () => {
  test("prompts a reload when the server schema differs", async () => {
    stubConfig("9.9");
    renderGate();
    expect(await screen.findByRole("button", { name: "Reload" })).toBeDefined();
    expect(screen.getByText(/server schema 9\.9/)).toBeDefined();
  });

  test("treats a server with no schemaVersion as skew", async () => {
    stubConfig(null);
    renderGate();
    expect(await screen.findByRole("button", { name: "Reload" })).toBeDefined();
  });

  test("stays silent when the server schema matches", async () => {
    const fetchMock = stubConfig(SCHEMA_VERSION);
    renderGate();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // A macrotask boundary drains every microtask the fetch resolution chains
    // (res.json → fetchConfig → the hook's push), so a toast that should never
    // appear has fully had its chance before we assert absence.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
  });

  test("stays silent when /api/config fails", async () => {
    const fetchMock = mock(async () => new Response("boom", { status: 500 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    renderGate();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await Promise.resolve();
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
  });
});
