import type React from "react";
import { useEffect, useRef, useState } from "react";
import type { ThemePreference } from "../hooks/useSettings.ts";
import { ThemePicker } from "./ThemePicker.tsx";

export type BuiltinTab = "chat" | "workflows" | "memory" | "usage";
// Dynamic rib surfaces ride alongside the built-in tabs as opaque ids
// (`surface:<ribId>:<surfaceId>`); the template-literal union keeps every
// `activeTab === "workflows"` comparison compiling unchanged.
export type ActiveTab = BuiltinTab | `surface:${string}`;

// One nav tab per declared rib surface, derived from GET /api/ribs in App.
export interface SurfaceTab {
  id: `surface:${string}`;
  title: string;
}

export interface TopBarProps {
  activeTab: ActiveTab;
  onTabChange: (tab: ActiveTab) => void;
  surfaceTabs?: readonly SurfaceTab[];
  themePreference: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  // Count of workflow runs currently paused awaiting human input. Drives
  // the magenta pip on the Workflows nav so the Chat tab notices without
  // subscribing to every run's WS.
  pausedRunCount?: number;
  // Count of memory rows in review_status='pending'. Drives the pip on the
  // Memory row and the attention dot on the instruments trigger — same
  // posture as pausedRunCount.
  pendingMemoryCount?: number;
  // Fires when the operator clicks the brand or a "new chat" affordance.
  // App resets the active conversation id and routes to the Chat tab.
  onNewChat?: () => void;
}

// The tab row holds workspaces — the hull's own surfaces (Chat, Workflows)
// then, past a hairline, whatever rib surfaces are installed. The harness
// instruments (Memory, Usage) and the theme control live in the gear menu:
// consulted, not inhabited.
export function TopBar(props: TopBarProps) {
  const {
    activeTab,
    onTabChange,
    surfaceTabs,
    themePreference,
    onThemeChange,
    pausedRunCount,
    pendingMemoryCount,
    onNewChat,
  } = props;
  const pausedCount = pausedRunCount ?? 0;

  return (
    <header className="topbar">
      <div className="topbar-left">
        <button
          type="button"
          className="brand-button"
          onClick={onNewChat}
          aria-label="New chat"
          title="New chat"
        >
          <span className="brand">Keelson</span>
        </button>
        <nav className="topbar-nav" aria-label="Primary">
          <button
            type="button"
            className={`nav-tab${activeTab === "chat" ? " is-active" : ""}`}
            aria-pressed={activeTab === "chat"}
            onClick={() => onTabChange("chat")}
          >
            Chat
          </button>
          <button
            type="button"
            className={`nav-tab${activeTab === "workflows" ? " is-active" : ""}`}
            aria-pressed={activeTab === "workflows"}
            onClick={() => onTabChange("workflows")}
          >
            Workflows
            {pausedCount > 0 && (
              <span
                className="nav-pip"
                role="img"
                aria-label={`${pausedCount} paused`}
                title={`${pausedCount} run(s) awaiting input`}
              >
                {pausedCount}
              </span>
            )}
          </button>
          {surfaceTabs !== undefined && surfaceTabs.length > 0 && (
            <span className="nav-divider" aria-hidden="true" />
          )}
          {surfaceTabs?.map((tab) => (
            <button
              type="button"
              key={tab.id}
              className={`nav-tab${activeTab === tab.id ? " is-active" : ""}`}
              aria-pressed={activeTab === tab.id}
              onClick={() => onTabChange(tab.id)}
            >
              {tab.title}
            </button>
          ))}
        </nav>
      </div>
      <div className="topbar-right">
        <InstrumentsPopover
          activeTab={activeTab}
          onTabChange={onTabChange}
          pendingMemoryCount={pendingMemoryCount ?? 0}
          themePreference={themePreference}
          onThemeChange={onThemeChange}
        />
      </div>
    </header>
  );
}

const INSTRUMENTS: ReadonlyArray<{ id: "memory" | "usage"; label: string }> = [
  { id: "memory", label: "Memory" },
  { id: "usage", label: "Usage" },
];

function InstrumentsPopover({
  activeTab,
  onTabChange,
  pendingMemoryCount,
  themePreference,
  onThemeChange,
}: {
  activeTab: ActiveTab;
  onTabChange: (tab: ActiveTab) => void;
  pendingMemoryCount: number;
  themePreference: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  // An instrument surface stays a full route; while one is active the trigger
  // wears its name as an active chip so the bar never reads "nothing selected".
  const activeInstrument = INSTRUMENTS.find((i) => i.id === activeTab);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | TouchEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("touchstart", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("touchstart", close);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const triggerLabel = `Harness controls${activeInstrument ? `, ${activeInstrument.label} active` : ""}${
    pendingMemoryCount > 0
      ? `, ${pendingMemoryCount} pending memory ${pendingMemoryCount === 1 ? "item" : "items"}`
      : ""
  }`;

  return (
    <div className="instruments">
      <button
        type="button"
        ref={triggerRef}
        className={`instruments-trigger${activeInstrument ? " is-active" : ""}`}
        aria-expanded={open}
        aria-label={triggerLabel}
        title={
          pendingMemoryCount > 0
            ? `${pendingMemoryCount} memory item(s) awaiting review`
            : "Harness"
        }
        onClick={() => setOpen((o) => !o)}
      >
        <GearIcon />
        {activeInstrument && <span className="instruments-current">{activeInstrument.label}</span>}
        {pendingMemoryCount > 0 && (
          <span
            className="instruments-dot"
            role="img"
            aria-label={`${pendingMemoryCount} pending`}
          />
        )}
      </button>
      {open && (
        <section className="instruments-menu" ref={panelRef} aria-label="Harness">
          <div className="instruments-heading">Harness</div>
          {INSTRUMENTS.map((item) => (
            <button
              type="button"
              key={item.id}
              className={`instruments-item${activeTab === item.id ? " is-active" : ""}`}
              onClick={() => {
                onTabChange(item.id);
                setOpen(false);
              }}
            >
              {item.label}
              {item.id === "memory" && pendingMemoryCount > 0 && (
                <span
                  className="nav-pip"
                  role="img"
                  aria-label={`${pendingMemoryCount} pending`}
                  title={`${pendingMemoryCount} memory item(s) awaiting review`}
                >
                  {pendingMemoryCount}
                </span>
              )}
            </button>
          ))}
          <div className="instruments-sep" />
          <div className="instruments-heading">Appearance</div>
          <div className="instruments-theme">
            <span className="instruments-theme-label">Theme</span>
            <ThemePicker value={themePreference} onChange={onThemeChange} />
          </div>
        </section>
      )}
    </div>
  );
}

function GearIcon(): React.ReactElement {
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
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
