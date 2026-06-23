// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

// Per-key cursor backing the snapshot version guard. `seen` is the highest
// version applied so far; `applied` distinguishes "no frame yet" from a real
// version 0, which is valid (snapshots.ts versions are nonnegative).
export interface SnapshotCursor {
  seen: number;
  applied: boolean;
}

export function freshCursor(): SnapshotCursor {
  return { seen: -1, applied: false };
}

// Decide whether an incoming frame should be applied, mutating the cursor when
// it is. Three cases the strict-monotonic `<` guard got wrong:
//   - Equal versions are a true no-op (dedupe), so a reconnect re-hydrate at the
//     same version doesn't re-render the board.
//   - The server restarts a key at version 0 when it is unregistered then
//     re-registered (recompose: nextVersion = (versions.get(key) ?? -1) + 1), so
//     a version-0 frame is always a fresh baseline and is accepted even though
//     it is below a previously-seen version — otherwise the panel wedges on
//     stale data after a re-registration.
//   - Any other lower-or-equal version is dropped, so a duplicate or out-of-order
//     live frame within one registration can't roll the view backwards.
export function shouldApplyFrame(cursor: SnapshotCursor, version: number): boolean {
  if (version === 0) {
    cursor.seen = 0;
    cursor.applied = true;
    return true;
  }
  if (cursor.applied && version <= cursor.seen) return false;
  cursor.seen = version;
  cursor.applied = true;
  return true;
}
