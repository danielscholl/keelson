// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { isRegisteredProvider, registerProvider } from "../registry.ts";
import { STUB_CAPABILITIES, StubProvider } from "./provider.ts";

export function registerStubProvider(): void {
  if (isRegisteredProvider("stub")) return;
  registerProvider({
    id: "stub",
    displayName: "Stub (Echo)",
    factory: () => new StubProvider(),
    capabilities: STUB_CAPABILITIES,
    builtIn: true,
  });
}
