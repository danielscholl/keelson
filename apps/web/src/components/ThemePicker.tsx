import { DESIGN_PALETTES } from "@keelson/shared";
import type React from "react";
import type { PalettePreference, ThemePreference } from "../hooks/useSettings.ts";

interface ThemePickerProps {
  value: ThemePreference;
  onChange: (value: ThemePreference) => void;
}

const OPTIONS: Array<{
  value: ThemePreference;
  label: string;
  icon: () => React.ReactElement;
}> = [
  { value: "light", label: "Light", icon: SunIcon },
  { value: "system", label: "System", icon: MonitorIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
];

// The radio-group keyboard contract: one Tab stop on the checked option, and the
// arrow keys move both selection and focus, wrapping at the ends.
function onRadioKeyDown<T extends string>(
  event: React.KeyboardEvent<HTMLElement>,
  values: readonly T[],
  value: T,
  onChange: (value: T) => void,
) {
  const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
  const back = event.key === "ArrowLeft" || event.key === "ArrowUp";
  if (!forward && !back) return;
  event.preventDefault();
  const at = Math.max(values.indexOf(value), 0);
  const index = (at + (forward ? 1 : -1) + values.length) % values.length;
  onChange(values[index] as T);
  event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[index]?.focus();
}

const THEME_VALUES = OPTIONS.map((opt) => opt.value);

export function ThemePicker({ value, onChange }: ThemePickerProps) {
  return (
    <div
      className="theme-picker"
      role="radiogroup"
      aria-label="Theme"
      onKeyDown={(event) => onRadioKeyDown(event, THEME_VALUES, value, onChange)}
    >
      {OPTIONS.map((opt) => {
        const Icon = opt.icon;
        const active = value === opt.value;
        return (
          // biome-ignore lint/a11y/useSemanticElements: custom-styled radio inside the parent role="radiogroup"; <input type="radio"> can't carry the inline SVG glyph + active background the design needs
          <button
            key={opt.value}
            type="button"
            className={`theme-picker-btn${active ? " active" : ""}`}
            onClick={() => onChange(opt.value)}
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            aria-label={`${opt.label} theme`}
            title={opt.label}
          >
            <Icon />
          </button>
        );
      })}
    </div>
  );
}

const PALETTE_OPTIONS: Array<{ value: PalettePreference; label: string }> = [
  { value: "keelson", label: "Keelson" },
  { value: "shore", label: "Shore" },
];

interface PalettePickerProps {
  value: PalettePreference;
  onChange: (value: PalettePreference) => void;
}

const PALETTE_VALUES = PALETTE_OPTIONS.map((opt) => opt.value);

export function PalettePicker({ value, onChange }: PalettePickerProps) {
  return (
    <div
      className="theme-picker"
      role="radiogroup"
      aria-label="Palette"
      onKeyDown={(event) => onRadioKeyDown(event, PALETTE_VALUES, value, onChange)}
    >
      {PALETTE_OPTIONS.map((opt) => {
        const active = value === opt.value;
        // Each swatch shows its own palette, so it reads fixed values rather than the live tokens.
        const { accent, magenta } = DESIGN_PALETTES[opt.value].dark;
        return (
          // biome-ignore lint/a11y/useSemanticElements: same custom radio pattern as ThemePicker
          <button
            key={opt.value}
            type="button"
            className={`theme-picker-btn palette-picker-btn${active ? " active" : ""}`}
            onClick={() => onChange(opt.value)}
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            aria-label={`${opt.label} palette`}
            title={opt.label}
          >
            <span
              className="palette-swatch"
              aria-hidden="true"
              style={{ background: `linear-gradient(135deg, ${accent}, ${magenta})` }}
            />
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function SunIcon(): React.ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MonitorIcon(): React.ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

function MoonIcon(): React.ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}
