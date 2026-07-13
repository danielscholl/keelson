// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { UsagePopoverPanel } from "../src/components/Chat/UsagePopover.tsx";

// Fire a popover toggle the way the browser does: async, carrying `newState`.
function fireToggle(el: Element, type: "beforetoggle" | "toggle", newState: "open" | "closed") {
  const ev = new Event(type);
  Object.defineProperty(ev, "newState", { value: newState });
  el.dispatchEvent(ev);
}

describe("UsagePopoverPanel positioning", () => {
  // The vanish-branch centring and the anchored transform reset are duplicated
  // across all six popovers; this exercises that shared shape on the simplest one.
  test("centres measurement-free with no anchor, then resets the transform on re-anchor", () => {
    const { container } = render(
      <UsagePopoverPanel popoverId="usage-pop">
        <div>content</div>
      </UsagePopoverPanel>,
    );
    const panel = container.querySelector("#usage-pop") as HTMLElement;

    // No trigger in the DOM: on `beforetoggle` the panel is still display:none
    // (offsetWidth 0), so the vanish branch must centre via transform, not width
    // math — otherwise it would jump to the viewport's right half for a frame.
    fireToggle(panel, "beforetoggle", "open");
    expect(panel.style.left).toBe("50%");
    expect(panel.style.transform).toBe("translateX(-50%)");
    expect(panel.style.bottom).toBe("auto");
    expect(panel.style.top).not.toBe("");

    // Anchor present: the panel anchors to it and clears the centring transform,
    // or the explicit left would be shifted left by half the panel's width.
    const trigger = document.createElement("button");
    trigger.setAttribute("popovertarget", "usage-pop");
    document.body.appendChild(trigger);
    fireToggle(panel, "toggle", "open");
    expect(panel.style.transform).toBe("none");
    trigger.remove();
  });
});
