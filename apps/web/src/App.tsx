import { useCallback, useEffect, useState } from "react";
import { ToastHost } from "./components/Toast.tsx";
import { type ActiveTab, TopBar } from "./components/TopBar.tsx";
import { useConversation } from "./hooks/useConversation.ts";
import { usePausedRunCount } from "./hooks/usePausedRunCount.ts";
import { usePendingMemoryCount } from "./hooks/usePendingMemoryCount.ts";
import { useSettings } from "./hooks/useSettings.ts";
import { Chat } from "./views/Chat.tsx";
import { Memory } from "./views/Memory.tsx";
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
  // A run started from chat (`/workflow run`) — switches to the Workflows tab
  // and deep-links the run; Workflows consumes and clears it on mount.
  const [pendingWorkflowRun, setPendingWorkflowRun] = useState<{
    workflowName: string;
    runId: string;
  } | null>(null);
  const pausedRunCount = usePausedRunCount();
  const pendingMemoryCount = usePendingMemoryCount();

  const handleOpenWorkflowRun = useCallback((workflowName: string, runId: string) => {
    setPendingWorkflowRun({ workflowName, runId });
    setActiveTab("workflows");
  }, []);

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
        pendingMemoryCount={pendingMemoryCount}
        onNewChat={handleNewChat}
      />
      {activeTab === "workflows" ? (
        <Workflows
          pendingRun={pendingWorkflowRun}
          onPendingRunConsumed={() => setPendingWorkflowRun(null)}
        />
      ) : activeTab === "memory" ? (
        <Memory />
      ) : (
        <Chat onOpenWorkflowRun={handleOpenWorkflowRun} />
      )}
    </div>
  );
}
