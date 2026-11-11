import { useId } from "react";
import { t } from "../i18n/index.ts";
import { Button } from "../ui/index.ts";

/**
 * How many tasks are selected, which ones, and Approve: it approves the selected proposals, one
 * op each. Tasks that are not proposals are left out, and the hint says which are approved.
 */
export function SelectionBar({
  ids,
  approvable,
  readOnly,
  busy = false,
  onApprove,
  onClear,
}: {
  ids: readonly string[];
  /** The selected tasks Approve would approve (proposals). */
  approvable: readonly string[];
  readOnly: boolean;
  busy?: boolean;
  onApprove: (ids: readonly string[]) => void;
  onClear: () => void;
}) {
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
          {readOnly
            ? t("selection.approve.readonly")
            : approvable.length === 0
              ? t("selection.approve.none")
              : t("selection.approve.ready", { n: approvable.length, ids: approvable.join(", ") })}
        </p>
        <Button
          variant="primary"
          className="a-selection__run"
          disabled={readOnly || approvable.length === 0}
          busy={busy}
          aria-describedby={hint}
          onClick={() => onApprove(approvable)}
        >
          {t("app.selection.approve")}
        </Button>
      </div>
    </section>
  );
}
