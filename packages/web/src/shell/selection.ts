/**
 * The task selection of a project (UI-07): one per project, shared by the board and the graph, and
 * kept outside both views so switching between them never loses it. It lives in memory only:
 * selecting is not an edit, so nothing here writes to the plan.
 */
import { useCallback, useSyncExternalStore } from "react";

export type SelectionAction =
  | { type: "toggle"; id: string }
  | { type: "add"; ids: readonly string[] }
  | { type: "clear" };

export function selectionReducer(
  state: ReadonlySet<string>,
  action: SelectionAction,
): ReadonlySet<string> {
  switch (action.type) {
    case "toggle": {
      const next = new Set(state);
      if (!next.delete(action.id)) next.add(action.id);
      return next;
    }
    case "add":
      return action.ids.every((id) => state.has(id)) ? state : new Set([...state, ...action.ids]);
    case "clear":
      return state.size === 0 ? state : new Set();
  }
}

/** Only tasks still to be done can be selected (a done task has nothing left to run). */
export const isSelectable = (task: { state: string }) => task.state !== "done";

/**
 * What the views show as selected: the stored ids that still exist and are selectable, in plan
 * order. A task that finished or vanished in a live update simply drops out.
 */
export function visibleSelection(
  stored: ReadonlySet<string>,
  tasks: readonly { id: string; state: string }[],
): string[] {
  return tasks.filter((task) => stored.has(task.id) && isSelectable(task)).map((task) => task.id);
}

export type SelectionStore = {
  get(project: string): ReadonlySet<string>;
  dispatch(project: string, action: SelectionAction): void;
  subscribe(listener: () => void): () => void;
};

export function createSelectionStore(): SelectionStore {
  const byProject = new Map<string, ReadonlySet<string>>();
  const listeners = new Set<() => void>();
  const empty: ReadonlySet<string> = new Set();
  return {
    get: (project) => byProject.get(project) ?? empty,
    dispatch(project, action) {
      const before = byProject.get(project) ?? empty;
      const after = selectionReducer(before, action);
      if (after === before) return;
      byProject.set(project, after);
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The app's store: per browser tab, gone on reload like any unsent choice. */
export const selectionStore = createSelectionStore();

export function useSelection(project: string, store: SelectionStore = selectionStore) {
  const selected = useSyncExternalStore(
    store.subscribe,
    () => store.get(project),
    () => store.get(project),
  );
  const dispatch = useCallback(
    (action: SelectionAction) => store.dispatch(project, action),
    [store, project],
  );
  return { selected, dispatch };
}
