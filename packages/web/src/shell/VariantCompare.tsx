import { checkPassed, type Note, type Run } from "@konsora/core";
import { ApiError } from "../api/client.ts";
import { useChooseVariant, useRunDiff } from "../api/runs.ts";
import { t } from "../i18n/index.ts";
import { Button, DiffView, useToast } from "../ui/index.ts";
import { agentLabel } from "./agent-model.ts";
import { checkOutcome } from "./checks-model.ts";
import { formatCost } from "./cost-model.ts";
import { Markdown } from "./Markdown.tsx";
import { diffTotals, parsePatch } from "./review-model.ts";
import { formatTokens, RUN_STATE_KEY, runErrorText, runUsage } from "./run-model.ts";

/**
 * The variants of a task side by side (UI-24): agent, checks, usage and cost, the agent's summary
 * and the diff of each, with "Choose this one". Once one is chosen the others are discarded and
 * the task's review is the winner's, with Accept.
 */
export function VariantCompare({
  projectId,
  variants,
  notes,
  readOnly,
}: {
  projectId: string;
  variants: readonly Run[];
  notes: readonly Note[] | undefined;
  readOnly: boolean;
}) {
  return (
    <section className="a-stack b-variants" aria-label={t("variants.compare.title")}>
      <div>
        <div className="k-label">{t("variants.compare.title")}</div>
        <p className="s-muted">{t("variants.compare.text")}</p>
      </div>
      <div className="b-variants__grid">
        {variants.map((run, index) => (
          <Variant
            key={run.id}
            projectId={projectId}
            run={run}
            n={index + 1}
            summary={notes?.findLast((n) => n.kind === "summary" && n.run === run.id)?.text}
            readOnly={readOnly}
          />
        ))}
      </div>
    </section>
  );
}

function Variant({
  projectId,
  run,
  n,
  summary,
  readOnly,
}: {
  projectId: string;
  run: Run;
  n: number;
  summary: string | undefined;
  readOnly: boolean;
}) {
  const diff = useRunDiff(projectId, run.id);
  const choose = useChooseVariant(projectId);
  const toast = useToast();
  const files = diff.data ? parsePatch(diff.data) : [];
  const totals = diffTotals(files);
  const usage = runUsage(run, []);
  const checks = run.checks ?? [];
  return (
    <article className="a-stack b-variants__item" aria-label={t("variants.label", { n })}>
      <div className="b-reviews__head">
        <span className="k-label">{t("variants.label", { n })}</span>
        <span className={`a-run-state a-run-state--${run.state}`}>
          {t(RUN_STATE_KEY[run.state])}
        </span>
      </div>
      <p className="k-mono">{agentLabel(run.agent)}</p>
      <p className="k-mono s-muted">
        {usage
          ? `${formatTokens(usage.input)} / ${formatTokens(usage.output)} · ${
              usage.cost != null ? formatCost(usage.cost) : t("cost.unknown")
            }`
          : t("run.usage.none")}
      </p>
      {checks.length === 0 ? (
        <p className="s-muted">{t("variants.checks.none")}</p>
      ) : (
        <ul className="b-variants__checks">
          {checks.map((check) => (
            <li key={check.id} className={checkPassed(check) ? "b-checks__ok" : "b-checks__fail"}>
              {checkPassed(check) ? "✓" : "✕"} <span className="k-mono">{check.id}</span>{" "}
              <span className="s-muted">{checkOutcome(check)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="a-summary">
        <div className="k-label">{t("review.summary")}</div>
        {summary ? (
          <Markdown className="md--compact" text={summary} />
        ) : (
          <p className="s-muted">{t("variants.summary.none")}</p>
        )}
      </div>
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
      {!readOnly && (
        <div className="a-actions">
          <Button
            variant="primary"
            busy={choose.isPending}
            onClick={() =>
              choose.mutate(run.id, {
                onSuccess: () => toast.show(t("variants.chosen", { id: run.task }), "success"),
                onError: (error) => {
                  if (error instanceof ApiError && error.unauthorized) return;
                  const code = error instanceof ApiError ? error.code : "error";
                  toast.show(runErrorText(code, run.task, error.message), "error");
                },
              })
            }
          >
            {t("variants.choose")}
          </Button>
        </div>
      )}
    </article>
  );
}
