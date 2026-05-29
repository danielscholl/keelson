import type { WorkflowDetail, WorkflowSummary } from "@keelson/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getWorkflowDetail, listWorkflows, startWorkflowRun } from "../api.ts";
import { ProjectChip } from "../components/Chat/ProjectChip.tsx";
import { ProjectPickerPopover } from "../components/Chat/ProjectPickerPopover.tsx";
import { SkeletonStack } from "../components/Skeleton.tsx";
import { useToast } from "../components/Toast.tsx";
import { RecentRuns } from "../components/Workflows/RecentRuns.tsx";
import { RunView } from "../components/Workflows/RunView.tsx";
import type { StartRequest } from "../components/Workflows/StartComposer.tsx";
import { WorkflowList } from "../components/Workflows/WorkflowList.tsx";
import { useActiveProject } from "../hooks/useActiveProject.ts";
import { useSettings, type WorkflowsViewMode } from "../hooks/useSettings.ts";

const PROJECT_PICKER_POPOVER_ID = "workflows-project-picker-popover";
const WORKFLOWS_VIEW_MODE_OPTIONS: Array<{ value: WorkflowsViewMode; label: string }> = [
  { value: "both", label: "Both" },
  { value: "workflows", label: "Workflows" },
  { value: "runs", label: "Runs" },
];

// `runId: null` is the pre-start state — RunView paints the DAG with all
// nodes pending and pins the StartComposer to the bottom; the API call
// only fires when the user submits the composer.
type Screen = { kind: "catalog" } | { kind: "run"; workflow: WorkflowDetail; runId: string | null };

// Persisted to localStorage so a discovery notice the user has already seen
// once stays dismissed across page reloads and HMR resets. Module-scoped
// alone is enough for tab switches but not for the dev-mode hot-reload
// churn that recreates the module on every save.
const SEEN_NOTICES_STORAGE_KEY = "keelson.workflows.seenNotices.v1";
const seenNotices = loadSeenNotices();
function loadSeenNotices(): Set<string> {
  try {
    const raw = localStorage.getItem(SEEN_NOTICES_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((s): s is string => typeof s === "string"));
  } catch {
    return new Set();
  }
}
function persistSeenNotices(set: Set<string>): void {
  try {
    localStorage.setItem(SEEN_NOTICES_STORAGE_KEY, JSON.stringify([...set]));
  } catch {
    // Quota exceeded / storage disabled — best-effort persistence.
  }
}

export interface WorkflowsProps {
  // A run started elsewhere (e.g. a chat `/workflow run`) to open on mount.
  pendingRun?: { workflowName: string; runId: string } | null;
  onPendingRunConsumed?: () => void;
}

export function Workflows({ pendingRun, onPendingRunConsumed }: WorkflowsProps = {}) {
  const toast = useToast();
  const { settings, setWorkflowsViewMode } = useSettings();
  const workflowsViewMode = settings.workflowsViewMode ?? "both";

  const [workflows, setWorkflows] = useState<WorkflowSummary[] | null>(null);
  const [details, setDetails] = useState<Map<string, WorkflowDetail>>(new Map());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>({ kind: "catalog" });
  const {
    projects,
    activeProjectId,
    activeProject,
    setActiveProject,
    refresh: refreshProjects,
  } = useActiveProject();
  const projectsById = useMemo(() => new Map(projects.map((p) => [p.id, p] as const)), [projects]);
  // Bump on every kick so RecentRuns re-fetches.
  const [runsRefresh, setRunsRefresh] = useState(0);
  // Ref is the synchronous race gate; state drives the StartComposer
  // disabled / "Starting…" rendering.
  const startingRef = useRef(false);
  const [starting, setStarting] = useState(false);
  const showWorkflowCatalog = workflowsViewMode !== "runs";
  const showRecentRuns = workflowsViewMode !== "workflows";

  const handleSelectProject = useCallback(
    (projectId: string) => {
      setActiveProject(projectId);
    },
    [setActiveProject],
  );

  useEffect(() => {
    let cancelled = false;
    listWorkflows()
      .then(async ({ workflows: list, discoveryNotices }) => {
        if (cancelled) return;
        setWorkflows(list);
        for (const notice of discoveryNotices) {
          const where = notice.nodeId
            ? `${notice.filename} (node ${notice.nodeId})`
            : notice.filename;
          const key = `${notice.level}|${notice.filename}|${notice.nodeId ?? ""}|${notice.message}`;
          if (seenNotices.has(key)) continue;
          seenNotices.add(key);
          toast.push({
            kind: notice.level === "error" ? "error" : "info",
            message: `${where}: ${notice.message}`,
          });
        }
        persistSeenNotices(seenNotices);
        // Preload details in parallel — the catalog cards show node-type
        // chips, and the run-start flow needs detail anyway. ~3 fetches
        // for the starter set is cheap.
        const detailEntries = await Promise.all(
          list.map((w) =>
            getWorkflowDetail(w.name).then(
              (d) => [w.name, d] as const,
              (err) => {
                console.warn(`[workflows] detail(${w.name}) failed:`, err);
                return null;
              },
            ),
          ),
        );
        if (cancelled) return;
        const map = new Map<string, WorkflowDetail>();
        for (const entry of detailEntries) {
          if (entry) map.set(entry[0], entry[1]);
        }
        setDetails(map);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [toast.push]);

  const handleRunRequest = useCallback(
    async (workflow: WorkflowSummary) => {
      let detail = details.get(workflow.name);
      if (!detail) {
        try {
          detail = await getWorkflowDetail(workflow.name);
          setDetails((prev) => {
            const next = new Map(prev);
            next.set(workflow.name, detail!);
            return next;
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          toast.push({ kind: "error", message: `Couldn't load ${workflow.name}: ${msg}` });
          return;
        }
      }
      setScreen({ kind: "run", workflow: detail, runId: null });
    },
    [details, toast],
  );

  const handleStart = useCallback(
    async (workflowDetail: WorkflowDetail, req: StartRequest) => {
      // Ref, not setState — React 18 batches setState from event handlers
      // so a functional-updater guard reads stale on the same tick.
      if (startingRef.current) return;
      startingRef.current = true;
      setStarting(true);
      try {
        const { runId } = await startWorkflowRun(workflowDetail.name, {
          inputs: { ARGUMENTS: req.args },
          projectId: req.projectId,
        });
        setScreen({ kind: "run", workflow: workflowDetail, runId });
        setRunsRefresh((n) => n + 1);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        toast.push({ kind: "error", message: `Couldn't start ${workflowDetail.name}: ${msg}` });
      } finally {
        startingRef.current = false;
        setStarting(false);
      }
    },
    [toast],
  );

  const handleOpenRun = useCallback(
    async (runId: string, workflowName: string) => {
      let detail = details.get(workflowName);
      if (!detail) {
        try {
          detail = await getWorkflowDetail(workflowName);
          setDetails((prev) => {
            const next = new Map(prev);
            next.set(workflowName, detail!);
            return next;
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          toast.push({ kind: "error", message: `Couldn't open run: ${msg}` });
          return;
        }
      }
      setScreen({ kind: "run", workflow: detail, runId });
    },
    [details, toast],
  );

  const handleBack = useCallback(() => {
    setScreen({ kind: "catalog" });
    setRunsRefresh((n) => n + 1);
  }, []);

  // Open a run handed in from another surface once the catalog has loaded so
  // handleOpenRun can resolve workflow detail. Consume it so a tab revisit
  // doesn't reopen a stale run.
  useEffect(() => {
    if (!pendingRun || workflows === null) return;
    void handleOpenRun(pendingRun.runId, pendingRun.workflowName);
    onPendingRunConsumed?.();
  }, [pendingRun, workflows, handleOpenRun, onPendingRunConsumed]);

  if (loadError) {
    return (
      <div className="page">
        <div className="empty-state">
          <div className="empty-state-icon">⚠</div>
          <div className="empty-state-title">Couldn't load workflows</div>
          <div className="empty-state-body">{loadError}</div>
        </div>
      </div>
    );
  }

  if (workflows === null) {
    return (
      <div className="page">
        <SkeletonStack rows={3} height="140px" />
      </div>
    );
  }

  if (screen.kind === "run") {
    return (
      <div className="page">
        <RunView
          workflow={screen.workflow}
          runId={screen.runId}
          onBack={handleBack}
          onStart={(req) => handleStart(screen.workflow, req)}
          starting={starting}
          projects={projects}
          selectedProjectId={activeProjectId}
          onSelectProject={handleSelectProject}
          onProjectUpdated={() => void refreshProjects()}
          onProjectDeleted={(deletedId) => {
            void refreshProjects();
            if (activeProjectId === deletedId) setActiveProject(null);
          }}
        />
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header workflows-page-header">
        <h1 className="page-title">Workflows</h1>
        <span className="page-sub">
          {workflows.length} workflow{workflows.length === 1 ? "" : "s"} discovered
        </span>
        <div className="workflows-header-actions">
          <ProjectChip
            projectName={activeProject?.name ?? "default"}
            popoverId={PROJECT_PICKER_POPOVER_ID}
          />
          <div className="workflows-view-toggle" role="radiogroup" aria-label="Workflows view">
            {WORKFLOWS_VIEW_MODE_OPTIONS.map((opt) => {
              const active = workflowsViewMode === opt.value;
              return (
                // biome-ignore lint/a11y/useSemanticElements: custom-styled radio group follows the existing ThemePicker pattern
                <button
                  key={opt.value}
                  type="button"
                  className={`workflows-view-toggle-btn${active ? " active" : ""}`}
                  onClick={() => setWorkflowsViewMode(opt.value)}
                  role="radio"
                  aria-checked={active}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <ProjectPickerPopover
        popoverId={PROJECT_PICKER_POPOVER_ID}
        projects={projects}
        activeProjectId={activeProjectId}
        onSelect={setActiveProject}
        onProjectUpdated={() => {
          void refreshProjects();
        }}
        onProjectDeleted={(deletedId) => {
          void refreshProjects();
          if (activeProjectId === deletedId) setActiveProject(null);
        }}
      />

      {showWorkflowCatalog && (
        <WorkflowList
          workflows={workflows}
          details={details}
          onRun={(w) => void handleRunRequest(w)}
        />
      )}

      {showRecentRuns && (
        <>
          <div
            className={`section-divider workflows-runs-divider${
              workflowsViewMode === "runs" ? " is-focused" : ""
            }`}
          >
            <h2>Recent runs</h2>
            <span className="section-sub">latest first</span>
          </div>
          <RecentRuns
            workflows={workflows}
            onOpenRun={handleOpenRun}
            refreshKey={runsRefresh}
            onRunDeleted={() => setRunsRefresh((n) => n + 1)}
            projectsById={projectsById}
          />
        </>
      )}
    </div>
  );
}
