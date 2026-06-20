// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import type {
  GatewaySummary,
  ListGatewaysResponse,
  UpsertGatewayBody,
} from "@keelson/shared/config";
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

export async function listGateways(baseUrl: string): Promise<GatewaySummary[]> {
  const res = await fetch(`${normalizeBase(baseUrl)}/api/gateways`, {
    headers: defaultHeaders(baseUrl),
  });
  if (!res.ok) throw new HttpError(res.status, await errorMessage(res, "GET /api/gateways"));
  const body = (await res.json()) as ListGatewaysResponse;
  return body.gateways;
}

export async function putGateway(
  baseUrl: string,
  name: string,
  body: UpsertGatewayBody,
): Promise<GatewaySummary> {
  const res = await fetch(`${normalizeBase(baseUrl)}/api/gateways/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { ...defaultHeaders(baseUrl), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new HttpError(res.status, await errorMessage(res, `PUT /api/gateways/${name}`));
  }
  return (await res.json()) as GatewaySummary;
}

export async function deleteGateway(baseUrl: string, name: string): Promise<void> {
  const res = await fetch(`${normalizeBase(baseUrl)}/api/gateways/${encodeURIComponent(name)}`, {
    method: "DELETE",
    headers: defaultHeaders(baseUrl),
  });
  if (!res.ok) {
    throw new HttpError(res.status, await errorMessage(res, `DELETE /api/gateways/${name}`));
  }
}
