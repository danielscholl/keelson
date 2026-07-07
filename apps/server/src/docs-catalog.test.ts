// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DocsCatalog, type DocsSource, parseTopics, stampRibDocsSources } from "./docs-catalog.ts";

const CORPUS = `<SYSTEM>preamble ignored</SYSTEM>

# Alpha

> Alpha summary line.

Alpha body one.
Alpha body two.

# Beta Topic

Beta body, no summary.

## Beta sub

more beta.
`;

function inlineSource(overrides: Partial<DocsSource> = {}): DocsSource {
  return { id: "test", title: "Test", summary: "A test source.", content: CORPUS, ...overrides };
}

describe("parseTopics", () => {
  test("splits on H1, drops pre-heading preamble, captures blockquote summary", () => {
    const topics = parseTopics(CORPUS);
    expect(topics.map((t) => t.slug)).toEqual(["alpha", "beta-topic"]);
    expect(topics[0]?.title).toBe("Alpha");
    expect(topics[0]?.summary).toBe("Alpha summary line.");
    expect(topics[1]?.summary).toBeUndefined();
    // The Beta topic's body carries its own H2 sub-section, not Alpha's content.
    expect(topics[1]?.body).toContain("## Beta sub");
    expect(topics[1]?.body).not.toContain("Alpha body");
  });

  test("de-duplicates colliding slugs so same-titled pages stay addressable", () => {
    const topics = parseTopics("# Dup\n\nfirst\n\n# Dup\n\nsecond\n");
    expect(topics.map((t) => t.slug)).toEqual(["dup", "dup-2"]);
  });

  test("does not split on a '# ' line inside a fenced code block", () => {
    const corpus = "# Real\n\n```bash\n# not a heading\n```\n\nafter fence.\n";
    const topics = parseTopics(corpus);
    expect(topics.map((t) => t.slug)).toEqual(["real"]);
    expect(topics[0]?.body).toContain("# not a heading");
    expect(topics[0]?.body).toContain("after fence.");
  });

  test("drops a '> [!NOTE]' admonition marker rather than using it as a summary", () => {
    const topics = parseTopics("# Note\n\n> [!NOTE] deprecated\n\nbody.\n");
    expect(topics[0]?.summary).toBeUndefined();
  });
});

describe("DocsCatalog inline sources", () => {
  const catalog = new DocsCatalog({ sources: [inlineSource()], cacheDir: "/nonexistent" });

  test("list() surfaces id/title/summary", () => {
    expect(catalog.list()).toEqual([{ id: "test", title: "Test", summary: "A test source." }]);
  });

  test("toc() returns topics without bodies", async () => {
    const res = await catalog.toc("test");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.topics.map((t) => t.slug)).toEqual(["alpha", "beta-topic"]);
    expect(Object.hasOwn(res.topics[0] ?? {}, "body")).toBe(false);
  });

  test("readSection() matches by slug", async () => {
    const res = await catalog.readSection("test", "alpha");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.content).toContain("Alpha body one.");
    expect(res.truncated).toBe(false);
  });

  test("readSection() matches by title case-insensitively", async () => {
    const res = await catalog.readSection("test", "beta topic");
    expect(res.ok && res.topic.slug).toBe("beta-topic");
  });

  test("readSection() on a missing section fails with the available topics", async () => {
    const res = await catalog.readSection("test", "nope");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.topics?.map((t) => t.slug)).toEqual(["alpha", "beta-topic"]);
  });

  test("a whitespace-only section (clears schema min(1)) does not return topic[0]", async () => {
    const res = await catalog.readSection("test", "   ");
    expect(res.ok).toBe(false);
  });

  test("unknown source id fails closed and lists what is available", async () => {
    const res = await catalog.toc("ghost");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("test");
  });
});

describe("DocsCatalog section cap", () => {
  test("truncates an oversized topic and flags it", async () => {
    const big = `# Big\n\n${"x".repeat(200)}\n`;
    const catalog = new DocsCatalog({
      sources: [inlineSource({ content: big })],
      cacheDir: "/nonexistent",
      maxSectionChars: 50,
    });
    const res = await catalog.readSection("test", "big");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.truncated).toBe(true);
    expect(res.content).toContain("truncated");
    expect(res.content.length).toBeLessThan(big.length);
  });
});

describe("DocsCatalog first-registration wins", () => {
  test("a duplicate id cannot shadow the first source", () => {
    const catalog = new DocsCatalog({
      sources: [
        inlineSource({ id: "keelson", title: "Core" }),
        inlineSource({ id: "keelson", title: "Impostor" }),
      ],
      cacheDir: "/nonexistent",
    });
    expect(catalog.list()).toEqual([{ id: "keelson", title: "Core", summary: "A test source." }]);
  });
});

describe("DocsCatalog URL fetch + cache", () => {
  let cacheDir: string;
  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), "keelson-docs-"));
  });
  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  function urlSource(): DocsSource {
    return {
      id: "web",
      title: "Web",
      summary: "url source",
      llmsFullUrl: "https://example/full.txt",
    };
  }

  test("fetches once, then serves the in-memory corpus on repeat reads", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(CORPUS);
    }) as unknown as typeof fetch;
    const catalog = new DocsCatalog({ sources: [urlSource()], cacheDir, fetchImpl });
    await catalog.toc("web");
    await catalog.readSection("web", "alpha");
    expect(calls).toBe(1);
  });

  test("serves a within-TTL disk cache without refetching", async () => {
    const seed = new DocsCatalog({
      sources: [urlSource()],
      cacheDir,
      fetchImpl: (async () => new Response(CORPUS)) as unknown as typeof fetch,
    });
    await seed.toc("web"); // writes the disk cache

    // A fresh catalog (empty mem cache) with a wide TTL must read from disk, not
    // fetch — exercises the readFreshCache non-stale branch.
    let calls = 0;
    const cold = new DocsCatalog({
      sources: [urlSource()],
      cacheDir,
      ttlMs: 60_000,
      fetchImpl: (async () => {
        calls += 1;
        return new Response("SHOULD-NOT-FETCH");
      }) as unknown as typeof fetch,
    });
    const res = await cold.toc("web");
    expect(res.ok).toBe(true);
    expect(calls).toBe(0);
  });

  test("coalesces concurrent first reads of a source into a single fetch", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 10)); // keep both callers in-flight
      return new Response(CORPUS);
    }) as unknown as typeof fetch;
    const catalog = new DocsCatalog({ sources: [urlSource()], cacheDir, fetchImpl });
    await Promise.all([catalog.toc("web"), catalog.readSection("web", "alpha")]);
    expect(calls).toBe(1);
  });

  test("one caller aborting a coalesced read does not fail a concurrent caller", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 20)); // both callers share this fetch
      return new Response(CORPUS);
    }) as unknown as typeof fetch;
    const catalog = new DocsCatalog({ sources: [urlSource()], cacheDir, fetchImpl });
    const ac = new AbortController();
    const abortedP = catalog.toc("web", ac.signal); // creates the shared load
    const healthyP = catalog.readSection("web", "alpha"); // joins the same load, no signal
    ac.abort();
    const [aborted, healthy] = await Promise.all([abortedP, healthyP]);
    expect(aborted.ok).toBe(false); // the aborting caller's own signal is observed
    expect(healthy.ok).toBe(true); // the other caller still gets the corpus
    expect(calls).toBe(1); // the shared fetch was not cancelled
  });

  test("a stale fallback is not pinned; each read retries the fetch", async () => {
    const seed = new DocsCatalog({
      sources: [urlSource()],
      cacheDir,
      fetchImpl: (async () => new Response(CORPUS)) as unknown as typeof fetch,
    });
    await seed.toc("web"); // writes a disk copy

    let calls = 0;
    const offline = new DocsCatalog({
      sources: [urlSource()],
      cacheDir,
      ttlMs: -1, // disk always stale → always attempts a (failing) fetch
      fetchImpl: (async () => {
        calls += 1;
        throw new Error("offline");
      }) as unknown as typeof fetch,
    });
    await offline.toc("web"); // fetch fails → stale disk, must not pin
    await offline.toc("web"); // retries rather than serving pinned stale
    expect(calls).toBe(2);
  });

  test("falls back to a written cache when a later fetch fails", async () => {
    const good = new DocsCatalog({
      sources: [urlSource()],
      cacheDir,
      fetchImpl: (async () => new Response(CORPUS)) as unknown as typeof fetch,
    });
    await good.toc("web");

    // A fresh catalog (empty mem cache) whose fetch always throws must still
    // resolve from the corpus the first one wrote to disk.
    const offline = new DocsCatalog({
      sources: [urlSource()],
      cacheDir,
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
      // Force past the freshness window so it attempts a (failing) refetch.
      ttlMs: -1,
    });
    const res = await offline.toc("web");
    expect(res.ok).toBe(true);
  });

  test("a non-ok response with no cache surfaces a load error", async () => {
    const catalog = new DocsCatalog({
      sources: [urlSource()],
      cacheDir,
      fetchImpl: (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch,
    });
    const res = await catalog.toc("web");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("503");
  });
});

describe("stampRibDocsSources", () => {
  const src = (title: string) => ({ title, summary: "s", llmsFullUrl: "https://x/full.txt" });

  test("a single-source rib keeps its bare rib id", () => {
    const out = stampRibDocsSources([{ ribId: "chamber", source: src("Chamber") }]);
    expect(out.map((s) => s.id)).toEqual(["chamber"]);
  });

  test("a multi-source rib gets per-title suffixes so none are dropped", () => {
    const out = stampRibDocsSources([
      { ribId: "chamber", source: src("Rooms") },
      { ribId: "chamber", source: src("Lenses") },
    ]);
    expect(out.map((s) => s.id)).toEqual(["chamber-rooms", "chamber-lenses"]);
  });
});
