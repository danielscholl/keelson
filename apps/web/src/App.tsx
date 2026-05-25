import { useCallback, useEffect, useState } from "react";
import { ToastHost } from "./components/Toast.tsx";
import { type ActiveTab, TopBar } from "./components/TopBar.tsx";
import { useConversation } from "./hooks/useConversation.ts";
import { usePausedRunCount } from "./hooks/usePausedRunCount.ts";
import { useSettings } from "./hooks/useSettings.ts";
import { Chat } from "./views/Chat.tsx";
import { Workflows } from "./views/Workflows.tsx";

export function App() {
  return (
    <ToastHost>
      <AppInner />
    </ToastHost>
  );
}

function AppInner() {
  const { settings, setTheme } = useSettings();
  const [activeTab, setActiveTab] = useState<ActiveTab>("chat");
  const pausedRunCount = usePausedRunCount();

  const themePreference = settings.theme ?? "system";
  useEffect(() => {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved =
        themePreference === "system" ? (mql.matches ? "dark" : "light") : themePreference;
      document.documentElement.setAttribute("data-theme", resolved);
    };
    apply();
    if (themePreference !== "system") return;
    mql.addEventListener("change", apply);
    return () => mql.removeEventListener("change", apply);
  }, [themePreference]);

  // useConversation owns the active conversation id; expose setConversationId
  // here so the topbar's New Chat button can reset it.
  const { setConversationId } = useConversation();
  const handleNewChat = useCallback(() => {
    setConversationId(null);
    setActiveTab("chat");
  }, [setConversationId]);

  return (
    <div className="wrap">
      <TopBar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        themePreference={themePreference}
        onThemeChange={setTheme}
        pausedRunCount={pausedRunCount}
        onNewChat={handleNewChat}
      />
      {activeTab === "workflows" ? <Workflows /> : <Chat />}
    </div>
  );
}
