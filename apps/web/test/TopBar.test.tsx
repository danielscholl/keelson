import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { type ActiveTab, TopBar } from "../src/components/TopBar.tsx";

function renderBar(overrides: Partial<Parameters<typeof TopBar>[0]> = {}) {
  const props = {
    activeTab: "chat" as ActiveTab,
    onTabChange: () => {},
    themePreference: "system" as const,
    onThemeChange: () => {},
    ...overrides,
  };
  return render(<TopBar {...props} />);
}

describe("TopBar", () => {
  test("the tab row holds workspaces only — Memory and Usage are not tabs", () => {
    renderBar({
      surfaceTabs: [{ id: "surface:chamber:home", title: "Chamber" }],
    });
    const nav = screen.getByRole("navigation", { name: "Primary" });
    const labels = [...nav.querySelectorAll(".nav-tab")].map((b) => b.textContent);
    expect(labels).toEqual(["Chat", "Workflows", "Chamber"]);
  });

  test("the hull/ribs divider renders only when a rib surface exists", () => {
    const { container, rerender } = renderBar();
    expect(container.querySelector(".nav-divider")).toBeNull();
    rerender(
      <TopBar
        activeTab="chat"
        onTabChange={() => {}}
        themePreference="system"
        onThemeChange={() => {}}
        surfaceTabs={[{ id: "surface:chamber:home", title: "Chamber" }]}
      />,
    );
    expect(container.querySelector(".nav-divider")).not.toBeNull();
  });

  test("the instruments popover navigates, closes, and returns focus to its trigger", () => {
    const tabs: ActiveTab[] = [];
    renderBar({ onTabChange: (t) => tabs.push(t) });
    const trigger = screen.getByRole("button", { name: /Harness/ });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Memory" }));
    expect(tabs).toEqual(["memory"]);
    expect(screen.queryByLabelText("Harness")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  test("a pending memory count rides the trigger as a dot and the row as a pip", () => {
    const { container } = renderBar({ pendingMemoryCount: 3 });
    expect(container.querySelector(".instruments-dot")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Harness.*3 pending/ }));
    const memoryItem = screen.getByRole("button", { name: /Memory/ });
    expect(memoryItem.querySelector(".nav-pip")?.textContent).toBe("3");
  });

  test("no dot without a pending count", () => {
    const { container } = renderBar();
    expect(container.querySelector(".instruments-dot")).toBeNull();
  });

  test("while an instrument is active the trigger wears its name as an active chip", () => {
    renderBar({ activeTab: "memory", pendingMemoryCount: 2 });
    const trigger = screen.getByRole("button", { name: /Harness.*Memory.*2 pending/ });
    expect(trigger.classList.contains("is-active")).toBe(true);
    expect(trigger.textContent).toContain("Memory");
    fireEvent.click(trigger);
    const menu = screen.getByRole("region", { name: "Harness" });
    expect(
      within(menu)
        .getByRole("button", { name: /Memory/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(within(menu).getByRole("button", { name: "Usage" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  test("the theme control lives inside the popover", () => {
    renderBar();
    expect(screen.queryByRole("radiogroup", { name: "Theme" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Harness/ }));
    expect(screen.getByRole("radiogroup", { name: "Theme" })).toBeDefined();
  });

  test("the popover moves focus inside and Escape returns it to the trigger", () => {
    renderBar();
    const trigger = screen.getByRole("button", { name: /Harness/ });
    fireEvent.click(trigger);
    expect(screen.getByLabelText("Harness")).toBeDefined();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Memory" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByLabelText("Harness")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
