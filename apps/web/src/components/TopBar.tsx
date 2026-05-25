import type { ThemePreference } from "../hooks/useSettings.ts";
import { ThemePicker } from "./ThemePicker.tsx";

export type ActiveTab = "chat" | "workflows";

export interface TopBarProps {
  activeTab: ActiveTab;
  onTabChange: (tab: ActiveTab) => void;
  themePreference: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  // Count of workflow runs currently paused awaiting human input. Drives
  // the magenta pip on the Workflows nav so the Chat tab notices without
  // subscribing to every run's WS.
  pausedRunCount?: number;
  // Fires when the operator clicks the brand or a "new chat" affordance.
  // App resets the active conversation id and routes to the Chat tab.
  onNewChat?: () => void;
}

export function TopBar(props: TopBarProps) {
  const { activeTab, onTabChange, themePreference, onThemeChange, pausedRunCount, onNewChat } =
    props;
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
                aria-label={`${pausedCount} paused`}
                title={`${pausedCount} run(s) awaiting input`}
              >
                {pausedCount}
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
