// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { useDrawerDismiss } from "../src/hooks/useDrawerDismiss.ts";

function Drawer({ name, onClose }: { name: string; onClose: () => void }) {
  const { dialogRef, closeRef, onKeyDown } = useDrawerDismiss(onClose);
  return (
    <aside ref={dialogRef} role="dialog" aria-label={name} onKeyDown={onKeyDown}>
      <button ref={closeRef} type="button">
        close {name}
      </button>
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
});
