import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { SandboxChip } from "../src/components/Chat/SandboxChip.tsx";

describe("SandboxChip", () => {
  test("reflects the state in aria-pressed and toggles on click", () => {
    let toggles = 0;
    const { rerender } = render(<SandboxChip enabled={false} onToggle={() => toggles++} />);
    const chip = screen.getByRole("button");
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    expect(chip.getAttribute("aria-label")).toContain("Sandbox off");
    fireEvent.click(chip);
    expect(toggles).toBe(1);
    rerender(<SandboxChip enabled onToggle={() => toggles++} />);
    expect(screen.getByRole("button").getAttribute("aria-pressed")).toBe("true");
  });

  test("a locked chip stays on, cannot be clicked, and says why", () => {
    let toggles = 0;
    render(<SandboxChip enabled locked onToggle={() => toggles++} />);
    const chip = screen.getByRole("button") as HTMLButtonElement;
    expect(chip.disabled).toBe(true);
    expect(chip.getAttribute("data-locked")).toBe("true");
    expect(chip.getAttribute("aria-label")).toContain("KEELSON_SANDBOX=required");
    expect(chip.textContent).toBe("Sandbox (required)");
    fireEvent.click(chip);
    expect(toggles).toBe(0);
  });

  test("an unsupported provider reads as a warning only while the sandbox is on", () => {
    const { rerender } = render(<SandboxChip enabled unsupported onToggle={() => {}} />);
    const chip = screen.getByRole("button");
    expect(chip.getAttribute("data-unsupported")).toBe("true");
    expect(chip.getAttribute("aria-label")).toContain("turns fail closed");
    rerender(<SandboxChip enabled={false} unsupported onToggle={() => {}} />);
    expect(screen.getByRole("button").getAttribute("data-unsupported")).toBeNull();
  });
});
