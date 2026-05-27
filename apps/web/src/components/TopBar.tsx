import type { ThemePreference } from "../hooks/useSettings.ts";
import { ThemePicker } from "./ThemePicker.tsx";

export type ActiveTab = "chat" | "workflows" | "projects" | "memory";

export interface TopBarProps {
  activeTab: ActiveTab;
  onTabChange: (tab: ActiveTab) => void;
  themePreference: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  // Count of workflow runs currently paused awaiting human input. Drives
  // the magenta pip on the Workflows nav so the Chat tab notices without
  // subscribing to every run's WS.
  pausedRunCount?: number;
  // Count of memory rows in review_status='pending'. Drives the pip on the
  // Memory nav — same posture as pausedRunCount.
  pendingMemoryCount?: number;
  // Fires when the operator clicks the brand or a "new chat" affordance.
  // App resets the active conversation id and routes to the Chat tab.
  onNewChat?: () => void;
}

export function TopBar(props: TopBarProps) {
  const {
    activeTab,
    onTabChange,
    themePreference,
    onThemeChange,
    pausedRunCount,
    pendingMemoryCount,
    onNewChat,
  } = props;
  const pausedCount = pausedRunCount ?? 0;
  const memoryCount = pendingMemoryCount ?? 0;

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
          <button
            type="button"
            className={`nav-tab${activeTab === "projects" ? " is-active" : ""}`}
            aria-pressed={activeTab === "projects"}
            onClick={() => onTabChange("projects")}
          >
            Projects
          </button>
          <button
            type="button"
            className={`nav-tab${activeTab === "memory" ? " is-active" : ""}`}
            aria-pressed={activeTab === "memory"}
            onClick={() => onTabChange("memory")}
          >
            Memory
            {memoryCount > 0 && (
              <span
                className="nav-pip"
                role="img"
                aria-label={`${memoryCount} pending`}
                title={`${memoryCount} memory item(s) awaiting review`}
              >
                {memoryCount}
              </span>
            )}
          </button>
        </nav>
      </div>
      <div className="topbar-right">
        <ThemePicker value={themePreference} onChange={onThemeChange} />
      </div>
    </header>
  );
}
