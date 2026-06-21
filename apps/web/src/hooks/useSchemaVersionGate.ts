// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { isSchemaVersionCompatible, SCHEMA_VERSION } from "@keelson/shared";
import { useEffect } from "react";
import { fetchConfig } from "../api.ts";
import { useToast } from "../components/Toast.tsx";

// A browser tab can hold a pre-upgrade bundle across `keelson update` (or talk
// to a stale background server). The SPA strict-parses every wire frame, so an
// additive schema change then drops workflow frames and breaks chat mid-stream
// with no pointer at the skew. Compare the server's reported schemaVersion to
// this bundle's once at boot; on a mismatch, prompt a reload of the bundle.
export function useSchemaVersionGate(): void {
  const { push } = useToast();
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let schemaVersion: string;
      try {
        ({ schemaVersion } = await fetchConfig());
      } catch {
        // A failing /api/config isn't a skew signal — a real outage surfaces
        // through the app's other requests. Stay quiet here.
        return;
      }
      // An empty version is a server too old to report one (fetchConfig's
      // defensive fallback) — also skew, just with no number to show.
      if (cancelled || isSchemaVersionCompatible(schemaVersion)) return;
      push({
        kind: "info",
        message:
          schemaVersion === ""
            ? "Keelson server is out of date with this page. Reload after updating the server."
            : `Keelson was updated (server schema ${schemaVersion}, this page ${SCHEMA_VERSION}). Reload to use the new version.`,
        // Sticky — the skew persists until the user reloads.
        ttlMs: 0,
        action: { label: "Reload", onClick: () => window.location.reload() },
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [push]);
}
