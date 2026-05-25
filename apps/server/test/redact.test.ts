// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import {
  runWithRedaction,
  scrubArg,
  wrapConsole,
} from "../src/redact.ts";

type ConsoleMethod = "log" | "warn" | "error" | "info" | "debug";

function makeFakeConsole(): {
  console: Record<ConsoleMethod, (...args: unknown[]) => void>;
  captured: Array<{ method: ConsoleMethod; args: unknown[] }>;
} {
  const captured: Array<{ method: ConsoleMethod; args: unknown[] }> = [];
  const make = (method: ConsoleMethod) => (...args: unknown[]) => {
    captured.push({ method, args });
  };
  return {
    captured,
    console: {
      log: make("log"),
      warn: make("warn"),
      error: make("error"),
      info: make("info"),
      debug: make("debug"),
    },
  };
}

describe("scrubArg", () => {
  test("replaces every occurrence of every value", () => {
    expect(scrubArg("token=s3cret bar=s3cret", ["s3cret"])).toBe(
      "token=[REDACTED] bar=[REDACTED]",
    );
  });

  test("supports multiple values", () => {
    expect(scrubArg("a=AAA b=BBB", ["AAA", "BBB"])).toBe(
      "a=[REDACTED] b=[REDACTED]",
    );
  });

  test("non-string args pass through unchanged (objects, numbers, null)", () => {
    const obj = { secret: "x" };
    expect(scrubArg(obj, ["x"])).toBe(obj);
    expect(scrubArg(42, ["42"])).toBe(42);
    expect(scrubArg(null, ["null"])).toBe(null);
    expect(scrubArg(undefined, ["whatever"])).toBe(undefined);
  });

  test("empty values list is a no-op", () => {
    expect(scrubArg("token=secret", [])).toBe("token=secret");
  });

  test("ignores empty / non-string entries in the values list", () => {
    expect(scrubArg("token=secret", ["", "secret"])).toBe(
      "token=[REDACTED]",
    );
  });
});

describe("runWithRedaction + wrapConsole", () => {
  test("scrubs string args inside scope, passes through outside", () => {
    const { console: fake, captured } = makeFakeConsole();
    wrapConsole(fake);

    runWithRedaction(["s3cret"], () => {
      fake.log("token=s3cret bar");
      fake.warn("login s3cret");
    });
    fake.log("token=s3cret outside");

    expect(captured).toEqual([
      { method: "log", args: ["token=[REDACTED] bar"] },
      { method: "warn", args: ["login [REDACTED]"] },
      { method: "log", args: ["token=s3cret outside"] },
    ]);
  });

  test("propagates context across awaits", async () => {
    const { console: fake, captured } = makeFakeConsole();
    wrapConsole(fake);

    await runWithRedaction(["v"], async () => {
      await Promise.resolve();
      fake.log("post-await v");
    });

    expect(captured).toEqual([{ method: "log", args: ["post-await [REDACTED]"] }]);
  });

  test("multiple secret values scrub independently", () => {
    const { console: fake, captured } = makeFakeConsole();
    wrapConsole(fake);

    runWithRedaction(["alpha", "beta"], () => {
      fake.error("alpha then beta");
    });

    expect(captured).toEqual([
      { method: "error", args: ["[REDACTED] then [REDACTED]"] },
    ]);
  });

  test("non-string args bypass scrubbing", () => {
    const { console: fake, captured } = makeFakeConsole();
    wrapConsole(fake);

    const errObj = new Error("alpha leaked");
    runWithRedaction(["alpha"], () => {
      fake.error(errObj, 42, { msg: "alpha" });
    });

    // Object args pass through; string interpolation is the route handler's
    // responsibility, not the redactor's.
    expect(captured).toHaveLength(1);
    expect(captured[0]!.args[0]).toBe(errObj);
    expect(captured[0]!.args[1]).toBe(42);
    expect(captured[0]!.args[2]).toEqual({ msg: "alpha" });
  });

  test("wrapConsole is idempotent", () => {
    const { console: fake, captured } = makeFakeConsole();
    wrapConsole(fake);
    const wrappedLog = fake.log;
    wrapConsole(fake);
    // Re-wrapping would chain the scrubber; we want a single wrap.
    expect(fake.log).toBe(wrappedLog);

    runWithRedaction(["x"], () => fake.log("x y x"));
    expect(captured).toEqual([{ method: "log", args: ["[REDACTED] y [REDACTED]"] }]);
  });
});
