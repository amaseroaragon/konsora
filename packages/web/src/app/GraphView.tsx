import type { Dispatch } from "react";
import { t } from "../i18n/index.ts";
import { stateLabel } from "../ui/index.ts";
import { matches } from "./BoardView.tsx";
import { activeRun, blockers, byId, depths } from "./model.ts";
import type { Action, AppState } from "./state.ts";

const NODE_W = 220;
const NODE_H = 82;
const GAP_X = 72;
const GAP_Y = 20;
const PAD = 24;

/**
 * Layered dependency graph (longest-path depth → column). A lightweight stand-in for the
 * @xyflow/react + ELK view planned in M4; it shares the same visual language.
 */
export function GraphView({ state, dispatch }: { state: AppState; dispatch: Dispatch<Action> }) {
  const { tasks, runs } = state.project;
  const index = byId(tasks);
  const depth = depths(tasks);
  const columns = new Map<number, string[]>();
  for (const task of tasks) {
    const d = depth.get(task.id) ?? 0;
    columns.set(d, [...(columns.get(d) ?? []), task.id]);
  }
  const pos = new Map<string, { x: number; y: number }>();
  for (const [d, ids] of columns) {
    for (const [row, id] of ids.entries()) {
      pos.set(id, { x: PAD + d * (NODE_W + GAP_X), y: PAD + row * (NODE_H + GAP_Y) });
    }
  }
  const width = PAD * 2 + Math.max(...columns.keys()) * (NODE_W + GAP_X) + NODE_W;
  const height =
    PAD * 2 +
    Math.max(...[...columns.values()].map((ids) => ids.length)) * (NODE_H + GAP_Y) -
    GAP_Y;
  const highlighted = new Set(
    tasks.filter((task) => state.query && matches(task, state.query)).map((task) => task.id),
  );

  return (
    <section className="a-graph" aria-label={t("app.view.graph")}>
      <div className="a-graph__canvas" style={{ width, height }}>
        <svg className="a-graph__edges" width={width} height={height} aria-hidden="true">
          {tasks.flatMap((task) =>
            task.deps.map((dep) => {
              const from = pos.get(dep);
              const to = pos.get(task.id);
              if (!from || !to) return null;
              const x1 = from.x + NODE_W;
              const y1 = from.y + NODE_H / 2;
              const x2 = to.x;
              const y2 = to.y + NODE_H / 2;
              const mid = (x1 + x2) / 2;
              const done = index.get(dep)?.state === "done";
              return (
                <path
                  key={`${dep}-${task.id}`}
                  d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`}
                  className={done ? "a-graph__edge a-graph__edge--done" : "a-graph__edge"}
                />
              );
            }),
          )}
        </svg>
        {tasks.map((task) => {
          const p = pos.get(task.id);
          if (!p) return null;
          const blocked = blockers(task, index).length > 0;
          const running = Boolean(activeRun(task, runs));
          const classes = [
            "a-node",
            `a-node--${task.state}`,
            blocked && "a-node--blocked",
            running && "a-node--running",
            state.open === task.id && "a-node--open",
            highlighted.has(task.id) && "a-node--match",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <button
              key={task.id}
              type="button"
              className={classes}
              style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }}
              onClick={() => dispatch({ type: "open", id: task.id })}
            >
              <span className="a-node__head">
                <span className={`k-state-mark k-state-mark--${task.state}`} aria-hidden="true" />
                <span className="a-node__id">{task.id}</span>
                <span className="a-node__state">
                  {blocked ? stateLabel("blocked") : stateLabel(task.state)}
                </span>
              </span>
              <span className="a-node__title">{task.title}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
