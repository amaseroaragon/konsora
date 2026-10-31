import { useEffect, useReducer, useState } from "react";
import { mockProject } from "../mock/data.ts";
import { BoardView } from "./BoardView.tsx";
import { DetailPanel } from "./DetailPanel.tsx";
import { GraphView } from "./GraphView.tsx";
import { Header } from "./Header.tsx";
import { RunsView } from "./RunsView.tsx";
import { SelectionBar } from "./SelectionBar.tsx";
import { type AppState, reducer } from "./state.ts";

const initial: AppState = {
  project: mockProject,
  view: "board",
  query: "",
  selected: new Set(["UI-06"]),
  open: "CORE-04",
  tab: "review",
  agent: { provider: "claude", model: "opus", effort: "alto" },
  permissions: "default",
  parallel: 2,
};

/** Ticks once per second while any run is live, so elapsed times update. */
function useClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

/** Deep links: `?view=board|graph|runs` and `?open=<task id>` (`?open=` closes the panel). */
function fromUrl(search: string): AppState {
  const params = new URLSearchParams(search);
  const view = params.get("view");
  const open = params.get("open");
  return {
    ...initial,
    ...(view === "board" || view === "graph" || view === "runs" ? { view } : {}),
    ...(open !== null ? { open: open || null, tab: "detail" as const } : {}),
  };
}

export function App() {
  const [state, dispatch] = useReducer(reducer, window.location.search, fromUrl);
  const clock = useClock(state.project.runs.some((run) => run.state === "running"));

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && state.open && !(event.target instanceof HTMLTextAreaElement)) {
        dispatch({ type: "open", id: null });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.open]);

  return (
    <div className="a-app">
      <Header state={state} dispatch={dispatch} />
      <div className="a-main">
        <main className="a-content">
          <div className="a-view">
            {state.view === "board" && <BoardView state={state} dispatch={dispatch} now={clock} />}
            {state.view === "graph" && <GraphView state={state} dispatch={dispatch} />}
            {state.view === "runs" && <RunsView state={state} dispatch={dispatch} now={clock} />}
          </div>
          <SelectionBar state={state} dispatch={dispatch} />
        </main>
        <DetailPanel state={state} dispatch={dispatch} clock={clock} />
      </div>
    </div>
  );
}
