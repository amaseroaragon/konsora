/**
 * «Deshacer» in the notice after a human action (UI-21): the daemon answers each op with what
 * undoes it, and the notice offers it. Undo is refused, never forced, if a task changed since.
 */
import type { UndoChange } from "@konsora/core";
import { useCallback } from "react";
import { useUndo } from "../api/board.ts";
import { ApiError } from "../api/client.ts";
import { t } from "../i18n/index.ts";
import { useToast } from "../ui/index.ts";

/** Why an undo was refused, in Spanish. */
export function undoErrorText(error: unknown): string {
  if (error instanceof ApiError && error.code === "conflict")
    return t("undo.conflict", { id: error.details.task ?? "" });
  if (error instanceof ApiError && error.code.startsWith("plan_"))
    return t("move.plan_unavailable");
  return t("undo.error", { message: error instanceof Error ? error.message : String(error) });
}

/**
 * `offer(text, undo)` shows a success notice for an action, with «Deshacer» when there is
 * something to undo.
 */
export function useUndoOffer(projectId: string) {
  const toast = useToast();
  const undo = useUndo(projectId);
  const mutateAsync = undo.mutateAsync;
  return useCallback(
    (text: string, changes: readonly UndoChange[] | undefined) => {
      // The promise, not mutate's callbacks: the component that offered the undo (a deleted
      // task's panel) may be gone by the time it is pressed.
      const run = () =>
        mutateAsync(changes ?? []).then(
          () => toast.show(t("undo.done"), "success"),
          (error: unknown) => {
            if (error instanceof ApiError && error.unauthorized) return;
            toast.show(undoErrorText(error), "error");
          },
        );
      toast.show(
        text,
        "success",
        changes && changes.length > 0 ? { label: t("undo.action"), run } : undefined,
      );
    },
    [toast, mutateAsync],
  );
}
