import type { RibSurfaceDescriptor } from "@keelson/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getWorkflowRun, listProjects, startWorkflowRun } from "./api.ts";
import { ApprovalsDock } from "./components/ApprovalsDock.tsx";
import { CanvasProvider } from "./components/Canvas/CanvasHost.tsx";
import { RibsProvider, useRibsContext } from "./components/RibsProvider.tsx";
import { ToastHost, useToast } from "./components/Toast.tsx";
import { type ActiveTab, type SurfaceTab, TopBar } from "./components/TopBar.tsx";
import { RunDrawer } from "./components/Workflows/RunDrawer.tsx";
import { useActiveProject } from "./hooks/useActiveProject.ts";
import { useConversation } from "./hooks/useConversation.ts";
import { usePausedRunCount } from "./hooks/usePausedRunCount.ts";
import { usePendingMemoryCount } from "./hooks/usePendingMemoryCount.ts";
import { useSchemaVersionGate } from "./hooks/useSchemaVersionGate.ts";
import { useSettings } from "./hooks/useSettings.ts";
import type { ChatSeed } from "./lib/exploreSeed.ts";
import { launchWorkflowRun } from "./lib/launchWorkflowRun.ts";
import { watchStayRun } from "./lib/watchStayRun.ts";
import { Chat } from "./views/Chat.tsx";
import { Memory } from "./views/Memory.tsx";
import { Surface } from "./views/Surface.tsx";
import { Usage } from "./views/Usage.tsx";
import { Workflows } from "./views/Workflows.tsx";

export function App() {
  return (
    <ToastHost>
      <RibsProvider>
        <CanvasProvider>
          <AppInner />
        </CanvasProvider>
      </RibsProvider>
    </ToastHost>
  );
}

function AppInner() {
  useSchemaVersionGate();
  const toast = useToast();
  const { settings, setTheme, isRegionActionHidden, toggleHiddenRegionAction } = useSettings();
  const [activeTab, setActiveTab] = useState<ActiveTab>("chat");
  // A run started from chat (`/workflow run`) — switches to the Workflows tab
  // and deep-links the run; Workflows consumes and clears it on mount.
  const [pendingWorkflowRun, setPendingWorkflowRun] = useState<{
    workflowName: string;
    runId: string;
  } | null>(null);
  // A panel "explore in chat" handoff — held here so it survives the tab swap
  // from a surface to Chat (the two are never mounted together). Chat consumes
  // it on mount and clears it via onSeedConsumed.
  const [pendingSeed, setPendingSeed] = useState<ChatSeed | null>(null);
  // Bumped on every seed so <Chat> remounts to consume it cleanly. The ✦ path
  // remounts naturally (surface→chat tab swap); a `/mind` fired from inside Chat
  // would otherwise race the command flow's input reset, so force the remount.
  const [seedNonce, setSeedNonce] = useState(0);
  // A `stay` launch watched in place: the run drawer slides over the surface
  // that started it instead of stealing the tab.
  const [stayRun, setStayRun] = useState<{ workflowName: string; runId: string } | null>(null);
  const pausedRunCount = usePausedRunCount();
  const pendingMemoryCount = usePendingMemoryCount();

  const { ribs } = useRibsContext();
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

  // A board action's run-workflow directive launches through the same primitive
  // /workflow run uses, then hands the run to the existing Workflows-tab handoff.
  // The resolution + launch body lives in launchWorkflowRun (unit-tested); this
  // is the thin wrapper that supplies App's real deps.
  const { activeProjectId } = useActiveProject();
  const handleLaunchWorkflowFromAction = useCallback(
    (workflow: string, args: Record<string, string>, stay?: boolean) =>
      launchWorkflowRun(
        {
          activeProjectId,
          listProjects,
          startWorkflowRun,
          // `stay` launches the run but keeps the operator on the current surface,
          // watching it in a slide-over drawer instead of focusing Workflows.
          // watchStayRun still runs: the drawer is dismissable at any moment, so
          // the toast is what guarantees the outcome reaches the operator.
          onOpened: stay
            ? (name, runId) => {
                setStayRun({ workflowName: name, runId });
                void watchStayRun(name, runId, { getRun: getWorkflowRun, toast });
              }
            : handleOpenWorkflowRun,
          toast,
        },
        workflow,
        args,
      ),
    [activeProjectId, toast, handleOpenWorkflowRun],
  );

  const handleOpenSurface = useCallback(
    (surfaceId: string, regionKey?: string) => {
      if (!surfaceTabs.some((t) => t.id === surfaceId)) {
        toast.push({ kind: "error", message: "Surface not available" });
        return;
      }
      setActiveTab(surfaceId as ActiveTab);
      if (regionKey) {
        requestAnimationFrame(() => {
          document
            .querySelector(`[data-region-key="${CSS.escape(regionKey)}"]`)
            ?.scrollIntoView({ block: "start" });
        });
      }
    },
    [surfaceTabs, toast],
  );

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
  // here so the topbar's New Chat button and the panel explore handoff can reset
  // it. Clearing it is what lets Chat's seed consumer mint a fresh conversation.
  const { setConversationId } = useConversation();
  const goToFreshChat = useCallback(() => {
    setConversationId(null);
    setActiveTab("chat");
  }, [setConversationId]);

  // Panel → chat: stash the seed, then open a fresh chat (Chat's seed consumer
  // requires no hydrated conversation, which goToFreshChat guarantees).
  const handleExplore = useCallback(
    (seed: ChatSeed) => {
      setPendingSeed(seed);
      setSeedNonce((n) => n + 1);
      goToFreshChat();
    },
    [goToFreshChat],
  );

  return (
    <div className="wrap">
      <TopBar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        surfaceTabs={surfaceTabs}
        themePreference={themePreference}
        onThemeChange={setTheme}
        isRegionActionHidden={isRegionActionHidden}
        onToggleRegionAction={toggleHiddenRegionAction}
        pausedRunCount={pausedRunCount}
        pendingMemoryCount={pendingMemoryCount}
        onNewChat={goToFreshChat}
      />
      {activeSurface ? (
        // Key by tab so switching surfaces remounts the tree — region collapse
        // state must not leak from one surface's layout into another's.
        <Surface
          key={activeTab}
          descriptor={activeSurface}
          onExplore={handleExplore}
          onLaunchWorkflow={handleLaunchWorkflowFromAction}
          onOpenSurface={handleOpenSurface}
        />
      ) : activeTab === "workflows" ? (
        <Workflows
          pendingRun={pendingWorkflowRun}
          onPendingRunConsumed={() => setPendingWorkflowRun(null)}
        />
      ) : activeTab === "memory" ? (
        <Memory />
      ) : activeTab === "usage" ? (
        <Usage />
      ) : (
        <Chat
          key={seedNonce}
          onOpenWorkflowRun={handleOpenWorkflowRun}
          pendingSeed={pendingSeed}
          onSeedConsumed={() => setPendingSeed(null)}
          onOpenSeededChat={handleExplore}
        />
      )}
      {stayRun && (
        <RunDrawer
          workflowName={stayRun.workflowName}
          runId={stayRun.runId}
          projectId={activeProjectId}
          onClose={() => setStayRun(null)}
          onOpenInWorkflows={(name, runId) => {
            setStayRun(null);
            handleOpenWorkflowRun(name, runId);
          }}
        />
      )}
      {/* App-level: a policy ASK can pause a turn on any surface. */}
      <ApprovalsDock />
    </div>
  );
}
