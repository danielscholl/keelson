// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { SnapshotFrame } from "@keelson/shared";
import { useEffect, useState } from "react";
import { getSnapshot } from "../api.ts";
import { createReconnectingSnapshotWs } from "../ws.ts";

export type SnapshotStatus = "loading" | "empty" | "live" | "error";

export interface SnapshotState {
  status: SnapshotStatus;
  data: unknown;
  version: number | null;
}

const INITIAL: SnapshotState = { status: "loading", data: null, version: null };
const EMPTY: SnapshotState = { status: "empty", data: null, version: null };

// Subscribe to a server snapshot key: hydrate via GET, then live-update on each
// WS frame, re-hydrating on every reconnect (the server has no on-connect
// replay). A `null` key is inert. Frames are version-guarded so a duplicate or
// out-of-order frame can't roll the view backwards. A "gone" key (the producer
// unregistered it) stops the socket so it doesn't reconnect into a dead key.
export function useSnapshot(key: string | null): SnapshotState {
  const [state, setState] = useState<SnapshotState>(INITIAL);

  useEffect(() => {
    if (key === null) {
      setState(EMPTY);
      return;
    }
    setState(INITIAL);
    let cancelled = false;
    let seenVersion = -1;
    let hydrating = false;
    let handle: { close: () => void } | null = null;

    const applyFrame = (frame: SnapshotFrame): void => {
      if (cancelled || frame.version < seenVersion) return;
      seenVersion = frame.version;
      setState({ status: "live", data: frame.data, version: frame.version });
    };

    // Hydrate on mount and on each fresh WS open. The in-flight guard collapses
    // the mount-time call and the first onOpen call into one GET. "gone" (404)
    // means the producer dropped the key → stop reconnecting; "pending" (204)
    // keeps the socket waiting for the first frame.
    const hydrate = async (): Promise<void> => {
      if (hydrating) return;
      hydrating = true;
      try {
        const res = await getSnapshot(key);
        if (cancelled) return;
        if (res.kind === "frame") {
          applyFrame(res.frame);
        } else if (res.kind === "gone") {
          handle?.close();
          setState((s) => (s.status === "live" ? s : EMPTY));
        } else {
          setState((s) => (s.status === "live" ? s : EMPTY));
        }
      } catch (err) {
        if (!cancelled) {
          console.warn("[useSnapshot] hydrate failed:", err);
          setState((s) =>
            s.status === "live" ? s : { status: "error", data: null, version: null },
          );
        }
      } finally {
        hydrating = false;
      }
    };

    handle = createReconnectingSnapshotWs(key, {
      onFrame: applyFrame,
      onOpen: () => void hydrate(),
    });
    void hydrate();

    return () => {
      cancelled = true;
      handle?.close();
    };
  }, [key]);

  return state;
}
