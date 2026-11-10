import { type AgentSpec, pendingSubgraph } from "@konsora/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAgents } from "../api/agents.ts";
import { useApprovals } from "../api/approvals.ts";
import { type BoardOk, type LiveState, toDocument } from "../api/board.ts";
import { ApiError } from "../api/client.ts";
import { useEnqueue } from "../api/queue.ts";
import { useRuns, useStartRun } from "../api/runs.ts";
import { type MessageKey, t } from "../i18n/index.ts";
import { Segmented, StateBadge, useToast } from "../ui/index.ts";
import { ApprovalNotice } from "./Approvals.tsx";
import { launchItems, taskAgent } from "./agent-model.ts";
import { Board } from "./Board.tsx";
import { CostPage } from "./CostPage.tsx";
import { failingReviews } from "./checks-model.ts";
import { ExternalChanges } from "./External.tsx";
import { Graph } from "./Graph.tsx";
import { Orphans } from "./Orphans.tsx";
import { ProjectSettings } from "./ProjectSettings.tsx";
import { awaitingApproval, queueableSelection } from "./queue-model.ts";
import { RecommendedSettings } from "./RecommendedSettings.tsx";
import { ReviewerSettings } from "./ReviewerSettings.tsx";
import { navigate, type ProjectViewName, projectHref, projectViews } from "./route.ts";
import { launchEach, runErrorText, runnableSelection } from "./run-model.ts";
import { SelectionBar } from "./SelectionBar.tsx";
import { isSelectable, useSelection, visibleSelection } from "./selection.ts";
import { TaskPanel } from "./TaskPanel.tsx";
import { TemplateSettings } from "./TemplateSettings.tsx";

const LANES_KEY = "konsora.board.swimlanes";

function readLanesPref(): boolean {
  try {
    return window.localStorage.getItem(LANES_KEY) !== "off";
  } catch {
    return true;
  }
}

function writeLanesPref(on: boolean) {
  try {
    window.localStorage.setItem(LANES_KEY, on ? "on" : "off");
  } catch {
    // Not persisted; the toggle still works for this page.
  }
}

const LIVE_KEYS: Record<LiveState, MessageKey> = {
  live: "board.live",
  connecting: "board.connecting",
  offline: "board.offline",
};

const VIEW_KEYS: Record<ProjectViewName, MessageKey> = {
  board: "app.view.board",
  graph: "app.view.graph",
  cost: "app.view.cost",
  settings: "app.view.settings",
};

/**
 * A project's page around its two views: toolbar (view switch, live state), external changes, the
 * board or the graph, and the task panel both share. The view and the open task live in the URL.
 */
export function ProjectView({
  board,
  live,
  view,
  openId,
  readOnly = false,
}: {
  board: BoardOk;
  live: LiveState;
  view: ProjectViewName;
  openId: string | null;
  /** The file is invalid: this is the last valid version, shown without drag or actions. */
  readOnly?: boolean;
}) {
  const projectId = board.project.id;
  const doc = useMemo(() => toDocument(board), [board]);
  const [swimlanes, setSwimlanes] = useState(readLanesPref);
  const flagged = useMemo(() => new Set(board.external.map((f) => f.task)), [board.external]);
  const opened = openId ? board.tasks.find((task) => task.id === openId) : undefined;
  const toast = useToast();
  const runs = useRuns(projectId).data;
  const allApprovals = useApprovals().data;
  const approvals = useMemo(
    () => (allApprovals ?? []).filter((a) => a.project === projectId),
    [allApprovals, projectId],
  );
  // Cards in review whose latest run ended with checks in red stand out on the board, and so do
  // cards whose run waits for the human's approval.
  const marked = useMemo(() => {
    const failing = failingReviews(board.tasks, runs);
    const asking = awaitingApproval(runs, approvals);
    if (failing.size === 0 && asking.size === 0) return board;
    return {
      ...board,
      tasks: board.tasks.map((task) => ({
        ...task,
        ...(failing.has(task.id) ? { checks_failed: true } : {}),
        ...(asking.has(task.id) ? { awaiting_approval: true } : {}),
      })),
    };
  }, [board, runs, approvals]);
  const startRun = useStartRun(projectId);
  const selection = useSelection(projectId);
  const selectedIds = visibleSelection(selection.selected, board.tasks);
  const selectedKey = selectedIds.join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: the joined ids are the identity.
  const selected = useMemo(() => new Set(selectedIds), [selectedKey]);
  const dispatchSelection = selection.dispatch;
  const toggle = useCallback(
    (id: string) => dispatchSelection({ type: "toggle", id }),
    [dispatchSelection],
  );
  const selectWithDeps = useCallback(
    (id: string) => {
      const ids = pendingSubgraph(id, doc);
      if (ids.length === 0) return;
      dispatchSelection({ type: "add", ids });
      toast.show(t("selection.withDeps.done", { id, n: ids.length }), "info");
    },
    [doc, dispatchSelection, toast],
  );
  const go = useCallback(
    (next: { view?: ProjectViewName; task?: string | null }) =>
      navigate(
        projectHref(projectId, {
          view: next.view ?? view,
          task: next.task === undefined ? openId : next.task,
        }),
      ),
    [projectId, view, openId],
  );
  const open = useCallback((id: string) => go({ task: id }), [go]);
  const runnable = runnableSelection(selectedIds, board.tasks, { readOnly, runs });
  const queueable = queueableSelection(selectedIds, board.tasks, readOnly);
  const enqueue = useEnqueue(projectId);
  const catalog = useAgents().data;
  const [chosenAgent, setChosenAgent] = useState<AgentSpec | undefined>(undefined);
  // Each launched task uses its own agent (core's order), unless the human chose one for all.
  const launching = board.tasks.filter(
    (task) => runnable.includes(task.id) || queueable.includes(task.id),
  );
  const taskAgents = catalog
    ? launching.map((task) => ({
        id: task.id,
        choice: taskAgent(task, board.plan.project, catalog),
      }))
    : [];
  const items = (ids: readonly string[]) =>
    launchItems(ids, catalog ? taskAgents : undefined, chosenAgent);
  /** The tasks the daemon refused because max_parallel has no slot for them (DMN-11). */
  const [full, setFull] = useState<readonly string[]>([]);
  const fullSelected = full.filter((id) => selected.has(id));
  /**
   * Launches each selected ready task in its own run, one after another. The ones that do not fit
   * in max_parallel stay selected, so the human can queue them with the same agent.
   */
  const runSelected = async (ids: readonly string[]) => {
    const launch = items(ids).filter((item) => board.tasks.some((x) => x.id === item.task));
    const { started, unfit, failed, unauthorized } = await launchEach(launch, (item) =>
      startRun.mutateAsync(item),
    );
    if (unauthorized) return;
    for (const { task, code, message } of failed) {
      toast.show(runErrorText(code, task, message), "error");
    }
    setFull(unfit);
    if (started.length > 0) {
      toast.show(t("selection.run.started", { n: started.length }), "success");
      dispatchSelection({ type: "clear" });
      if (unfit.length > 0) dispatchSelection({ type: "add", ids: unfit });
    }
  };
  /** Adds the selected tasks to the queue with the chosen agent; it launches them when ready. */
  const queueSelected = (ids: readonly string[]) => {
    enqueue.mutate(items(ids), {
      onSuccess: (result) => {
        toast.show(
          result.already.length > 0
            ? `${t("selection.queue.done", { n: result.added.length })} ${t("selection.queue.already", { ids: result.already.join(", ") })}`
            : t("selection.queue.done", { n: result.added.length }),
          "success",
        );
        dispatchSelection({ type: "clear" });
      },
      onError: (error) => {
        if (error instanceof ApiError && error.unauthorized) return;
        toast.show(t("queue.error", { message: error.message }), "error");
      },
    });
  };
  useEffect(() => {
    if (!openId) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !(event.target instanceof HTMLTextAreaElement))
        go({ task: null });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openId, go]);

  return (
    <div className={selectedIds.length > 0 ? "b-board b-board--selecting" : "b-board"}>
      <div className="b-toolbar">
        <h1 className="b-toolbar__title">{board.project.name}</h1>
        <span className={`b-live b-live--${live}`} role="status">
          {t(LIVE_KEYS[live])}
        </span>
        {readOnly && <StateBadge kind="blocked" label={t("readonly.badge")} />}
        <Segmented
          label={t("app.views")}
          value={view}
          onChange={(value) => go({ view: value as ProjectViewName })}
          options={projectViews.map((value) => ({
            value,
            label: t(VIEW_KEYS[value]),
          }))}
        />
        {view === "board" && (
          <Segmented
            label={t("board.lanes")}
            value={swimlanes ? "groups" : "none"}
            onChange={(value) => {
              setSwimlanes(value === "groups");
              writeLanesPref(value === "groups");
            }}
            options={[
              { value: "groups", label: t("board.lanes.groups") },
              { value: "none", label: t("board.lanes.none") },
            ]}
          />
        )}
        <a className="s-nav__link b-toolbar__back" href="#/">
          {t("project.back")}
        </a>
      </div>
      <ApprovalNotice approvals={approvals} onOpen={open} />
      <Orphans projectId={projectId} />
      <ExternalChanges projectId={projectId} flags={board.external} readOnly={readOnly} />
      {view === "cost" ? (
        <CostPage plan={board.plan} tasks={board.tasks} runs={runs} />
      ) : view === "settings" ? (
        <div className="s-stack">
          <ProjectSettings projectId={projectId} project={board.plan.project} readOnly={readOnly} />
          <RecommendedSettings
            projectId={projectId}
            recommended={board.plan.project.recommended}
            defaults={board.plan.project.defaults}
            readOnly={readOnly}
          />
          <ReviewerSettings
            projectId={projectId}
            reviewer={board.plan.project.reviewer}
            defaults={board.plan.project.defaults}
            readOnly={readOnly}
          />
          <TemplateSettings
            projectId={projectId}
            templates={board.plan.project.templates}
            readOnly={readOnly}
          />
        </div>
      ) : (
        <div className="b-layout">
          <div
            className={view === "graph" ? "b-layout__main b-layout__main--graph" : "b-layout__main"}
          >
            {board.tasks.length === 0 ? (
              <p className="s-text s-muted">{t("board.empty")}</p>
            ) : view === "graph" ? (
              <Graph
                label={t("graph.label", { name: board.project.name })}
                tasks={board.tasks}
                external={flagged}
                openId={opened ? opened.id : null}
                onOpen={open}
                selected={selected}
                onToggle={toggle}
                onSelectWithDeps={selectWithDeps}
              />
            ) : (
              <Board
                board={marked}
                swimlanes={swimlanes}
                onOpen={open}
                selection={{ selected, onToggle: toggle }}
                readOnly={readOnly}
                runs={runs}
              />
            )}
          </div>
          {opened && (
            <TaskPanel
              key={opened.id}
              projectId={projectId}
              groups={board.plan.groups}
              task={opened}
              doc={doc}
              groupName={board.plan.groups.find((g) => g.id === opened.group)?.name ?? opened.group}
              external={board.external.filter((f) => f.task === opened.id)}
              readOnly={readOnly}
              onClose={() => go({ task: null })}
              onOpen={open}
              runs={runs}
              onSelectWithDeps={
                view === "graph" && isSelectable(opened)
                  ? () => selectWithDeps(opened.id)
                  : undefined
              }
            />
          )}
        </div>
      )}
      {selectedIds.length > 0 && (
        <SelectionBar
          ids={selectedIds}
          runnable={runnable}
          readOnly={readOnly}
          busy={startRun.isPending}
          agent={chosenAgent}
          agents={taskAgents}
          catalog={catalog}
          onAgent={setChosenAgent}
          onRun={(ids) => void runSelected(ids)}
          queueable={queueable}
          full={fullSelected}
          queueBusy={enqueue.isPending}
          onQueue={queueSelected}
          onClear={() => dispatchSelection({ type: "clear" })}
        />
      )}
    </div>
  );
}
