// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

// Stable exit-code contract for operator scripting; values are part of the
// CLI's public surface and must not be renumbered.
export const EXIT_OK = 0;
export const EXIT_FAIL = 1;
export const EXIT_BAD_ARGS = 2;
export const EXIT_NO_SERVER = 3;
export const EXIT_NOT_FOUND = 4;
