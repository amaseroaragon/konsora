/**
 * Read operations shared by the CLI (`--json`) and the MCP server: each returns the exact value
 * the CLI prints with `--json`, so both surfaces stay identical by construction.
 */
import type { TaskState, TasksDocument } from "@konsora/core";
import { readTasks, type StoreError } from "@konsora/core/store";
import { readyViews, STATES, type TaskView, views } from "./format.ts";
import { HINTS } from "./hints.ts";
import { CliError, EXIT } from "./shared.ts";

export function statusData(doc: TasksDocument) {
  const list = views(doc);
  const byState = Object.fromEntries(
    STATES.map((s) => [s, list.filter((t) => t.state === s).length]),
  );
  return {
    project: doc.project,
    groups: doc.groups,
    tasks: list.length,
    byState,
    ready: readyViews(list).map((t) => t.id),
    blocked: list.filter((t) => t.blocked).map((t) => t.id),
    waiting: list.filter((t) => t.waiting).map((t) => t.id),
    proposed: list.filter((t) => t.state === "proposed").map((t) => t.id),
  };
}

export type ListFilter = {
  state?: TaskState | undefined;
  group?: string | undefined;
  ready?: boolean | undefined;
  blocked?: boolean | undefined;
  waiting?: boolean | undefined;
};

/** The presets behind `list`, `ready` and `blocked`. */
export const LIST_PRESETS = {
  list: () => true,
  ready: (t: TaskView) => t.ready,
  blocked: (t: TaskView) => t.blocked,
} as const satisfies Record<string, (t: TaskView) => boolean>;

export function listData(
  doc: TasksDocument,
  filter: ListFilter,
  preset: (t: TaskView) => boolean = LIST_PRESETS.list,
): TaskView[] {
  if (filter.group && !doc.groups.some((g) => g.id === filter.group)) {
    throw new CliError(
      `Unknown group "${filter.group}".`,
      `Groups: ${doc.groups.map((g) => g.id).join(", ")}.`,
      EXIT.usage,
    );
  }
  const list = views(doc).filter(
    (t) =>
      preset(t) &&
      (!filter.state || t.state === filter.state) &&
      (!filter.group || t.group === filter.group) &&
      (!filter.ready || t.ready) &&
      (!filter.blocked || t.blocked) &&
      (!filter.waiting || t.waiting),
  );
  // What is ready comes in priority order (rank), so the first one is the next to take.
  return preset === LIST_PRESETS.ready || filter.ready ? readyViews(list) : list;
}

export function showData(doc: TasksDocument, id: string): TaskView {
  const view = views(doc).find((t) => t.id === id.toUpperCase());
  if (!view) throw new CliError(`Task ${id} does not exist.`, HINTS.unknownTask);
  return view;
}

export type CheckData =
  | { ok: true; tasks: number; groups: number; hash: string }
  | { ok: false; error: StoreError };

export async function checkData(root: string): Promise<CheckData> {
  const result = await readTasks(root);
  return result.ok
    ? {
        ok: true,
        tasks: result.document.tasks.length,
        groups: result.document.groups.length,
        hash: result.hash,
      }
    : { ok: false, error: result.error };
}
