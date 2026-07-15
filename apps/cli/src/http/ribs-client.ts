// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import type { ListRibsResponse, RibSummary } from "@keelson/shared";
import { normalizeBase, originHeader } from "./base.ts";
import { HttpError } from "./workflow-client.ts";

function defaultHeaders(baseUrl: string): Record<string, string> {
  return { accept: "application/json", origin: originHeader(baseUrl) };
}

interface ErrorBody {
  error?: string;
}

async function errorMessage(res: Response, label: string): Promise<string> {
  try {
    const body = (await res.json()) as ErrorBody;
    if (typeof body.error === "string" && body.error.length > 0) return body.error;
  } catch {
    // Body wasn't JSON; fall back to status text.
  }
  return `${label} failed: ${res.status} ${res.statusText}`;
}

export async function fetchRibs(baseUrl: string): Promise<ListRibsResponse> {
  const res = await fetch(`${normalizeBase(baseUrl)}/api/ribs`, {
    headers: defaultHeaders(baseUrl),
  });
  if (!res.ok) throw new HttpError(res.status, await errorMessage(res, "GET /api/ribs"));
  return (await res.json()) as ListRibsResponse;
}

export async function listRibs(baseUrl: string): Promise<RibSummary[]> {
  return (await fetchRibs(baseUrl)).ribs;
}
