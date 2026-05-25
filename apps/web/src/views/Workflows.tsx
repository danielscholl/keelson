import type { WorkflowDetail, WorkflowSummary } from "@keelson/shared";
import { useCallback, useEffect, useRef, useState } from "react";

import { getWorkflowDetail, listWorkflows, startWorkflowRun } from "../api.ts";
import { SkeletonStack } from "../components/Skeleton.tsx";
import { useToast } from "../components/Toast.tsx";
import { RecentRuns } from "../components/Workflows/RecentRuns.tsx";
import { RunView } from "../components/Workflows/RunView.tsx";
import { WorkflowList } from "../components/Workflows/WorkflowList.tsx";

// `runId: null` is the pre-start state — RunView paints the DAG with all
// nodes pending and pins the StartComposer to the bottom; the API call
// only fires when the user submits the composer.
type Screen = { kind: "catalog" } | { kind: "run"; workflow: WorkflowDetail; runId: string | null };

// Module-scoped so it survives the view re-mounting on every tab switch.
// Without this, navigating back to Workflows fires the same loader-notice
// toasts every time, which is just noise after the user has seen them.
const seenNotices = new Set<string>();

export function Workflows() {
  const toast = useToast();

  const [workflows, setWorkflows] = useState<WorkflowSummary[] | null>(null);
  const [details, setDetails] = useState<Map<string, WorkflowDetail>>(new Map());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>({ kind: "catalog" });
  // Bump on every kick so RecentRuns re-fetches.
  const [runsRefresh, setRunsRefresh] = useState(0);
  // Ref is the synchronous race gate; state drives the StartComposer
  // disabled / "Starting…" rendering.
  const startingRef = useRef(false);
  const [starting, setStarting] = useState(false);

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
    async (workflowDetail: WorkflowDetail, args: string) => {
      // Ref, not setState — React 18 batches setState from event handlers
      // so a functional-updater guard reads stale on the same tick.
      if (startingRef.current) return;
      startingRef.current = true;
      setStarting(true);
      try {
        const { runId } = await startWorkflowRun(workflowDetail.name, {
          ARGUMENTS: args,
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
          onStart={(args) => handleStart(screen.workflow, args)}
          starting={starting}
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
      />
    </div>
  );
}
