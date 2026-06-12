// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { type Component, Markdown, Text } from "@earendil-works/pi-tui";
import type { MessageChunk } from "@keelson/shared";
import { brass, dim, italic, markdownTheme, red } from "./theme.ts";

const MAX_SUMMARY_WIDTH = 100;

function oneLine(text: string, max = MAX_SUMMARY_WIDTH): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function summarizeToolUse(toolName: string, toolInput?: Record<string, unknown>): string {
  const args = toolInput
    ? Object.entries(toolInput)
        .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(", ")
    : "";
  return oneLine(args.length > 0 ? `⚙ ${toolName} ${args}` : `⚙ ${toolName}`);
}

export function summarizeToolResult(content: string, isError?: boolean): string {
  const head = oneLine(content);
  return isError ? `✗ ${head}` : `→ ${head}`;
}

// Structural slice of pi-tui's TUI that the turn view appends to; tests pass
// a recording fake instead of a live terminal.
export interface TranscriptSurface {
  addChild(component: Component): void;
  requestRender(): void;
}

// Renders one assistant turn: text chunks accumulate into a live Markdown
// block, tool calls and thinking collapse to one-line entries between blocks.
export class AssistantTurnView {
  private surface: TranscriptSurface;
  private markdown: Markdown | null = null;
  private text = "";
  private showThinking: boolean;

  constructor(surface: TranscriptSurface, opts: { showThinking?: boolean } = {}) {
    this.surface = surface;
    this.showThinking = opts.showThinking === true;
  }

  // A tool call or thinking entry closes the current markdown block so later
  // text starts a fresh one and ordering is preserved in the transcript.
  private appendLine(line: string): void {
    this.markdown = null;
    this.surface.addChild(new Text(line, 1, 0));
    this.surface.requestRender();
  }

  handleChunk(chunk: MessageChunk): void {
    switch (chunk.type) {
      case "text": {
        if (this.markdown === null) {
          this.text = "";
          this.markdown = new Markdown("", 1, 0, markdownTheme);
          this.surface.addChild(this.markdown);
        }
        this.text += chunk.content;
        this.markdown.setText(this.text);
        this.surface.requestRender();
        break;
      }
      case "tool_use":
        this.appendLine(dim(summarizeToolUse(chunk.toolName, chunk.toolInput)));
        break;
      case "tool_result":
        this.appendLine(
          chunk.isError
            ? red(summarizeToolResult(chunk.content, true))
            : dim(summarizeToolResult(chunk.content)),
        );
        break;
      case "thinking":
        if (this.showThinking && chunk.content.trim().length > 0) {
          this.appendLine(dim(italic(oneLine(chunk.content))));
        }
        break;
      case "error":
        this.appendLine(red(`✗ ${oneLine(chunk.message)}`));
        break;
      default:
        // system/usage/done carry no transcript-visible content in v1.
        break;
    }
  }

  fail(message: string): void {
    this.appendLine(red(`✗ ${oneLine(message)}`));
  }
}

export function userLine(message: string): Text {
  return new Text(`${brass("›")} ${message}`, 1, 0);
}
