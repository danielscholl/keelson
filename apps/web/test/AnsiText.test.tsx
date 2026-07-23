// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { AnsiText } from "../src/components/AnsiText.tsx";

describe("AnsiText", () => {
  test("renders plain text with no styling spans", () => {
    const { container } = render(<AnsiText text="hello world" />);
    expect(container.textContent).toBe("hello world");
    // A plain chunk emits no wrapper span — only the .ansi-text root.
    expect(container.querySelectorAll(".ansi-text span").length).toBe(0);
  });

  test("maps a named ANSI color to an -fg class", () => {
    const { container } = render(<AnsiText text={"\x1b[32mgreen\x1b[0m"} />);
    const span = container.querySelector("span.ansi-green-fg");
    expect(span?.textContent).toBe("green");
    expect(container.textContent).toBe("green");
  });

  test("carries decorations as ansi-<name> classes alongside the color", () => {
    const { container } = render(<AnsiText text={"\x1b[1;32mok\x1b[0m"} />);
    const span = container.querySelector("span.ansi-green-fg.ansi-bold");
    expect(span?.textContent).toBe("ok");
  });

  test("renders 24-bit truecolor (Rich/pygments) as an inline rgb() style, no class", () => {
    const { container } = render(<AnsiText text={"\x1b[38;2;224;106;156mkey\x1b[0m"} />);
    const span = container.querySelector('span[style*="color"]') as HTMLElement | null;
    expect(span?.textContent).toBe("key");
    expect(span?.style.color).toBe("rgb(224, 106, 156)");
    expect(container.querySelector(".ansi-truecolor-fg")).toBeNull();
  });

  test("a combined fg+bg SGR keeps both classes so the foreground survives", () => {
    // The -bg palette rules only force a contrasting ink when no -fg class is
    // present, so both must be emitted for the requested foreground to win.
    const { container } = render(<AnsiText text={"\x1b[31;42mon\x1b[0m"} />);
    const span = container.querySelector("span.ansi-red-fg.ansi-green-bg");
    expect(span?.textContent).toBe("on");
  });

  test("preserves surrounding plain text across styled chunks", () => {
    const { container } = render(<AnsiText text={"a \x1b[31mb\x1b[0m c"} />);
    expect(container.textContent).toBe("a b c");
    expect(container.querySelector(".ansi-red-fg")?.textContent).toBe("b");
  });
});
