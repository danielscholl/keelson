// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import { resolveAddPin } from "../src/commands/rib.ts";
import type { ResolveTags } from "../src/rib-version.ts";

const SOURCE = "https://github.com/acme/keelson-rib-x";

const tags =
  (...list: string[]): ResolveTags =>
  async () => ({ kind: "resolved", tags: list });

const unreachable: ResolveTags = async () => ({
  kind: "unreachable",
  reason: "Repository not found.",
});

describe("resolveAddPin", () => {
  test("pins to the newest release so an unreleased commit is never installed", async () => {
    const pin = await resolveAddPin(SOURCE, undefined, tags("v0.9.0", "v1.0.0"));
    expect(pin).toMatchObject({ spec: `${SOURCE}#v1.0.0`, tag: "v1.0.0", unreadable: null });
  });

  test("skips prereleases when choosing the pin", async () => {
    const pin = await resolveAddPin(SOURCE, undefined, tags("v1.0.0", "v1.1.0-rc.1"));
    expect(pin.tag).toBe("v1.0.0");
  });

  // A repo that has never cut a release is a legitimate thing to install; the
  // command just has to say the pin did not happen.
  test("installs a tagless repo from its default branch, and says so", async () => {
    const pin = await resolveAddPin(SOURCE, undefined, tags("nightly"));
    expect(pin.spec).toBe(SOURCE);
    expect(pin.tag).toBeNull();
    expect(pin.unpinned).toContain("no release tags yet");
    expect(pin.unreadable).toBeNull();
  });

  // Distinct from the case above: installing anyway would take whatever the
  // default branch holds while reporting nothing went wrong.
  test("refuses to guess when the tags could not be read at all", async () => {
    const pin = await resolveAddPin(SOURCE, undefined, unreachable);
    expect(pin.unreadable).toBe("Repository not found.");
    expect(pin.unpinned).toBeNull();
  });

  test("--ref installs that ref and never consults the tags", async () => {
    const pin = await resolveAddPin(SOURCE, "main", unreachable);
    expect(pin).toMatchObject({ spec: `${SOURCE}#main`, tag: null, unreadable: null });
  });

  test("leaves a source the operator already pinned alone", async () => {
    const pin = await resolveAddPin(`${SOURCE}#v0.1.0`, undefined, tags("v9.9.9"));
    expect(pin.spec).toBe(`${SOURCE}#v0.1.0`);
  });

  test("passes a non-git source straight through", async () => {
    const pin = await resolveAddPin("@keelson/rib-x", undefined, tags("v1.0.0"));
    expect(pin).toMatchObject({ spec: "@keelson/rib-x", tag: null, unreadable: null });
  });

  test("reports that --ref cannot apply to a non-git source", async () => {
    const pin = await resolveAddPin("/tmp/rib-x", "main", tags());
    expect(pin.spec).toBe("/tmp/rib-x");
    expect(pin.unpinned).toContain("--ref does not apply");
  });
});
