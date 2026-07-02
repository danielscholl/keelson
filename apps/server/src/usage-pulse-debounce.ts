// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { UsageStore } from "./usage-store.ts";

// Default quiet window before a burst of record() calls settles into a single
// recompose — long enough to coalesce a turn's worth of usage events (which
// land in quick succession) into one snapshot broadcast.
const DEFAULT_QUIET_MS = 2000;

// Wraps `store.record` so each call schedules `onSettled`, resetting the timer
// on every subsequent call within `quietMs` — a trailing-edge debounce. Only
// `record` is intercepted; every other UsageStore method passes through
// untouched. Intended to be applied ONCE at the composition root so the rest
// of the app (the three capture seams, the routes) keeps calling `record` and
// never has to know a recompose is scheduled behind it.
export function withUsagePulseDebounce(
  store: UsageStore,
  onSettled: () => void,
  quietMs: number = DEFAULT_QUIET_MS,
): UsageStore {
  let timer: ReturnType<typeof setTimeout> | undefined;

  return {
    ...store,
    record(input) {
      store.record(input);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        onSettled();
      }, quietMs);
    },
  };
}
