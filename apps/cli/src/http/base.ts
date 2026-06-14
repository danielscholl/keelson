// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

// Shared HTTP helpers for the CLI's server clients.

export function normalizeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

// The Origin header the server's per-route CSRF gate expects from the CLI: a
// loopback origin (the server's isAllowedOrigin only checks the hostname).
// Falls back to the default server origin when baseUrl can't be parsed.
export function originHeader(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    return `http://${u.hostname}:${u.port || (u.protocol === "https:" ? "443" : "80")}`;
  } catch {
    return "http://127.0.0.1:7878";
  }
}
