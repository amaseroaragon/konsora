import { isActiveRunState, type Run } from "@konsora/core";
import { useEffect, useState } from "react";
import { useApprovals } from "../api/approvals.ts";
import { ApiError } from "../api/client.ts";
import { useCancelRun, useRunDiff, useRunEvents } from "../api/runs.ts";
import { t } from "../i18n/index.ts";
import { Button, RunLog, useToast } from "../ui/index.ts";
import { RunApprovals } from "./Approvals.tsx";
import { patchFiles } from "./review-model.ts";
import {
  formatSeconds,
  formatTokens,
  logRows,
  RUN_STATE_KEY,
  runErrorText,
  runSeconds,
  runUsage,
  touchedFiles,
} from "./run-model.ts";

/** Ticks every second while `live`, for the running duration. */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);
  return now;
}

/**
 * A task's latest run: state, duration, usage, the files it touched and its live log, with Cancel
 * while it is active. The log grows from `run.event` messages without reloading.
 */
export function RunSection({
  projectId,
  run,
  readOnly,
  children,
}: {
  projectId: string;
  run: Run;
  readOnly: boolean;
  /** Extra content inside the section (pending approvals, the review). */
  children?: React.ReactNode;
}) {
  const active = isActiveRunState(run.state);
  const events = useRunEvents(projectId, run.id).data ?? [];
  const cancel = useCancelRun(projectId);
  const toast = useToast();
  const now = useNow(active);
  const seconds = runSeconds(run, now);
  const usage = runUsage(run, events);
  // Live: the agent's file events. Closed: its diff, which also covers changes made through Bash.
  const diff = useRunDiff(projectId, run.id, !active).data;
  const files = !active && typeof diff === "string" ? patchFiles(diff) : touchedFiles(events);
  const rows = logRows(events);
  const approvals = (useApprovals().data ?? []).filter((a) => a.run === run.id);
  return (
    <section className="b-run a-stack" aria-label={t("run.id", { id: run.id })}>
      <div className="b-run__head">
        <span className="k-label">{t("run.section")}</span>
        <span className="k-mono b-run__id">{run.id}</span>
        <span className={`a-run-state a-run-state--${run.state}`} role="status">
          {t(RUN_STATE_KEY[run.state])}
        </span>
      </div>
      <dl className="a-stats">
        <div>
          <dt className="k-label">{t("run.agent")}</dt>
          <dd className="k-mono">
            {run.agent.provider} · {run.agent.model}
          </dd>
        </div>
        <div>
          <dt className="k-label">{t("run.duration")}</dt>
          <dd className="k-mono">{seconds === null ? "—" : formatSeconds(seconds)}</dd>
        </div>
        <div>
          <dt className="k-label">{t("run.tokens")}</dt>
          <dd className="k-mono">
            {usage ? `${formatTokens(usage.input)} / ${formatTokens(usage.output)}` : "—"}
          </dd>
        </div>
        {usage?.cost != null && (
          <div>
            <dt className="k-label">{t("run.cost")}</dt>
            <dd className="k-mono">{`$${usage.cost.toFixed(2)}`}</dd>
          </div>
        )}
      </dl>
      <RunApprovals approvals={approvals} readOnly={readOnly} />
      {children}
      <div>
        <div className="k-label">{t("run.files")}</div>
        {files.length === 0 ? (
          <p className="s-muted">{t(active ? "run.files.none" : "run.files.none.closed")}</p>
        ) : (
          <ul className="b-run__files">
            {files.map((file) => (
              <li key={file.path}>
                <span className="k-mono">{file.path}</span>{" "}
                <span className="s-muted">{t(`run.file.${file.change}`)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <div className="k-label">{t("run.log")}</div>
        {rows.length === 0 ? (
          <p className="s-muted">{t("run.log.empty")}</p>
        ) : (
          <RunLog events={rows} live={active} />
        )}
      </div>
      {active && !readOnly && (
        <div className="a-actions">
          <Button
            variant="danger"
            busy={cancel.isPending}
            onClick={() =>
              cancel.mutate(run.id, {
                onSuccess: () => toast.show(t("run.cancelled", { id: run.task }), "info"),
                onError: (error) => {
                  if (error instanceof ApiError && error.unauthorized) return;
                  const code = error instanceof ApiError ? error.code : "error";
                  toast.show(runErrorText(code, run.task, error.message), "error");
                },
              })
            }
          >
            {t("run.cancel")}
          </Button>
        </div>
      )}
    </section>
  );
}
