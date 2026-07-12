import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
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

  test("the instruments menu opens and navigates to Memory, then closes", () => {
    const tabs: ActiveTab[] = [];
    renderBar({ onTabChange: (t) => tabs.push(t) });
    fireEvent.click(screen.getByRole("button", { name: "Harness menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Memory" }));
    expect(tabs).toEqual(["memory"]);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  test("a pending memory count rides the trigger as a dot and the row as a pip", () => {
    const { container } = renderBar({ pendingMemoryCount: 3 });
    expect(container.querySelector(".instruments-dot")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Harness menu" }));
    const memoryItem = screen.getByRole("menuitem", { name: /Memory/ });
    expect(memoryItem.querySelector(".nav-pip")?.textContent).toBe("3");
  });

  test("no dot without a pending count", () => {
    const { container } = renderBar();
    expect(container.querySelector(".instruments-dot")).toBeNull();
  });

  test("while an instrument is active the trigger wears its name as an active chip", () => {
    renderBar({ activeTab: "memory" });
    const trigger = screen.getByRole("button", { name: "Harness menu" });
    expect(trigger.classList.contains("is-active")).toBe(true);
    expect(trigger.textContent).toContain("Memory");
  });

  test("the theme control lives inside the menu", () => {
    renderBar();
    expect(screen.queryByRole("radiogroup", { name: "Theme" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Harness menu" }));
    expect(screen.getByRole("radiogroup", { name: "Theme" })).toBeDefined();
  });

  test("Escape closes the menu", () => {
    renderBar();
    fireEvent.click(screen.getByRole("button", { name: "Harness menu" }));
    expect(screen.getByRole("menu")).toBeDefined();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
