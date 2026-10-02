// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, render } from "@testing-library/react";
import { ModelCatalogPopover } from "../src/components/Canvas/ModelFieldPicker.tsx";
import { ModelPickerPopover } from "../src/components/Chat/ModelPickerPopover.tsx";
import { ProjectPickerPopover } from "../src/components/Chat/ProjectPickerPopover.tsx";
import { configureModelCatalog } from "../src/lib/modelCatalog.ts";
import { pickerPopoverPosition } from "../src/lib/pickerPopoverPosition.ts";

describe("pickerPopoverPosition", () => {
  test("aligns a fitting trigger to its left edge", () => {
    expect(pickerPopoverPosition({ left: 32, right: 159, width: 127 }, 1024, 320)).toEqual({
      left: "32px",
      right: "auto",
      minWidth: "320px",
    });
  });

  describe("picker component placement", () => {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    afterEach(() => {
      window.innerWidth = viewportWidth;
      window.innerHeight = viewportHeight;
      cleanup();
      configureModelCatalog();
    });

    function mount(kind: "project" | "chat" | "canvas" = "project") {
      let rect = { left: 1449, top: 96, width: 127 };
      if (kind === "canvas") {
        configureModelCatalog({
          fetchProviders: async () => ({ providers: [], defaultProvider: null }),
          fetchProviderModels: async () => [],
        });
      }
      render(
        <>
          <button id="test-trigger" type="button" popoverTarget="test-picker">
            Projects
          </button>
          {kind === "project" ? (
            <ProjectPickerPopover
              popoverId="test-picker"
              projects={[]}
              activeProjectId={null}
              onSelect={() => {}}
              onProjectUpdated={() => {}}
              onProjectDeleted={() => {}}
            />
          ) : kind === "chat" ? (
            <ModelPickerPopover
              popoverId="test-picker"
              providers={[]}
              modelsByProvider={{}}
              activeRef={null}
              favorites={[]}
              lockedProviderId={null}
              onSelect={() => {}}
              onToggleFavorite={() => {}}
            />
          ) : (
            <ModelCatalogPopover
              popoverId="test-picker"
              anchorId="test-trigger"
              value=""
              providerValue=""
              emptyLabel="default"
              required={true}
              onPick={() => {}}
            />
          )}
        </>,
      );
      const trigger = document.querySelector<HTMLElement>('[popovertarget="test-picker"]');
      const popover = document.getElementById("test-picker");
      if (!trigger || !popover) throw new Error("picker fixture did not render");
      trigger.getBoundingClientRect = () => new DOMRect(rect.left, rect.top, rect.width, 30);

      return {
        trigger,
        popover,
        setRect(next: typeof rect) {
          rect = next;
        },
      };
    }

    function dispatch(popover: HTMLElement, type: "beforetoggle" | "toggle") {
      const event = new Event(type);
      Object.defineProperty(event, "newState", { value: "open" });
      act(() => {
        popover.dispatchEvent(event);
      });
    }

    test("positions at the trigger right edge before first paint and on toggle", () => {
      window.innerWidth = 1600;
      window.innerHeight = 900;
      const { popover } = mount();
      expect(popover.offsetWidth).toBe(0);

      for (const type of ["beforetoggle", "toggle"] as const) {
        dispatch(popover, type);
        expect(popover.style.left).toBe("auto");
        expect(popover.style.right).toBe("24px");
        expect(popover.style.minWidth).toBe("320px");
        expect(popover.style.top).toBe("132px");
        expect(popover.style.maxHeight).toBe("762px");
      }
    });

    test("tracks an open resize and leaves closed placement unchanged", () => {
      window.innerWidth = 1600;
      window.innerHeight = 900;
      const { trigger, popover, setRect } = mount();
      dispatch(popover, "beforetoggle");
      popover.matches = (selector) => selector === ":popover-open";

      window.innerWidth = 1024;
      setRect({ left: 873, top: 850, width: 127 });
      act(() => window.dispatchEvent(new Event("resize")));
      expect(popover.style.right).toBe("24px");
      expect(popover.style.bottom).toBe("56px");
      expect(popover.style.top).toBe("auto");
      expect(popover.style.maxHeight).toBe("838px");

      popover.matches = () => false;
      window.innerWidth = 1600;
      trigger.getBoundingClientRect = () => new DOMRect(32, 96, 127, 30);
      act(() => window.dispatchEvent(new Event("resize")));
      expect(popover.style.right).toBe("24px");
    });

    test("clears the right inset in the centered fallback and on left re-anchor", () => {
      window.innerWidth = 1600;
      window.innerHeight = 900;
      const { trigger, popover, setRect } = mount();
      dispatch(popover, "beforetoggle");
      const parent = trigger.parentElement;
      if (!parent) throw new Error("project trigger has no parent");
      trigger.remove();

      dispatch(popover, "toggle");
      expect(popover.style.left).toBe("50%");
      expect(popover.style.right).toBe("auto");
      expect(popover.style.transform).toBe("translateX(-50%)");
      expect(popover.style.minWidth).toBe("");
      expect(popover.style.maxHeight).toBe("");

      setRect({ left: 32, top: 96, width: 127 });
      parent.appendChild(trigger);
      dispatch(popover, "beforetoggle");
      expect(popover.style.left).toBe("32px");
      expect(popover.style.right).toBe("auto");
      expect(popover.style.transform).toBe("none");
    });

    test("chat model picker uses its 280px minimum and resets the centered fallback", () => {
      window.innerWidth = 1600;
      window.innerHeight = 900;
      const { trigger, popover } = mount("chat");
      expect(popover.offsetWidth).toBe(0);

      dispatch(popover, "beforetoggle");
      expect(popover.style.left).toBe("auto");
      expect(popover.style.right).toBe("24px");
      expect(popover.style.minWidth).toBe("280px");
      dispatch(popover, "toggle");
      expect(popover.style.right).toBe("24px");

      const parent = trigger.parentElement;
      if (!parent) throw new Error("model trigger has no parent");
      trigger.remove();
      dispatch(popover, "beforetoggle");
      expect(popover.style.left).toBe("50%");
      expect(popover.style.right).toBe("auto");
      expect(popover.style.transform).toBe("translateX(-50%)");

      parent.appendChild(trigger);
      trigger.getBoundingClientRect = () => new DOMRect(32, 96, 127, 30);
      dispatch(popover, "toggle");
      expect(popover.style.left).toBe("32px");
      expect(popover.style.right).toBe("auto");
      expect(popover.style.transform).toBe("none");
    });

    test("canvas model catalog uses the trigger ID and remains anchored after resizing", () => {
      window.innerWidth = 1600;
      window.innerHeight = 900;
      const { trigger, popover, setRect } = mount("canvas");
      expect(popover.offsetWidth).toBe(0);

      dispatch(popover, "beforetoggle");
      dispatch(popover, "toggle");
      expect(popover.style.left).toBe("auto");
      expect(popover.style.right).toBe("24px");
      expect(popover.style.minWidth).toBe("280px");

      popover.matches = (selector) => selector === ":popover-open";
      window.innerWidth = 1024;
      setRect({ left: 873, top: 96, width: 127 });
      act(() => window.dispatchEvent(new Event("resize")));
      expect(popover.style.right).toBe("24px");

      const parent = trigger.parentElement;
      if (!parent) throw new Error("canvas trigger has no parent");
      trigger.remove();
      dispatch(popover, "beforetoggle");
      expect(popover.style.left).toBe("50%");
      expect(popover.style.right).toBe("auto");

      parent.appendChild(trigger);
      setRect({ left: 32, top: 96, width: 127 });
      dispatch(popover, "toggle");
      expect(popover.style.left).toBe("32px");
      expect(popover.style.right).toBe("auto");
      expect(popover.style.transform).toBe("none");
    });
  });

  test("aligns a right-edge trigger to its right edge at both desktop widths", () => {
    expect(pickerPopoverPosition({ left: 1449, right: 1576, width: 127 }, 1600, 320)).toEqual({
      left: "auto",
      right: "24px",
      minWidth: "320px",
    });
    expect(pickerPopoverPosition({ left: 873, right: 1000, width: 127 }, 1024, 280)).toEqual({
      left: "auto",
      right: "24px",
      minWidth: "280px",
    });
  });

  test("picker CSS keeps the 460px maximum and two 6px viewport gutters", () => {
    const css = readFileSync(join(import.meta.dir, "../src/app.css"), "utf8");
    const rule = css.match(/\.model-picker-popover \{([^}]+)\}/)?.[1];
    expect(rule).toContain("width: max-content;");
    expect(rule).toContain("max-width: min(460px, calc(100vw - 12px));");
  });

  test("switches alignment only once the maximum-width panel no longer fits", () => {
    expect(pickerPopoverPosition({ left: 558, right: 658, width: 100 }, 1024, 280)).toEqual({
      left: "558px",
      right: "auto",
      minWidth: "280px",
    });
    expect(pickerPopoverPosition({ left: 559, right: 659, width: 100 }, 1024, 280)).toEqual({
      left: "auto",
      right: "365px",
      minWidth: "280px",
    });
  });

  test("clamps either edge and caps the minimum width to the viewport", () => {
    expect(pickerPopoverPosition({ left: -20, right: 107, width: 127 }, 1024, 320)).toEqual({
      left: "6px",
      right: "auto",
      minWidth: "320px",
    });
    expect(pickerPopoverPosition({ left: 1000, right: 1200, width: 200 }, 1024, 280)).toEqual({
      left: "auto",
      right: "6px",
      minWidth: "280px",
    });
    expect(pickerPopoverPosition({ left: 370, right: 870, width: 500 }, 375, 320)).toEqual({
      left: "auto",
      right: "6px",
      minWidth: "363px",
    });
    expect(pickerPopoverPosition({ left: 0, right: 20, width: 20 }, 8, 280)).toEqual({
      left: "auto",
      right: "6px",
      minWidth: "0px",
    });
  });
});
