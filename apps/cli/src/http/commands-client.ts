// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import {
  type CommandCompletion,
  type CommandInvokeResult,
  type CommandRef,
  commandInvokeResultSchema,
  listCommandCompletionsResponseSchema,
  listCommandsResponseSchema,
} from "@keelson/shared";
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

// Rib-contributed slash commands (GET /api/commands), merged with the CLI's base
// commands into the slash menu.
export async function listRibCommands(baseUrl: string): Promise<CommandRef[]> {
  const res = await fetch(`${normalizeBase(baseUrl)}/api/commands`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new HttpError(res.status, `GET /api/commands failed: ${res.status}`);
  return listCommandsResponseSchema.parse(await res.json()).commands;
}

// Argument type-ahead for a rib command whose descriptor sets argument.completes.
// A failed completion degrades to nothing rather than breaking the editor.
export async function completeRibCommand(
  baseUrl: string,
  ribId: string,
  name: string,
  prefix: string,
): Promise<CommandCompletion[]> {
  const url = `${normalizeBase(baseUrl)}/api/commands/${encodeURIComponent(ribId)}/${encodeURIComponent(name)}/complete?prefix=${encodeURIComponent(prefix)}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) return [];
  return listCommandCompletionsResponseSchema.parse(await res.json()).completions;
}

// Invoke a rib command; the returned effect is performed by the surface.
export async function invokeRibCommand(
  baseUrl: string,
  ribId: string,
  name: string,
  arg: string,
): Promise<CommandInvokeResult> {
  const url = `${normalizeBase(baseUrl)}/api/commands/${encodeURIComponent(ribId)}/${encodeURIComponent(name)}/invoke`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      origin: originHeader(baseUrl),
    },
    body: JSON.stringify({ arg }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new HttpError(res.status, `invoke /${name} failed: ${res.status} ${body}`);
  }
  return commandInvokeResultSchema.parse(await res.json());
}
