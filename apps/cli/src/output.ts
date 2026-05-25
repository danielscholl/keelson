// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

export interface EmitOptions {
  json: boolean;
  stream?: "stdout" | "stderr";
}

export interface ErrorPayload {
  readonly error: string;
  readonly code?: string;
}

export type EmitPayload<T = unknown> =
  | { readonly data: T; readonly error?: undefined }
  | ErrorPayload;

function write(line: string, stream: "stdout" | "stderr"): void {
  if (stream === "stderr") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

function renderHuman(value: unknown, indent = ""): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((v) => `${indent}- ${renderHuman(v, indent + "  ")}`).join("\n");
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => {
        const rendered = renderHuman(v, indent + "  ");
        return rendered.includes("\n")
          ? `${indent}${k}:\n${rendered}`
          : `${indent}${k}: ${rendered}`;
      })
      .join("\n");
  }
  return String(value);
}

export function emit<T>(payload: EmitPayload<T>, opts: EmitOptions): void {
  if (opts.json) {
    // JSON envelopes always go to stdout so `keelson <cmd> --json | jq` works
    // even on failure; the `ok` field signals success vs error.
    const stream = opts.stream ?? "stdout";
    const envelope = isError(payload)
      ? { ok: false, error: payload.error, ...(payload.code ? { code: payload.code } : {}) }
      : { ok: true, data: payload.data };
    write(JSON.stringify(envelope), stream);
    return;
  }
  const stream = opts.stream ?? (isError(payload) ? "stderr" : "stdout");
  if (isError(payload)) {
    write(`error: ${payload.error}`, stream);
    return;
  }
  write(renderHuman(payload.data), stream);
}

function isError<T>(p: EmitPayload<T>): p is ErrorPayload {
  return typeof (p as ErrorPayload).error === "string";
}
