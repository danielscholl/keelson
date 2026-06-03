import type { RibSurfaceDescriptor } from "@keelson/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CanvasProvider } from "./components/Canvas/CanvasHost.tsx";
import { ToastHost } from "./components/Toast.tsx";
import { type ActiveTab, type SurfaceTab, TopBar } from "./components/TopBar.tsx";
import { useConversation } from "./hooks/useConversation.ts";
import { usePausedRunCount } from "./hooks/usePausedRunCount.ts";
import { usePendingMemoryCount } from "./hooks/usePendingMemoryCount.ts";
import { useRibs } from "./hooks/useRibs.ts";
import { useSettings } from "./hooks/useSettings.ts";
import { Chat } from "./views/Chat.tsx";
import { Memory } from "./views/Memory.tsx";
import { Ribs } from "./views/Ribs.tsx";
import { Surface } from "./views/Surface.tsx";
import { Workflows } from "./views/Workflows.tsx";

export function App() {
  return (
    <ToastHost>
      <CanvasProvider>
        <AppInner />
      </CanvasProvider>
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

  const { ribs } = useRibs();
  const surfaceTabs = useMemo<SurfaceTab[]>(
    () =>
      ribs.flatMap((rib) =>
        rib.surfaces.map((s) => ({ id: `surface:${rib.id}:${s.id}` as const, title: s.title })),
      ),
    [ribs],
  );
  const activeSurface = useMemo<RibSurfaceDescriptor | null>(() => {
    if (!activeTab.startsWith("surface:")) return null;
    for (const rib of ribs) {
      for (const s of rib.surfaces) {
        if (`surface:${rib.id}:${s.id}` === activeTab) return s;
      }
    }
    return null;
  }, [activeTab, ribs]);

  // A surface tab can vanish (rib filtered out, list refetched). Once ribs have
  // loaded, fall back to Chat if the active surface id is no longer present.
  useEffect(() => {
    if (activeTab.startsWith("surface:") && !surfaceTabs.some((t) => t.id === activeTab)) {
      setActiveTab("chat");
    }
  }, [activeTab, surfaceTabs]);

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
        surfaceTabs={surfaceTabs}
        themePreference={themePreference}
        onThemeChange={setTheme}
        pausedRunCount={pausedRunCount}
        pendingMemoryCount={pendingMemoryCount}
        onNewChat={handleNewChat}
      />
      {activeSurface ? (
        // Key by tab so switching surfaces remounts the tree — region collapse
        // state must not leak from one surface's layout into another's.
        <Surface key={activeTab} descriptor={activeSurface} />
      ) : activeTab === "workflows" ? (
        <Workflows
          pendingRun={pendingWorkflowRun}
          onPendingRunConsumed={() => setPendingWorkflowRun(null)}
        />
      ) : activeTab === "memory" ? (
        <Memory />
      ) : activeTab === "ribs" ? (
        <Ribs />
      ) : (
        <Chat onOpenWorkflowRun={handleOpenWorkflowRun} />
      )}
    </div>
  );
}
