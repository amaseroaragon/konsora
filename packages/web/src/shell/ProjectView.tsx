import { pendingSubgraph } from "@konsora/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type BoardOk, type LiveState, toDocument, useTaskAction } from "../api/board.ts";
import { ApiError } from "../api/client.ts";
import { type MessageKey, t } from "../i18n/index.ts";
import { Button, Segmented, StateBadge, useToast } from "../ui/index.ts";
import { Board } from "./Board.tsx";
import { ChatPanel } from "./ChatPanel.tsx";
import { ExternalChanges } from "./External.tsx";
import { Graph } from "./Graph.tsx";
import { navigate, type ProjectViewName, projectHref, projectViews } from "./route.ts";
import { SelectionBar } from "./SelectionBar.tsx";
import { isSelectable, useSelection, visibleSelection } from "./selection.ts";
import { TaskCreator } from "./TaskCreator.tsx";
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
  settings: "app.view.settings",
};

/**
 * A project's page around its two views: toolbar (view switch, live state, AI panel), external
 * changes, the board or the graph, and the side panel both share: the open task, or else the AI
 * panel. The view and the open task live in the URL.
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
  const [chatOpen, setChatOpen] = useState(readChatPref);
  const toggleChat = () => {
    setChatOpen(!chatOpen);
    writeChatPref(!chatOpen);
  };
  const approve = useTaskAction(projectId);
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
        }),
      ),
    [projectId, view, openId],
  );
  const open = useCallback((id: string) => go({ task: id }), [go]);
  const approvable = selectedIds.filter(
    (id) => !readOnly && board.tasks.find((task) => task.id === id)?.state === "proposed",
  );
  /** Approves the selected proposals one after another; the ones refused stay selected. */
  const approveSelected = async (ids: readonly string[]) => {
    const refused: string[] = [];
    for (const id of ids) {
      const task = board.tasks.find((x) => x.id === id);
      if (!task) continue;
      try {
        await approve.mutateAsync({ task, action: "approve" });
      } catch (error) {
        if (error instanceof ApiError && error.unauthorized) return;
        refused.push(id);
        toast.show(
          t("selection.approve.error", { id, message: (error as Error).message }),
          "error",
        );
      }
    }
    const approved = ids.length - refused.length;
    if (approved > 0) toast.show(t("selection.approve.done", { n: approved }), "success");
    dispatchSelection({ type: "clear" });
    if (refused.length > 0) dispatchSelection({ type: "add", ids: refused });
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
      <ExternalChanges projectId={projectId} flags={board.external} readOnly={readOnly} />
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
                board={board}
                swimlanes={swimlanes}
                onOpen={open}
                selection={{ selected, onToggle: toggle }}
                readOnly={readOnly}
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
              readOnly={readOnly}
              onClose={() => go({ task: null })}
              onOpen={open}
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
          approvable={approvable}
          readOnly={readOnly}
          busy={approve.isPending}
          onApprove={(ids) => void approveSelected(ids)}
          onClear={() => dispatchSelection({ type: "clear" })}
        />
      )}
    </div>
  );
}
