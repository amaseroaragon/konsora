/**
 * Mock app state. Actions mimic the semantic ops the daemon will expose (DMN-02);
 * here they only change memory so the flows can be tried before the backend exists.
 */
import { type AgentSpec, blockers, byId, type Note, type Project, type Run } from "./model.ts";

export type View = "board" | "graph" | "runs";
export type DetailTab = "detail" | "run" | "review";

export type AppState = {
  project: Project;
  view: View;
  query: string;
  selected: ReadonlySet<string>;
  open: string | null;
  tab: DetailTab;
  agent: AgentSpec;
  permissions: string;
  parallel: number;
};

export type Action =
  | { type: "view"; view: View }
  | { type: "query"; query: string }
  | { type: "select"; id: string; selected: boolean }
  | { type: "clearSelection" }
  | { type: "open"; id: string | null; tab?: DetailTab }
  | { type: "tab"; tab: DetailTab }
  | { type: "agent"; agent: AgentSpec }
  | { type: "permissions"; value: string }
  | { type: "parallel"; value: number }
  | { type: "runSelection"; at: string }
  | { type: "approve"; id: string }
  | { type: "requestChanges"; id: string; text: string; at: string }
  | { type: "accept"; id: string }
  | { type: "sendBack"; id: string; text: string; at: string }
  | { type: "answer"; id: string; text: string; at: string }
  | { type: "cancelRun"; id: string };

function note(
  task: { notes: Note[] },
  by: Note["by"],
  kind: Note["kind"],
  text: string,
  at: string,
): Note[] {
  return [...task.notes, { id: `n${task.notes.length + 1}`, at, by, kind, text }];
}

function updateTask(
  state: AppState,
  id: string,
  change: (task: Project["tasks"][number]) => Project["tasks"][number],
): AppState {
  return {
    ...state,
    project: {
      ...state.project,
      tasks: state.project.tasks.map((task) => (task.id === id ? change(task) : task)),
    },
  };
}

function shortId(at: string, i: number): string {
  return `r-${Date.parse(at).toString(36).toUpperCase().slice(-6)}${i}`;
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "view":
      return { ...state, view: action.view };
    case "query":
      return { ...state, query: action.query };
    case "select": {
      const selected = new Set(state.selected);
      if (action.selected) selected.add(action.id);
      else selected.delete(action.id);
      return { ...state, selected };
    }
    case "clearSelection":
      return { ...state, selected: new Set() };
    case "open":
      return { ...state, open: action.id, tab: action.tab ?? "detail" };
    case "tab":
      return { ...state, tab: action.tab };
    case "agent":
      return { ...state, agent: action.agent };
    case "permissions":
      return { ...state, permissions: action.value };
    case "parallel":
      return { ...state, parallel: action.value };
    case "runSelection": {
      const index = byId(state.project.tasks);
      const ids = [...state.selected].filter((id) => {
        const task = index.get(id);
        return task?.state === "todo" && blockers(task, index).length === 0;
      });
      const time = new Date(action.at).toTimeString().slice(0, 8);
      const runs: Run[] = ids.map((id, i) => ({
        id: shortId(action.at, i),
        task: id,
        agent: state.agent,
        state: "running",
        startedAt: action.at,
        events: [
          { at: time, kind: "start", text: `${state.agent.model} · worktree konsora/${id}` },
        ],
        checks: [],
        diff: [],
      }));
      return {
        ...state,
        selected: new Set(),
        project: {
          ...state.project,
          runs: [...runs, ...state.project.runs],
          tasks: state.project.tasks.map((task) =>
            ids.includes(task.id) ? { ...task, state: "doing" } : task,
          ),
        },
      };
    }
    case "approve":
      return updateTask(state, action.id, (task) => ({ ...task, state: "todo" }));
    case "requestChanges":
      return updateTask(state, action.id, (task) => ({
        ...task,
        notes: note(task, "human", "feedback", action.text, action.at),
      }));
    case "accept": {
      const next = updateTask(state, action.id, (task) => ({ ...task, state: "done" }));
      return {
        ...next,
        project: {
          ...next.project,
          runs: next.project.runs.map((run) =>
            run.task === action.id && run.state === "succeeded"
              ? { ...run, integrated: true }
              : run,
          ),
        },
      };
    }
    case "sendBack":
      return updateTask(state, action.id, (task) => ({
        ...task,
        state: "todo",
        notes: note(task, "human", "feedback", action.text, action.at),
      }));
    case "answer":
      return updateTask(state, action.id, (task) => ({
        ...task,
        notes: note(task, "human", "answer", action.text, action.at),
      }));
    case "cancelRun": {
      const run = state.project.runs.find((r) => r.id === action.id);
      if (!run) return state;
      const next = updateTask(state, run.task, (task) => ({ ...task, state: "todo" }));
      return {
        ...next,
        project: {
          ...next.project,
          runs: next.project.runs.map((r) =>
            r.id === action.id ? { ...r, state: "cancelled" } : r,
          ),
        },
      };
    }
  }
}
