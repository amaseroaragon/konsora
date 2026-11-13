import {
  filterFacets,
  isFilterActive,
  matchingIds,
  mergeUndo,
  pendingSubgraph,
  type TaskFilter,
  type UndoChange,
} from "@konsora/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  archivedTask,
  type BoardOk,
  type BoardTask,
  type LiveState,
  toDocument,
  useEditTask,
  useTaskAction,
} from "../api/board.ts";
import { readChatModel, useSendChat } from "../api/chat.ts";
import { ApiError } from "../api/client.ts";
import { type MessageKey, t } from "../i18n/index.ts";
import { askConfirm, Button, Segmented, StateBadge, useToast } from "../ui/index.ts";
import { Board } from "./Board.tsx";
import {
  confirmDelete,
  DONE_WINDOWS,
  type DoneWindow,
  readDoneWindow,
  writeDoneWindow,
} from "./board-model.ts";
import { applyBulk, type BulkChange } from "./bulk-model.ts";
import { ChatPanel } from "./ChatPanel.tsx";
import { ExternalChanges } from "./External.tsx";
import { dependencyProblem, editErrorText } from "./edit-model.ts";
import { FilterBar } from "./FilterBar.tsx";
import { Graph } from "./Graph.tsx";
import type { Link } from "./graph-model.ts";
import { HistoryView } from "./HistoryView.tsx";
import { refineMessage } from "./refine.ts";
import {
  navigate,
  type ProjectViewName,
  projectHref,
  projectViews,
  replaceRoute,
} from "./route.ts";
import { SelectionBar } from "./SelectionBar.tsx";
import { isSelectable, useSelection, visibleSelection } from "./selection.ts";
import { TaskCreator } from "./TaskCreator.tsx";
import { TaskPanel } from "./TaskPanel.tsx";
import { TemplateSettings } from "./TemplateSettings.tsx";
import { useUndoOffer } from "./undo.ts";

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

/** The graph's view preferences (UI-24): hide done work, frame tasks by group. */
const GRAPH_DONE_KEY = "konsora.graph.hideDone";
const GRAPH_GROUPS_KEY = "konsora.graph.grouped";

function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "on";
  } catch {
    return false;
  }
}

function writeFlag(key: string, on: boolean) {
  try {
    window.localStorage.setItem(key, on ? "on" : "off");
  } catch {
    // Not persisted; the toggle still works for this page.
  }
}

const CHAT_KEY = "konsora.chat.open";

function readChatPref(): boolean {
  try {
    return window.localStorage.getItem(CHAT_KEY) === "on";
  } catch {
    return false;
  }
}

function writeChatPref(on: boolean) {
  try {
    window.localStorage.setItem(CHAT_KEY, on ? "on" : "off");
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
  history: "app.view.history",
  settings: "app.view.settings",
};

/**
 * A project's page around its two views: toolbar (view switch, live state, AI panel), external
 * changes, the board or the graph, and the side panel both share: the open task, or else the AI
 * panel. The view, the open task and the task filter live in the URL.
 */
export function ProjectView({
  board,
  live,
  view,
  openId,
  filter: routeFilter,
  readOnly = false,
}: {
  board: BoardOk;
  live: LiveState;
  view: ProjectViewName;
  openId: string | null;
  /** The task filter of the board and the graph (UI-10); absent when nothing is filtered. */
  filter?: TaskFilter | undefined;
  /** The file is invalid: this is the last valid version, shown without drag or actions. */
  readOnly?: boolean;
}) {
  const projectId = board.project.id;
  const doc = useMemo(() => toDocument(board), [board]);
  const filterKey = JSON.stringify(routeFilter ?? {});
  // biome-ignore lint/correctness/useExhaustiveDependencies: the serialized filter is its identity.
  const filter = useMemo<TaskFilter>(() => routeFilter ?? {}, [filterKey]);
  const filtering = isFilterActive(filter);
  const visible = useMemo(
    () => (filtering ? matchingIds(doc, filter) : undefined),
    [doc, filter, filtering],
  );
  const facets = useMemo(() => filterFacets(doc), [doc]);
  const shownTasks = useMemo(
    () => (visible ? board.tasks.filter((task) => visible.has(task.id)) : board.tasks),
    [board.tasks, visible],
  );
  const [swimlanes, setSwimlanes] = useState(readLanesPref);
  const [hideDone, setHideDone] = useState(() => readFlag(GRAPH_DONE_KEY));
  const [graphGrouped, setGraphGrouped] = useState(() => readFlag(GRAPH_GROUPS_KEY));
  const graphTasks = useMemo(
    () => (hideDone ? shownTasks.filter((task) => task.state !== "done") : shownTasks),
    [shownTasks, hideDone],
  );
  const [doneDays, setDoneDays] = useState<DoneWindow>(readDoneWindow);
  const flagged = useMemo(() => new Set(board.external.map((f) => f.task)), [board.external]);
  const openedLive = openId ? board.tasks.find((task) => task.id === openId) : undefined;
  // An archived task (CORE-18) opens from the History, read-only.
  const openedArchived = openId && !openedLive ? archivedTask(board, openId) : undefined;
  const opened = openedLive ?? openedArchived;
  const toast = useToast();
  const offer = useUndoOffer(projectId);
  const [chatOpen, setChatOpen] = useState(readChatPref);
  const toggleChat = () => {
    setChatOpen(!chatOpen);
    writeChatPref(!chatOpen);
  };
  const action = useTaskAction(projectId);
  const sendChat = useSendChat(projectId);
  /**
   * «Afinar con IA» (UI-20): the AI panel takes the side, and its next message is the task with
   * its content; the planning agent edits it with the plan tools, and the board updates live.
   */
  const refine = (task: BoardTask) => {
    if (!chatOpen) toggleChat();
    go({ task: null });
    const groupName = board.plan.groups.find((g) => g.id === task.group)?.name ?? task.group;
    sendChat.mutate(
      { text: refineMessage(task, groupName), model: readChatModel(projectId) },
      {
        onSuccess: () => toast.show(t("refine.sent", { id: task.id }), "info"),
        onError: (error) => {
          if (error instanceof ApiError && error.unauthorized) return;
          toast.show(t("chat.error", { message: error.message }), "error");
        },
      },
    );
  };
  const [creating, setCreating] = useState(false);
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
          filter,
        }),
      ),
    [projectId, view, openId, filter],
  );
  /** A filter change rewrites the URL in place: typing must not fill the browser history. */
  const setFilter = (next: TaskFilter) =>
    replaceRoute(projectHref(projectId, { view, task: openId, filter: next }));
  const open = useCallback((id: string) => go({ task: id }), [go]);
  const stateOf = (id: string) => board.tasks.find((task) => task.id === id)?.state;
  const promotable = readOnly ? [] : selectedIds.filter((id) => stateOf(id) === "proposed");
  const deletable = readOnly ? [] : selectedIds;
  /** Runs one action on each selected task in turn; the ones refused stay selected. */
  const runSelected = async (kind: "promote" | "delete", ids: readonly string[]) => {
    if (kind === "delete") {
      const dependents = doc.tasks
        .filter((task) => task.deps?.some((dep) => ids.includes(dep)) && !ids.includes(task.id))
        .map((task) => task.id);
      if (!(await confirmDelete(ids, dependents, askConfirm))) return;
    }
    const refused: string[] = [];
    const steps: UndoChange[][] = [];
    for (const id of ids) {
      const task = board.tasks.find((x) => x.id === id);
      if (!task) continue;
      try {
        const reply = await action.mutateAsync({ task, action: kind });
        if (reply.undo) steps.push(reply.undo);
      } catch (error) {
        if (error instanceof ApiError && error.unauthorized) return;
        refused.push(id);
        toast.show(t("selection.error", { id, message: (error as Error).message }), "error");
      }
    }
    const done = ids.length - refused.length;
    // One «Deshacer» for the whole bulk action (UI-21).
    if (done > 0)
      offer(
        t(kind === "promote" ? "selection.promote.done" : "selection.delete.done", { n: done }),
        mergeUndo(steps),
      );
    dispatchSelection({ type: "clear" });
    if (refused.length > 0) dispatchSelection({ type: "add", ids: refused });
  };
  const edit = useEditTask(projectId);
  /**
   * Applies one bulk change to each selected task, as one `edit` conditioned on the version shown
   * (UI-26). Tasks that already had it are skipped; the ones refused stay selected, with the reason.
   */
  const editError = (error: unknown, ctx: { id: string; on?: string }) =>
    error instanceof ApiError
      ? editErrorText(
          {
            code: error.code,
            message: error.message,
            ...(error.details.issues ? { issues: error.details.issues } : {}),
          },
          ctx,
        )
      : String(error);
  /**
   * A dependency added or removed from the graph (UI-23): checked with core's rules first, so a
   * cycle is explained before anything is sent, then one `depend` or `undepend` op conditioned on
   * the dependent task as the graph showed it.
   */
  const relink = (op: "depend" | "undepend", link: Link) => {
    const task = board.tasks.find((x) => x.id === link.task);
    if (!task) return;
    if (op === "depend") {
      const why = dependencyProblem(doc, link.task, link.on);
      if (why) {
        toast.show(why, "error");
        return;
      }
    }
    edit.mutate(
      { op, task: link.task, hash: task.hash, on: link.on },
      {
        onSuccess: (reply) =>
          offer(
            t(op === "depend" ? "edit.deps.added" : "edit.deps.removed", {
              id: link.task,
              on: link.on,
            }),
            reply.undo,
          ),
        onError: (error) => {
          if (error instanceof ApiError && error.unauthorized) return;
          toast.show(editError(error, { id: link.task, on: link.on }), "error");
        },
      },
    );
  };
  const runBulk = async (change: BulkChange) => {
    const steps: UndoChange[][] = [];
    const { changed, refused } = await applyBulk(
      board.tasks,
      selectedIds,
      change,
      async (id, hash, changes) => {
        const reply = await edit.mutateAsync({ op: "edit", task: id, hash, changes });
        if (reply.undo) steps.push(reply.undo);
      },
    );
    if (refused.some(({ error }) => error instanceof ApiError && error.unauthorized)) return;
    for (const { id, error } of refused) toast.show(editError(error, { id }), "error");
    const n = changed.length;
    if (n > 0)
      offer(
        change.kind === "group"
          ? t("bulk.group.done", { n, group: change.group })
          : t(change.kind === "label-add" ? "bulk.label.added" : "bulk.label.removed", {
              n,
              label: change.label,
            }),
        mergeUndo(steps),
      );
    else if (refused.length === 0) toast.show(t("bulk.none"), "info");
    dispatchSelection({ type: "clear" });
    if (refused.length > 0) dispatchSelection({ type: "add", ids: refused.map((r) => r.id) });
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
        {view === "board" && (
          <Segmented
            label={t("board.done.window")}
            value={String(doneDays)}
            onChange={(value) => {
              const days = Number(value) as DoneWindow;
              setDoneDays(days);
              writeDoneWindow(days);
            }}
            options={DONE_WINDOWS.map((days) => ({
              value: String(days),
              label: days === 0 ? t("board.done.all") : t("board.done.days", { n: days }),
            }))}
          />
        )}
        {view === "graph" && (
          <Segmented
            label={t("graph.done")}
            value={hideDone ? "hide" : "show"}
            onChange={(value) => {
              setHideDone(value === "hide");
              writeFlag(GRAPH_DONE_KEY, value === "hide");
            }}
            options={[
              { value: "show", label: t("graph.done.show") },
              { value: "hide", label: t("graph.done.hide") },
            ]}
          />
        )}
        {view === "graph" && (
          <Segmented
            label={t("graph.grouping")}
            value={graphGrouped ? "groups" : "none"}
            onChange={(value) => {
              setGraphGrouped(value === "groups");
              writeFlag(GRAPH_GROUPS_KEY, value === "groups");
            }}
            options={[
              { value: "groups", label: t("board.lanes.groups") },
              { value: "none", label: t("graph.grouping.none") },
            ]}
          />
        )}
        {!readOnly && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setCreating(true);
              go({ task: null });
            }}
          >
            {t("create.open")}
          </Button>
        )}
        <Button
          size="sm"
          variant={chatOpen ? "primary" : "secondary"}
          aria-pressed={chatOpen}
          onClick={toggleChat}
        >
          {t("chat.toggle")}
        </Button>
        <a className="s-nav__link b-toolbar__back" href="#/">
          {t("project.back")}
        </a>
      </div>
      <ExternalChanges
        projectId={projectId}
        flags={board.external}
        tasks={doc.tasks}
        readOnly={readOnly}
      />
      {(view === "board" || view === "graph") && board.tasks.length > 0 && (
        <FilterBar
          filter={filter}
          groups={board.plan.groups}
          facets={facets}
          hidden={board.tasks.length - shownTasks.length}
          onChange={setFilter}
        />
      )}
      {view === "settings" ? (
        <div className="s-stack">
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
            {view === "history" ? (
              <HistoryView
                projectId={projectId}
                doc={doc}
                archive={board.archive}
                archiveError={board.archiveError}
                openId={opened ? opened.id : null}
              />
            ) : board.tasks.length === 0 ? (
              <p className="s-text s-muted">{t("board.empty")}</p>
            ) : shownTasks.length === 0 ? (
              <p className="s-text s-muted">{t("filter.none")}</p>
            ) : view === "graph" && graphTasks.length === 0 ? (
              <p className="s-text s-muted">{t("graph.done.allHidden")}</p>
            ) : view === "graph" ? (
              <Graph
                label={t("graph.label", { name: board.project.name })}
                tasks={graphTasks}
                grouped={graphGrouped}
                groups={board.plan.groups}
                external={flagged}
                openId={opened ? opened.id : null}
                onOpen={open}
                selected={selected}
                onToggle={toggle}
                onSelectWithDeps={selectWithDeps}
                onLink={readOnly ? undefined : (link) => relink("depend", link)}
                onUnlink={readOnly ? undefined : (link) => relink("undepend", link)}
              />
            ) : (
              <Board
                board={board}
                swimlanes={swimlanes}
                onOpen={open}
                selection={{ selected, onToggle: toggle }}
                visible={visible}
                readOnly={readOnly}
                doneDays={doneDays}
              />
            )}
          </div>
          {opened ? (
            <TaskPanel
              key={opened.id}
              projectId={projectId}
              groups={board.plan.groups}
              task={opened}
              doc={doc}
              groupName={board.plan.groups.find((g) => g.id === opened.group)?.name ?? opened.group}
              external={board.external.filter((f) => f.task === opened.id)}
              readOnly={readOnly || openedArchived !== undefined}
              archived={openedArchived !== undefined}
              archive={board.archive}
              onClose={() => go({ task: null })}
              onOpen={open}
              onRefine={() => refine(opened)}
              onSelectWithDeps={
                view === "graph" && isSelectable(opened)
                  ? () => selectWithDeps(opened.id)
                  : undefined
              }
            />
          ) : creating && !readOnly ? (
            <TaskCreator
              projectId={projectId}
              doc={doc}
              onCreated={(id) => {
                setCreating(false);
                open(id);
              }}
              onClose={() => setCreating(false)}
            />
          ) : (
            chatOpen && <ChatPanel projectId={projectId} readOnly={readOnly} onClose={toggleChat} />
          )}
        </div>
      )}
      {selectedIds.length > 0 && (
        <SelectionBar
          ids={selectedIds}
          promotable={promotable}
          deletable={deletable}
          readOnly={readOnly}
          busy={action.isPending || edit.isPending}
          groups={board.plan.groups}
          labels={facets.labels}
          onBulk={(change) => void runBulk(change)}
          onPromote={(ids) => void runSelected("promote", ids)}
          onDelete={(ids) => void runSelected("delete", ids)}
          onClear={() => dispatchSelection({ type: "clear" })}
        />
      )}
    </div>
  );
}
