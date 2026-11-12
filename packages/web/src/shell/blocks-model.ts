/**
 * Moving existing tasks in and out of blocks from the UI (UI-07). Core's `set-block` keeps the
 * rules (no changes to a merged block); this decides what the UI offers and how it explains it.
 */
import type { Block, TasksDocument } from "@konsora/core";
import type { BoardTask } from "../api/board.ts";
import { t } from "../i18n/index.ts";

/** The open (not merged) blocks, where tasks can go. */
export function openBlocks(doc: Pick<TasksDocument, "blocks">): Block[] {
  return (doc.blocks ?? []).filter((block) => !block.merged);
}

/** True when the task's block, if any, is merged: such a task can no longer move. */
export function lockedInBlock(task: BoardTask, doc: Pick<TasksDocument, "blocks">): boolean {
  return (
    task.block !== undefined && doc.blocks?.find((b) => b.id === task.block)?.merged !== undefined
  );
}

/** Tasks that could join `block`: not in it already and not held by a merged block. */
export function addCandidates(
  tasks: readonly BoardTask[],
  doc: Pick<TasksDocument, "blocks">,
  block: string,
): BoardTask[] {
  return tasks.filter((task) => task.block !== block && !lockedInBlock(task, doc));
}

/** Of these tasks, the ones already started or done: their commits may be on another branch. */
export function startedIds(tasks: readonly BoardTask[]): string[] {
  return tasks.filter((task) => task.state === "doing" || task.state === "done").map((t) => t.id);
}

/** The warning for moving started or done work into a block, or null when there is none. */
export function moveWarning(tasks: readonly BoardTask[], block: Block): string | null {
  const ids = startedIds(tasks);
  return ids.length === 0
    ? null
    : t(ids.length === 1 ? "blocks.add.warn.one" : "blocks.add.warn.many", {
        ids: ids.join(", "),
        branch: block.branch,
      });
}

/** The op that puts one task in a block (or out of any, with null), on the version shown. */
export function setBlockOp(task: BoardTask, block: string | null) {
  return { op: "set-block", task: task.id, block, expect: { [task.id]: task.hash } };
}

/** Spanish text for a move core refused. */
export function moveErrorText(code: string, id: string, message: string): string {
  switch (code) {
    case "block_merged":
      return t("blocks.move.error.merged", { id });
    case "unknown_block":
      return t("blocks.move.error.unknown", { id });
    case "conflict":
      return t("move.conflict", { id });
    case "not_found":
      return t("move.not_found", { id });
    default:
      return t("move.refused", { id, message });
  }
}
