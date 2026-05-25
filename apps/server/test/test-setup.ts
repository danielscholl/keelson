// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

// Side-effect module: import this BEFORE any module that may load
// apps/server/src/index.ts, so its boot-time openDatabase() call uses an
// in-memory SQLite DB instead of writing a real file at .keelson/.
process.env.KEELSON_DB ??= ":memory:";

// Route any rib that consults stubs through them by default in tests.
// Test files that exercise live behavior unset the flag locally.
process.env.KEELSON_USE_STUBS ??= "1";
