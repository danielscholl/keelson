// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { isRegisteredProvider, registerProvider } from "../registry.ts";
import { WORKFLOW_CAPABILITIES, WorkflowProvider } from "./provider.ts";

export function registerWorkflowProvider(): void {
  if (isRegisteredProvider("workflow")) return;
  registerProvider({
    id: "workflow",
    displayName: "Workflow",
    factory: () => new WorkflowProvider(),
    capabilities: WORKFLOW_CAPABILITIES,
    builtIn: true,
  });
}
