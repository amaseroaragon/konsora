import { useId } from "react";
import { t } from "../i18n/index.ts";
import { Button } from "../ui/index.ts";

/**
 * How many tasks are selected, which ones, and a way to clear them. Run stays disabled until
 * Konsora can launch agents (M6).
 */
export function SelectionBar({ ids, onClear }: { ids: readonly string[]; onClear: () => void }) {
  const hint = useId();
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
          {t("selection.run.later")}
        </p>
        <Button variant="primary" className="a-selection__run" disabled aria-describedby={hint}>
          {t("app.selection.run")} →
        </Button>
      </div>
    </section>
  );
}
