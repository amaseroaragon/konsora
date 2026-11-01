import type { Run } from "@konsora/core";
import { ApiError } from "../api/client.ts";
import { useDiscardRun } from "../api/runs.ts";
import { t } from "../i18n/index.ts";
import { Button, useToast } from "../ui/index.ts";
import { RUN_STATE_KEY, runErrorText } from "./run-model.ts";

/** Earlier runs of the task that still keep a worktree and branch, each with Discard. */
export function OlderRuns({
  projectId,
  runs,
  readOnly,
}: {
  projectId: string;
  runs: readonly Run[];
  readOnly: boolean;
}) {
  const discard = useDiscardRun(projectId);
  const toast = useToast();
  if (runs.length === 0) return null;
  return (
    <div className="b-older">
      <div className="k-label">{t("run.older")}</div>
      <ul className="b-older__list">
        {runs.map((run) => (
          <li key={run.id}>
            <span className="k-mono">{run.id}</span>{" "}
            <span className={`a-run-state a-run-state--${run.state}`}>
              {t(RUN_STATE_KEY[run.state])}
            </span>
            {!readOnly && (
              <Button
                size="sm"
                variant="ghost"
                busy={discard.isPending && discard.variables === run.id}
                title={t("run.discard.hint")}
                onClick={() =>
                  discard.mutate(run.id, {
                    onSuccess: () => toast.show(t("run.discarded", { id: run.task }), "info"),
                    onError: (error) => {
                      if (error instanceof ApiError && error.unauthorized) return;
                      const code = error instanceof ApiError ? error.code : "error";
                      toast.show(runErrorText(code, run.task, error.message), "error");
                    },
                  })
                }
              >
                {t("run.discard")}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
