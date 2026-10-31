import type { Dispatch } from "react";
import { t } from "../i18n/index.ts";
import { Matrix, TaskCard, taskStates } from "../ui/index.ts";
import {
  activeRun,
  agentLabel,
  blockers,
  byId,
  formatDuration,
  isWaiting,
  type Task,
} from "./model.ts";
import type { Action, AppState } from "./state.ts";

export function matches(task: Task, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return q.split(/\s+/).every((term) => {
    const [key, value] = term.includes(":") ? term.split(":", 2) : [undefined, term];
    if (key === "state") return task.state === value;
    if (key === "group") return task.group.toLowerCase() === value;
    return `${task.id} ${task.title}`.toLowerCase().includes(value ?? "");
  });
}

export function BoardView({
  state,
  dispatch,
  now,
}: {
  state: AppState;
  dispatch: Dispatch<Action>;
  now: number;
}) {
  const { project } = state;
  const index = byId(project.tasks);
  const visible = project.tasks.filter((task) => matches(task, state.query));

  const card = (task: Task) => {
    const run = activeRun(task, project.runs);
    const blockedBy = blockers(task, index);
    const ready = task.state === "todo" && blockedBy.length === 0;
    return (
      <TaskCard
        key={task.id}
        id={task.id}
        title={task.title}
        state={task.state}
        blockedBy={blockedBy}
        waiting={isWaiting(task)}
        {...(run ? { running: formatDuration((now - Date.parse(run.startedAt)) / 1000) } : {})}
        {...(task.agent ? { agent: agentLabel(task.agent) } : {})}
        {...(task.state === "proposed" ? { proposedBy: task.createdBy.replace("agent:", "") } : {})}
        selected={state.selected.has(task.id) || state.open === task.id}
        {...(ready
          ? {
              onSelectedChange: (selected: boolean) =>
                dispatch({ type: "select", id: task.id, selected }),
            }
          : {})}
        onOpen={() =>
          dispatch({
            type: "open",
            id: task.id,
            tab: task.state === "review" ? "review" : run ? "run" : "detail",
          })
        }
      />
    );
  };

  if (visible.length === 0) {
    return <p className="a-empty">{t("app.board.empty")}</p>;
  }

  return (
    <div className="a-board">
      <Matrix
        label={t("app.view.board")}
        columns={taskStates.map((s) => ({
          state: s,
          count: visible.filter((task) => task.state === s).length,
        }))}
        lanes={project.groups
          .filter((group) => visible.some((task) => task.group === group.id))
          .map((group) => ({
            id: group.id,
            name: group.name,
            cells: taskStates.map((s) =>
              visible.filter((task) => task.group === group.id && task.state === s).map(card),
            ),
          }))}
      />
    </div>
  );
}
