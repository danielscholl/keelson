// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

// The workflow authoring reference served to chat agents via the
// workflow_schema tool. Embedded as a text import so it ships inside the
// release bundle and stays versioned with the loader it documents. The
// triple-slash reference loads the *.md ambient module for downstream
// workspaces that compile this file through their own tsconfig.
/// <reference path="./md.d.ts" />
import guideText from "./authoring-guide.md" with { type: "text" };

export const WORKFLOW_AUTHORING_GUIDE: string = guideText;

interface GuideSection {
  heading: string;
  slug: string;
  body: string;
}

function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function splitSections(guide: string): GuideSection[] {
  const sections: GuideSection[] = [];
  const matches = [...guide.matchAll(/^## (.+)$/gm)];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]!;
    const heading = match[1]!.trim();
    const start = match.index;
    const end = i + 1 < matches.length ? matches[i + 1]!.index : guide.length;
    sections.push({ heading, slug: slugify(heading), body: guide.slice(start, end).trimEnd() });
  }
  return sections;
}

const SECTIONS: readonly GuideSection[] = splitSections(WORKFLOW_AUTHORING_GUIDE);

// Topic keys for the workflow_schema tool, derived from the guide's `## `
// headings so the tool description never drifts from the document.
export const AUTHORING_GUIDE_TOPICS: readonly string[] = SECTIONS.map((s) => s.slug);

// Returns the matching `## ` section for a topic (case-insensitive, matched
// by slug or full heading), or undefined when no section matches.
export function authoringGuideSection(topic: string): string | undefined {
  const wanted = slugify(topic);
  return SECTIONS.find((s) => s.slug === wanted)?.body;
}
