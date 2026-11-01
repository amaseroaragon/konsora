import { useId } from "react";
import { t } from "../i18n/index.ts";
import { Button } from "../ui/index.ts";

/**
 * How many tasks are selected, which ones, and Run: it launches the selected tasks that are ready
 * (each in its own run). Tasks that are not ready are left out, and the hint says which run.
 */
export function SelectionBar({
  ids,
  runnable,
  readOnly,
  busy = false,
  onRun,
  onClear,
}: {
  ids: readonly string[];
  /** The selected tasks Run would launch. */
  runnable: readonly string[];
  readOnly: boolean;
  busy?: boolean;
  onRun: (ids: readonly string[]) => void;
  onClear: () => void;
}) {
  const hint = useId();
  const disabled = readOnly || runnable.length === 0;
  return (
    <section className="a-selection b-selection" aria-label={t("app.selection")}>
      <div className="a-selection__count">
        <span className="a-selection__badge">{ids.length}</span>
        <span role="status">
          {t(ids.length === 1 ? "selection.one" : "selection.many", { n: ids.length })}{" "}
          <span className="k-mono a-selection__ids">{ids.join(", ")}</span>
        </span>
        <Button size="sm" variant="ghost" onClick={onClear}>
          {t("app.selection.clear")}
        </Button>
      </div>
      <div className="a-selection__controls">
        <p id={hint} className="b-selection__hint s-muted">
          {readOnly
            ? t("selection.run.readonly")
            : runnable.length === 0
              ? t("selection.run.none")
              : t("selection.run.ready", { n: runnable.length, ids: runnable.join(", ") })}
        </p>
        <Button
          variant="primary"
          className="a-selection__run"
          disabled={disabled}
          busy={busy}
          aria-describedby={hint}
          onClick={() => onRun(runnable)}
        >
          {t("app.selection.run")} →
        </Button>
      </div>
    </section>
  );
}
