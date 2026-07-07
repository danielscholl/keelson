// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// The docs catalog behind the keelson_docs tool. It holds one entry per docs
// source (keelson core plus any rib that contributes docs), fetches each
// source's `llms-full.txt` corpus at most once, caches it, and slices it on H1
// boundaries so only the requested topic ever crosses into an agent turn — the
// whole corpus (tens of thousands of tokens) never does.

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RibDocsSource } from "@keelson/shared";

// A registered source: a RibDocsSource plus the id the harness stamps
// ("keelson" for core, the rib id for a rib).
export interface DocsSource extends RibDocsSource {
  id: string;
}

// Keelson's own docs — the corpus the published docs site emits. The catalog
// always carries this so the agent can look up harness behavior even with no
// ribs installed; ribs extend the catalog alongside it.
export const KEELSON_CORE_DOCS_SOURCE: DocsSource = {
  id: "keelson",
  title: "Keelson",
  summary:
    "The Keelson harness itself: chat, deterministic workflows, memory, ribs, providers, the CLI, and configuration.",
  llmsFullUrl: "https://danielscholl.github.io/keelson/llms-full.txt",
};

export interface DocsSourceListing {
  id: string;
  title: string;
  summary: string;
}

// A topic is one H1 block of the corpus — a documentation page. `summary` is the
// `>` blockquote line the docs put right under the heading, when present.
export interface DocsTopic {
  slug: string;
  title: string;
  summary?: string;
}

export type TocResult =
  | { ok: true; source: DocsSourceListing; topics: DocsTopic[] }
  | { ok: false; error: string };

export type SectionResult =
  | { ok: true; source: DocsSourceListing; topic: DocsTopic; content: string; truncated: boolean }
  | { ok: false; error: string; topics?: DocsTopic[] };

export interface DocsCatalogOptions {
  sources: readonly DocsSource[];
  // Where fetched corpora are cached on disk (e.g. <home>/docs-cache).
  cacheDir: string;
  // Injected in tests to avoid the network; defaults to global fetch.
  fetchImpl?: typeof fetch;
  // On-disk cache freshness window, checked on the first read per process. After
  // that the running process serves the parsed corpus from memory; a restart
  // re-reads disk and refetches only when the cached copy is older than this.
  ttlMs?: number;
  // A single topic read is capped at this many characters so one oversized page
  // can't blow the turn; the rest is one more read away.
  maxSectionChars?: number;
  // Injected in tests; defaults to Date.now.
  now?: () => number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_SECTION_CHARS = 32_000;

interface ParsedTopic extends DocsTopic {
  body: string;
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Split a corpus into H1 topics. Content before the first H1 (the docs'
// `<SYSTEM>` preamble) is dropped. The `>` blockquote directly under a heading
// becomes that topic's summary. Slugs are de-duped so two same-named pages stay
// individually addressable.
export function parseTopics(corpus: string): ParsedTopic[] {
  const lines = corpus.split("\n");
  const topics: ParsedTopic[] = [];
  const seen = new Map<string, number>();
  let current: { title: string; bodyLines: string[] } | null = null;
  let inFence = false;

  const flush = () => {
    if (!current) return;
    const base = slugify(current.title) || "topic";
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    const slug = count === 0 ? base : `${base}-${count + 1}`;
    const body = current.bodyLines.join("\n").trim();
    const summary = extractSummary(current.bodyLines);
    topics.push({ slug, title: current.title, body, ...(summary ? { summary } : {}) });
  };

  for (const line of lines) {
    // A ``` / ~~~ fence toggles code mode; a `# …` line inside a fenced block is
    // a code sample (llms-full.txt embeds shell and markdown examples), not a
    // topic boundary — splitting on it would fragment the page.
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      if (current) current.bodyLines.push(line);
      continue;
    }
    const h1 = inFence ? null : /^# (.+)$/.exec(line);
    if (h1?.[1]) {
      flush();
      current = { title: h1[1].trim(), bodyLines: [] };
      continue;
    }
    if (current) current.bodyLines.push(line);
  }
  flush();
  return topics;
}

// The first non-empty line under a heading, when it is a `> …` blockquote.
function extractSummary(bodyLines: readonly string[]): string | undefined {
  for (const line of bodyLines) {
    if (line.trim() === "") continue;
    const m = /^>\s?(.*)$/.exec(line.trim());
    const text = m?.[1]?.trim();
    // A `> [!NOTE]`-style admonition marker is not a page summary.
    if (!text || text.startsWith("[!")) return undefined;
    return text;
  }
  return undefined;
}

export class DocsCatalog {
  private readonly sources = new Map<string, DocsSource>();
  private readonly cacheDir: string;
  private readonly fetchImpl: typeof fetch;
  private readonly ttlMs: number;
  private readonly maxSectionChars: number;
  private readonly now: () => number;
  private readonly memCache = new Map<string, ParsedTopic[]>();
  private readonly inflight = new Map<string, Promise<ParsedTopic[]>>();

  constructor(opts: DocsCatalogOptions) {
    // First registration wins, so a rib whose id collides with an already-listed
    // source (e.g. core "keelson") can't shadow it.
    for (const s of opts.sources) {
      if (this.sources.has(s.id)) {
        console.warn(`[keelson] docs source id '${s.id}' already registered; skipping duplicate`);
        continue;
      }
      this.sources.set(s.id, s);
    }
    this.cacheDir = opts.cacheDir;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.maxSectionChars = opts.maxSectionChars ?? DEFAULT_MAX_SECTION_CHARS;
    this.now = opts.now ?? Date.now;
  }

  list(): DocsSourceListing[] {
    return [...this.sources.values()].map((s) => this.listing(s));
  }

  private listing(source: DocsSource): DocsSourceListing {
    return { id: source.id, title: source.title, summary: source.summary };
  }

  async toc(id: string, signal?: AbortSignal): Promise<TocResult> {
    const source = this.sources.get(id);
    if (!source) return { ok: false, error: this.unknownSourceMessage(id) };
    let topics: ParsedTopic[];
    try {
      topics = await this.topicsFor(source, signal);
    } catch (err) {
      return { ok: false, error: this.loadError(source, err) };
    }
    return {
      ok: true,
      source: this.listing(source),
      topics: topics.map(stripBody),
    };
  }

  async readSection(id: string, section: string, signal?: AbortSignal): Promise<SectionResult> {
    const source = this.sources.get(id);
    if (!source) return { ok: false, error: this.unknownSourceMessage(id) };
    let topics: ParsedTopic[];
    try {
      topics = await this.topicsFor(source, signal);
    } catch (err) {
      return { ok: false, error: this.loadError(source, err) };
    }
    const match = matchTopic(topics, section);
    if (!match) {
      return {
        ok: false,
        error: `No section matching '${section}' in '${id}'. Call keelson_docs with just this source id to see its table of contents.`,
        topics: topics.map(stripBody),
      };
    }
    const truncated = match.body.length > this.maxSectionChars;
    const content = truncated
      ? `${match.body.slice(0, this.maxSectionChars)}\n\n[…truncated — this topic is large; ask a narrower question or request a specific subsection.]`
      : match.body;
    return { ok: true, source: this.listing(source), topic: stripBody(match), content, truncated };
  }

  private async topicsFor(source: DocsSource, signal?: AbortSignal): Promise<ParsedTopic[]> {
    const cached = this.memCache.get(source.id);
    if (cached) return cached;
    // Coalesce concurrent first reads of one source: parallel tool calls would
    // otherwise each fetch the corpus and race a write to the same cache file.
    const pending = this.inflight.get(source.id);
    if (pending) return pending;
    const load = this.loadTopics(source, signal);
    this.inflight.set(source.id, load);
    try {
      return await load;
    } finally {
      this.inflight.delete(source.id);
    }
  }

  private async loadTopics(source: DocsSource, signal?: AbortSignal): Promise<ParsedTopic[]> {
    const { text, durable } = await this.loadCorpus(source, signal);
    const topics = parseTopics(text);
    // Don't pin a stale fallback: a transient failure on the first read must not
    // freeze outdated docs for the whole process — the next call retries.
    if (durable) this.memCache.set(source.id, topics);
    return topics;
  }

  private async loadCorpus(
    source: DocsSource,
    signal?: AbortSignal,
  ): Promise<{ text: string; durable: boolean }> {
    if (source.content !== undefined) return { text: source.content, durable: true };
    const url = source.llmsFullUrl;
    if (!url) throw new Error("source has neither inline content nor a corpus URL");

    const cachePath = join(this.cacheDir, `${source.id}.txt`);
    const fresh = await this.readFreshCache(cachePath);
    if (fresh !== null) return { text: fresh, durable: true };

    try {
      const res = await this.fetchImpl(url, signal ? { signal } : {});
      if (!res.ok) throw new Error(`fetch ${url} returned ${res.status}`);
      const text = await res.text();
      await this.writeCache(cachePath, text);
      return { text, durable: true };
    } catch (err) {
      // Prefer a stale copy over a hard failure when the network is unavailable,
      // but mark it non-durable so loadTopics won't pin it for the process life.
      const stale = await readFileOrNull(cachePath);
      if (stale !== null) return { text: stale, durable: false };
      throw err;
    }
  }

  private async readFreshCache(cachePath: string): Promise<string | null> {
    try {
      const info = await stat(cachePath);
      if (this.now() - info.mtimeMs > this.ttlMs) return null;
      return await readFile(cachePath, "utf8");
    } catch {
      return null;
    }
  }

  private async writeCache(cachePath: string, text: string): Promise<void> {
    try {
      await mkdir(this.cacheDir, { recursive: true });
      await writeFile(cachePath, text, "utf8");
    } catch {
      // A read-only home shouldn't break docs reads — the corpus is already in
      // memory for this process; only cross-process caching is lost.
    }
  }

  private unknownSourceMessage(id: string): string {
    const ids = [...this.sources.keys()];
    return `Unknown docs source '${id}'. Available sources: ${ids.length > 0 ? ids.join(", ") : "<none>"}.`;
  }

  private loadError(source: DocsSource, err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    return `Could not load docs for '${source.id}': ${msg}`;
  }
}

function stripBody(topic: ParsedTopic): DocsTopic {
  const { body: _body, ...rest } = topic;
  return rest;
}

// Resolve a requested section against the parsed topics, most-specific first:
// exact slug, slugified input, exact title (case-insensitive), then a title
// substring. Keeps a fuzzy model request ("architecture", "the rib model")
// landing on the right page without an exact-slug round-trip.
function matchTopic(topics: readonly ParsedTopic[], section: string): ParsedTopic | undefined {
  const raw = section.trim();
  // A blank/whitespace section (which still clears the schema's min(1)) must not
  // fall through to the substring branch, where `includes("")` matches topic[0].
  if (raw === "") return undefined;
  const slug = slugify(raw);
  const lowered = raw.toLowerCase();
  return (
    topics.find((t) => t.slug === raw) ??
    topics.find((t) => t.slug === slug) ??
    topics.find((t) => t.title.toLowerCase() === lowered) ??
    topics.find((t) => t.title.toLowerCase().includes(lowered))
  );
}

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}
