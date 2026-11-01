import { useCallback, useEffect, useMemo, useState } from "react";
import { type BoardOk, type LiveState, toDocument } from "../api/board.ts";
import { type MessageKey, t } from "../i18n/index.ts";
import { Segmented, StateBadge } from "../ui/index.ts";
import { Board } from "./Board.tsx";
import { ExternalChanges } from "./External.tsx";
import { Graph } from "./Graph.tsx";
import { navigate, type ProjectViewName, projectHref } from "./route.ts";
import { TaskPanel } from "./TaskPanel.tsx";

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
    <div className="b-board">
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
          options={(["board", "graph"] as const).map((value) => ({
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
      <ExternalChanges projectId={projectId} flags={board.external} readOnly={readOnly} />
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
            />
          ) : (
            <Board board={board} swimlanes={swimlanes} onOpen={open} readOnly={readOnly} />
          )}
        </div>
        {opened && (
          <TaskPanel
            projectId={projectId}
            task={opened}
            doc={doc}
            groupName={board.plan.groups.find((g) => g.id === opened.group)?.name ?? opened.group}
            external={board.external.filter((f) => f.task === opened.id)}
            readOnly={readOnly}
            onClose={() => go({ task: null })}
            onOpen={open}
          />
        )}
      </div>
    </div>
  );
}
