// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import type { ListRibsResponse, RibSummary } from "@keelson/shared";
import { HttpError } from "./workflow-client.ts";

function normalizeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function originHeader(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    return `http://${u.hostname}:${u.port || (u.protocol === "https:" ? "443" : "80")}`;
  } catch {
    return "http://127.0.0.1:7878";
  }
}

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

export async function listRibs(baseUrl: string): Promise<RibSummary[]> {
  const res = await fetch(`${normalizeBase(baseUrl)}/api/ribs`, {
    headers: defaultHeaders(baseUrl),
  });
  if (!res.ok) throw new HttpError(res.status, await errorMessage(res, "GET /api/ribs"));
  const body = (await res.json()) as ListRibsResponse;
  return body.ribs;
}
