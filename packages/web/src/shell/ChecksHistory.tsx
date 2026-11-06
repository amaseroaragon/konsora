import { type CheckAttempt, type ChecksFile, checkPassed, checksPassed } from "@konsora/core";
import { useRunChecks } from "../api/runs.ts";
import { t } from "../i18n/index.ts";
import { checkOutcome, formatDuration, sourceLabel } from "./checks-model.ts";

/** One attempt: each check green or red, how it ended, how long it took, its output on demand. */
function Attempt({ attempt, last }: { attempt: CheckAttempt; last: boolean }) {
  const passed = checksPassed(attempt.results);
  return (
    <section className="b-checks__attempt" aria-label={t("checks.attempt", { n: attempt.attempt })}>
      <h4 className="k-label b-checks__title">
        {t("checks.attempt", { n: attempt.attempt })} ·{" "}
        <span className={passed ? "b-checks__ok" : "b-checks__fail"}>
          {passed ? t("checks.attempt.ok") : t("checks.attempt.fail")}
        </span>
        {last && <span className="s-muted"> · {t("checks.attempt.last")}</span>}
      </h4>
      <ul className="b-checks__list">
        {attempt.results.map((result) => {
          const ok = checkPassed(result);
          return (
            <li
              key={`${result.source}:${result.id}`}
              className={ok ? "b-check b-check--ok" : "b-check b-check--fail"}
            >
              <div className="b-check__head">
                <span className="b-check__mark" aria-hidden="true">
                  {ok ? "✓" : "✕"}
                </span>
                <span className="k-mono b-check__id">{result.id}</span>
                <span className="s-muted">{sourceLabel(result)}</span>
                <span className={ok ? "b-checks__ok" : "b-checks__fail"}>
                  {checkOutcome(result)}
                </span>
                <span className="s-muted k-mono">{formatDuration(result.duration_ms)}</span>
              </div>
              <div className="k-mono b-check__command">{result.command}</div>
              <details className="b-check__output" open={!ok && last}>
                <summary>
                  {result.output
                    ? result.output_truncated
                      ? t("checks.output.tail")
                      : t("checks.output")
                    : t("checks.output.none")}
                </summary>
                {result.output && <pre className="b-check__pre">{result.output}</pre>}
              </details>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Every attempt of a run's checks, the latest first. */
export function ChecksList({ file }: { file: ChecksFile }) {
  const attempts = [...file.attempts].reverse();
  return (
    <div className="b-checks">
      {attempts.map((attempt, index) => (
        <Attempt key={attempt.attempt} attempt={attempt} last={index === 0} />
      ))}
    </div>
  );
}

/** The checks section of a run's review: loads `checks.json` and keeps it live. */
export function ChecksHistory({ projectId, runId }: { projectId: string; runId: string }) {
  const checks = useRunChecks(projectId, runId);
  return (
    <div>
      <div className="k-label">{t("checks.title")}</div>
      {checks.isPending ? (
        <p className="s-muted">{t("action.loading")}</p>
      ) : !checks.data || checks.data.attempts.length === 0 ? (
        <p className="s-muted">{t("checks.none")}</p>
      ) : (
        <ChecksList file={checks.data} />
      )}
    </div>
  );
}
