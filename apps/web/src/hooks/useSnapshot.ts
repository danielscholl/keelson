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

export type SnapshotStatus = "loading" | "empty" | "live";

export interface SnapshotState {
  status: SnapshotStatus;
  data: unknown;
  version: number | null;
}

const INITIAL: SnapshotState = { status: "loading", data: null, version: null };

// Subscribe to a server snapshot key: hydrate via GET, then live-update on each
// WS frame, re-hydrating on every reconnect (the server has no on-connect
// replay). A `null` key is inert. Frames are version-guarded so a duplicate or
// out-of-order frame can't roll the view backwards.
export function useSnapshot(key: string | null): SnapshotState {
  const [state, setState] = useState<SnapshotState>(INITIAL);

  useEffect(() => {
    if (key === null) {
      setState({ status: "empty", data: null, version: null });
      return;
    }
    setState(INITIAL);
    let cancelled = false;
    let seenVersion = -1;
    let sawFrame = false;
    let handle: { close: () => void } | null = null;

    const applyFrame = (frame: SnapshotFrame): void => {
      if (cancelled || frame.version < seenVersion) return;
      seenVersion = frame.version;
      sawFrame = true;
      setState({ status: "live", data: frame.data, version: frame.version });
    };

    // A 404 means "nothing yet" on first load but "gone" once we've already
    // rendered a frame — in the gone case stop reconnecting into a key the
    // producer has unregistered (otherwise the socket reopens forever).
    const hydrate = async (): Promise<void> => {
      let frame: SnapshotFrame | null;
      try {
        frame = await getSnapshot(key);
      } catch (err) {
        if (!cancelled) console.warn("[useSnapshot] hydrate failed:", err);
        return;
      }
      if (cancelled) return;
      if (frame) {
        applyFrame(frame);
      } else if (sawFrame) {
        handle?.close();
        setState({ status: "empty", data: null, version: null });
      } else {
        setState((s) => (s.status === "live" ? s : { status: "empty", data: null, version: null }));
      }
    };

    void hydrate();
    handle = createReconnectingSnapshotWs(key, {
      onFrame: applyFrame,
      onOpen: () => void hydrate(),
    });

    return () => {
      cancelled = true;
      handle?.close();
    };
  }, [key]);

  return state;
}
