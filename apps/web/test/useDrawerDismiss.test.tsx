// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { useDrawerDismiss } from "../src/hooks/useDrawerDismiss.ts";

function Drawer({
  name,
  onClose,
  extra,
  trapFocus,
}: {
  name: string;
  onClose: () => void;
  extra?: boolean;
  trapFocus?: boolean;
}) {
  const { dialogRef, closeRef } = useDrawerDismiss(onClose, { trapFocus });
  return (
    <aside ref={dialogRef} role="dialog" aria-label={name}>
      <button ref={closeRef} type="button">
        close {name}
      </button>
      {extra && (
        <button type="button" data-testid="last">
          last {name}
        </button>
      )}
    </aside>
  );
}

describe("useDrawerDismiss", () => {
  test("Escape peels only the topmost drawer", () => {
    const closed: string[] = [];
    const view = render(<Drawer name="run" onClose={() => closed.push("run")} />);

    // The run drawer's trace can open a canvas over itself; both listen on
    // `document`, so an ungated handler would collapse the whole stack at once.
    view.rerender(
      <>
        <Drawer name="run" onClose={() => closed.push("run")} />
        <Drawer name="canvas" onClose={() => closed.push("canvas")} />
      </>,
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(closed).toEqual(["canvas"]);

    // Unmounting the canvas hands the top of the stack back to the run drawer.
    view.rerender(<Drawer name="run" onClose={() => closed.push("run")} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(closed).toEqual(["canvas", "run"]);
  });

  test("a lone drawer still closes on Escape", () => {
    let closed = 0;
    render(<Drawer name="solo" onClose={() => closed++} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(closed).toBe(1);
  });

  test("focus lands on the close button when the drawer opens", () => {
    render(<Drawer name="focus" onClose={() => {}} />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "close focus" }));
  });

  test("non-modal drawers leave Tab alone but still close on Escape", () => {
    let closed = 0;
    render(
      <>
        <button type="button">outside</button>
        <Drawer name="side" onClose={() => closed++} trapFocus={false} />
      </>,
    );
    const outside = screen.getByRole("button", { name: "outside" });
    outside.focus();
    expect(fireEvent.keyDown(outside, { key: "Tab" })).toBe(true);
    expect(fireEvent.keyDown(outside, { key: "Tab", shiftKey: true })).toBe(true);
    expect(document.activeElement).toBe(outside);
    fireEvent.keyDown(outside, { key: "Escape" });
    expect(closed).toBe(1);
  });

  test("changing trapping in place updates Tab handling without refocusing", () => {
    const onClose = () => {};
    const view = render(<Drawer name="changing" onClose={onClose} />);
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    try {
      outside.focus();
      view.rerender(<Drawer name="changing" onClose={onClose} trapFocus={false} />);
      expect(document.activeElement).toBe(outside);
      expect(fireEvent.keyDown(outside, { key: "Tab" })).toBe(true);
      view.rerender(<Drawer name="changing" onClose={onClose} trapFocus />);
      expect(document.activeElement).toBe(outside);
      expect(fireEvent.keyDown(outside, { key: "Tab" })).toBe(false);
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "close changing" }));
    } finally {
      outside.remove();
    }
  });

  // The page beneath isn't inert, so a programmatic focus move out (or an
  // element unmounting under focus) must not let Tab walk background controls.
  // Every key event here is dispatched FROM the background element, which is
  // where the browser dispatches it — a dialog-scoped handler never sees it.
  describe("Tab treats focus outside the dialog as a boundary in both directions", () => {
    function setup() {
      const outside = document.createElement("button");
      document.body.appendChild(outside);
      render(<Drawer name="trap" onClose={() => {}} extra />);
      outside.focus();
      return { outside };
    }

    test("forward Tab re-enters at the first control", () => {
      const { outside } = setup();
      fireEvent.keyDown(outside, { key: "Tab" });
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "close trap" }));
      outside.remove();
    });

    test("Shift+Tab re-enters at the last control", () => {
      const { outside } = setup();
      fireEvent.keyDown(outside, { key: "Tab", shiftKey: true });
      expect(document.activeElement).toBe(screen.getByTestId("last"));
      outside.remove();
    });

    test("Tab still cycles when focus is inside the dialog", () => {
      const { outside } = setup();
      const close = screen.getByRole("button", { name: "close trap" });
      const last = screen.getByTestId("last");
      last.focus();
      fireEvent.keyDown(last, { key: "Tab" });
      expect(document.activeElement).toBe(close);
      fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
      expect(document.activeElement).toBe(last);
      outside.remove();
    });
  });
});
