import type { Run } from "@konsora/core";
import { ApiError } from "../api/client.ts";
import { useRebaseRun } from "../api/queue.ts";
import { useRunDiff } from "../api/runs.ts";
import { t } from "../i18n/index.ts";
import { Button, DiffView, useToast } from "../ui/index.ts";
import { ChecksHistory } from "./ChecksHistory.tsx";
import { runChecksFailed } from "./checks-model.ts";
import { Markdown } from "./Markdown.tsx";
import { diffTotals, parsePatch } from "./review-model.ts";

/**
 * What to review before accepting a run's work: its diff per file and the agent's summary (the
 * run section around it shows model, duration and usage). A failed integration is explained
 * until it is retried.
 */
export function ReviewSection({
  projectId,
  run,
  summary,
  readOnly = false,
}: {
  projectId: string;
  run: Run;
  /** The agent's summary (its `finish`), if any. */
  summary: string | undefined;
  readOnly?: boolean;
}) {
  const diff = useRunDiff(projectId, run.id);
  const files = diff.data ? parsePatch(diff.data) : [];
  const totals = diffTotals(files);
  return (
    <div className="a-stack b-review">
      {run.integration?.state === "conflict" && (
        <div className="a-callout a-callout--warn a-stack" role="status">
          <p>{t("review.conflict.persist")}</p>
          {!readOnly && <RebaseAction projectId={projectId} run={run} />}
        </div>
      )}
      {runChecksFailed(run) && (
        <p className="a-callout a-callout--warn" role="status">
          {t("checks.review.failing")}
        </p>
      )}
      {summary && (
        <div className="a-summary">
          <div className="k-label">{t("review.summary")}</div>
          <Markdown className="md--compact" text={summary} />
        </div>
      )}
      <ChecksHistory projectId={projectId} runId={run.id} />
      <div>
        <div className="k-label">{t("review.diff")}</div>
        {diff.isPending ? (
          <p className="s-muted">{t("review.diff.loading")}</p>
        ) : files.length === 0 ? (
          <p className="s-muted">{t("review.diff.none")}</p>
        ) : (
          <>
            <p className="k-mono a-diffstat">
              {t("review.files", { n: files.length })} · +{totals.added} −{totals.removed}
            </p>
            <DiffView files={files} />
          </>
        )}
      </div>
    </div>
  );
}

/** Ask the agent to rebase the conflicting branch, or resolve it by hand on that branch. */
function RebaseAction({ projectId, run }: { projectId: string; run: Run }) {
  const rebase = useRebaseRun(projectId);
  const toast = useToast();
  return (
    <div className="a-stack">
      <p className="s-muted">{t("review.rebase.hint", { branch: run.branch ?? "" })}</p>
      <div className="a-actions">
        <Button
          size="sm"
          variant="primary"
          busy={rebase.isPending}
          onClick={() =>
            rebase.mutate(run.id, {
              onSuccess: () => toast.show(t("review.rebase.started", { id: run.task }), "success"),
              onError: (error) => {
                if (error instanceof ApiError && error.unauthorized) return;
                toast.show(
                  error instanceof ApiError && error.code === "no_conflict"
                    ? t("review.rebase.no_conflict", { id: run.task })
                    : t("review.rebase.error", { id: run.task, message: error.message }),
                  "error",
                );
              },
            })
          }
        >
          {t("review.rebase")}
        </Button>
      </div>
    </div>
  );
}
