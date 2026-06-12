// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { bold, brass, cyan, dim } from "./theme.ts";

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

function section(title: string, rows: readonly string[]): string[] {
  return [`${PAD}${bold(brass(title))}`, ...rows.map((r) => `${PAD}${r}`), ""];
}

function row(label: string, value: string): string {
  return `${cyan(label.padEnd(12))}${value}`;
}

// Interaction design modeled on the pi coding agent's startup card
// (MIT, see NOTICE): tips, loaded context, recent sessions.
export function buildWelcomeLines(data: WelcomeData): string[] {
  const lines: string[] = [
    "",
    `${PAD}${bold(brass("◤◢ keelson"))} ${dim(`chat · v${data.version}`)}`,
    "",
  ];

  lines.push(
    ...section("Tips", [
      row("/", "commands"),
      row("Esc", "interrupt a turn"),
      row("Ctrl+C", "exit"),
    ]),
  );

  const providerValue =
    data.model !== undefined ? `${data.providerId} ${dim(`· ${data.model}`)}` : data.providerId;
  const projectValue =
    data.branch !== null ? `${data.projectName} ${dim(`· ${data.branch}`)}` : data.projectName;
  const ribsValue =
    data.ribs.length === 0
      ? dim("none installed")
      : `${data.ribs.length} ${dim(`— ${data.ribs.map((r) => r.displayName).join(", ")}`)}`;
  const loadedRows = [
    row("provider", providerValue),
    row("project", projectValue),
    row("ribs", ribsValue),
  ];
  if (data.projectNote !== undefined) loadedRows.push(dim(data.projectNote));
  lines.push(...section("Loaded", loadedRows));

  if (data.recent.length > 0) {
    lines.push(
      ...section(
        "Recent sessions",
        data.recent.map((r) => `${brass("·")} ${r.name} ${dim(`(${r.ago})`)}`),
      ),
    );
  }

  return lines;
}
