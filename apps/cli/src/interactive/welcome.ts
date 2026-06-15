// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { bold, brass, cyan, dim, navy } from "./theme.ts";

export interface WelcomeData {
  version: string;
  providerId: string;
  model?: string;
  projectName: string;
  projectNote?: string;
  branch: string | null;
  ribs: readonly { displayName: string; tools: number }[];
  recent: readonly { name: string; ago: string }[];
}

const PAD = "  ";
// Gap between the beam and the wordmark; the subtitle aligns under the wordmark,
// so SUBTITLE_INDENT tracks it.
const MARK_GAP = "  ";

function section(title: string, rows: readonly string[]): string[] {
  return [`${PAD}${bold(brass(title))}`, ...rows.map((r) => `${PAD}${r}`), ""];
}

function row(label: string, value: string): string {
  return `${cyan(label.padEnd(12))}${value}`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

// The keelson mark echoing the favicon (docs/public/assets/keelson-mark.svg):
// the brass beam crossing a navy rib stub, with the wordmark riding the beam.
const RIBS = " │ │";
const BEAM = "━┿━┿━";
const SUBTITLE_INDENT = " ".repeat(PAD.length + BEAM.length + MARK_GAP.length);

// An identity card, not a status table: the persistent footer owns live state
// (provider/model/project/branch/usage), so the card echoes it once and then
// shows only what the footer can't — installed ribs and recent sessions to
// resume. Modeled on the pi coding agent's startup card (MIT, see NOTICE).
export function buildWelcomeLines(data: WelcomeData): string[] {
  const subtitle = [data.providerId, data.model, data.projectName]
    .filter((s): s is string => s !== undefined)
    .join(" · ");
  const lines: string[] = [
    "",
    `${PAD}${navy(RIBS)}`,
    `${PAD}${bold(brass(BEAM))}${MARK_GAP}${bold(brass("keelson"))} ${dim(`chat · v${data.version}`)}`,
    `${SUBTITLE_INDENT}${dim(subtitle)}`,
    "",
  ];

  const tip = (key: string, label: string): string => `${cyan(key)} ${dim(label)}`;
  lines.push(
    `${PAD}${[tip("/", "commands"), tip("Esc", "interrupt"), tip("Ctrl+C", "exit")].join(dim(" · "))}`,
    "",
  );

  const ribsValue =
    data.ribs.length === 0
      ? `${dim("none installed · ")}${cyan("keelson rib add <url>")}`
      : `${data.ribs.length} ${dim(`— ${data.ribs.map((r) => r.displayName).join(", ")}`)}`;
  lines.push(`${PAD}${row("ribs", ribsValue)}`);
  if (data.projectNote !== undefined) lines.push(`${PAD}${dim(data.projectNote)}`);
  lines.push("");

  if (data.recent.length > 0) {
    const width = Math.min(28, Math.max(...data.recent.map((r) => r.name.length)));
    lines.push(
      ...section(
        "Recent",
        data.recent.map(
          (r) => `${brass("·")} ${truncate(r.name, width).padEnd(width)}   ${dim(r.ago)}`,
        ),
      ),
    );
  }

  return lines;
}
