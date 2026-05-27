import type { Project, WorkflowDetail, WorkflowSummary } from "@keelson/shared";
import { useCallback, useEffect, useRef, useState } from "react";

import { getWorkflowDetail, listProjects, listWorkflows, startWorkflowRun } from "../api.ts";
import { SkeletonStack } from "../components/Skeleton.tsx";
import { useToast } from "../components/Toast.tsx";
import { RecentRuns } from "../components/Workflows/RecentRuns.tsx";
import { RunView } from "../components/Workflows/RunView.tsx";
import type { StartRequest } from "../components/Workflows/StartComposer.tsx";
import { WorkflowList } from "../components/Workflows/WorkflowList.tsx";

// Persist the last-used project so reloads land on the same context. Same
// localStorage discipline as `seenNotices` below.
const SELECTED_PROJECT_STORAGE_KEY = "keelson.workflows.selectedProjectId.v1";

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

export function Workflows() {
  const toast = useToast();

  const [workflows, setWorkflows] = useState<WorkflowSummary[] | null>(null);
  const [details, setDetails] = useState<Map<string, WorkflowDetail>>(new Map());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>({ kind: "catalog" });
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(SELECTED_PROJECT_STORAGE_KEY);
    } catch {
      return null;
    }
  });
  // Bump on every kick so RecentRuns re-fetches.
  const [runsRefresh, setRunsRefresh] = useState(0);
  // Ref is the synchronous race gate; state drives the StartComposer
  // disabled / "Starting…" rendering.
  const startingRef = useRef(false);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listProjects()
      .then((next) => {
        if (cancelled) return;
        setProjects(next);
        setSelectedProjectId((prev) => {
          if (prev && next.some((p) => p.id === prev)) return prev;
          const resolved = next.length === 1 ? next[0]!.id : null;
          try {
            if (resolved) localStorage.setItem(SELECTED_PROJECT_STORAGE_KEY, resolved);
            else localStorage.removeItem(SELECTED_PROJECT_STORAGE_KEY);
          } catch {
            // Quota / disabled — best-effort persistence.
          }
          return resolved;
        });
      })
      .catch((err) => {
        // Non-fatal: projects load failure shouldn't block the workflows view.
        console.warn("[workflows] listProjects failed:", err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSelectProject = useCallback((projectId: string) => {
    setSelectedProjectId(projectId);
    try {
      if (projectId) localStorage.setItem(SELECTED_PROJECT_STORAGE_KEY, projectId);
      else localStorage.removeItem(SELECTED_PROJECT_STORAGE_KEY);
    } catch {
      // Quota / disabled — best-effort persistence.
    }
  }, []);

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
          ...(req.isolation ? { isolation: req.isolation } : {}),
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
          selectedProjectId={selectedProjectId}
          onSelectProject={handleSelectProject}
        />
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Workflows</h1>
        <span className="page-sub">
          {workflows.length} workflow{workflows.length === 1 ? "" : "s"} discovered
        </span>
      </div>

      <WorkflowList
        workflows={workflows}
        details={details}
        onRun={(w) => void handleRunRequest(w)}
      />

      <div className="section-divider">
        <h2>Recent runs</h2>
        <span className="section-sub">latest first</span>
      </div>
      <RecentRuns
        workflows={workflows}
        onOpenRun={handleOpenRun}
        refreshKey={runsRefresh}
        onRunDeleted={() => setRunsRefresh((n) => n + 1)}
        projectsById={new Map(projects.map((p) => [p.id, p]))}
      />
    </div>
  );
}
