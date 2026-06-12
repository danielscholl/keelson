// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { brass, cyan, dim, green, navy } from "./theme.ts";

export type FooterActivity = "idle" | "working" | "workflow";

export interface FooterState {
  providerId: string;
  model?: string;
  projectName: string;
  branch: string | null;
  meter: string;
  activity: FooterActivity;
}

const SEP = " ⟩ ";

// One-line status strip below the editor: provider/model, project, branch,
// usage meter, and a working indicator. Modeled on pi's footer (MIT, see
// NOTICE) but rendered from keelson session state.
export class StatusFooter implements Component {
  private state: FooterState;

  constructor(initial: FooterState) {
    this.state = initial;
  }

  set(patch: Partial<FooterState>): void {
    this.state = { ...this.state, ...patch };
  }

  invalidate(): void {}

  get(): FooterState {
    return this.state;
  }

  render(width: number): string[] {
    const s = this.state;
    const parts: string[] = [];
    parts.push(brass(`◆ ${s.providerId}`) + (s.model !== undefined ? dim(` · ${s.model}`) : ""));
    parts.push(cyan(s.projectName) + (s.branch !== null ? dim(` · ${s.branch}`) : ""));
    parts.push(green(s.meter));
    if (s.activity === "working") parts.push(navy("⋯ working"));
    if (s.activity === "workflow") parts.push(navy("▶ workflow"));
    const line = ` ${parts.join(dim(SEP))}`;
    return [visibleWidth(line) <= width ? line : truncateToWidth(line, Math.max(0, width - 1))];
  }
}
