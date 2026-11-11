import { useId } from "react";
import { t } from "../i18n/index.ts";
import { Button } from "../ui/index.ts";

/**
 * How many tasks are selected, which ones, and what can be done with all of them: promote the
 * ideas to todo, or delete them (core still refuses what the human may not do, task by task).
 */
export function SelectionBar({
  ids,
  promotable,
  deletable,
  readOnly,
  busy = false,
  onPromote,
  onDelete,
  onClear,
}: {
  ids: readonly string[];
  /** The selected ideas Promote would move to todo. */
  promotable: readonly string[];
  /** The selected tasks Delete would remove. */
  deletable: readonly string[];
  readOnly: boolean;
  busy?: boolean;
  onPromote: (ids: readonly string[]) => void;
  onDelete: (ids: readonly string[]) => void;
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
            ? t("selection.readonly")
            : promotable.length === 0
              ? t("selection.promote.none")
              : t("selection.promote.ready", { n: promotable.length, ids: promotable.join(", ") })}
        </p>
        <Button
          variant="danger"
          disabled={readOnly || deletable.length === 0}
          busy={busy}
          onClick={() => onDelete(deletable)}
        >
          {t("app.selection.delete")}
        </Button>
        <Button
          variant="primary"
          className="a-selection__run"
          disabled={readOnly || promotable.length === 0}
          busy={busy}
          aria-describedby={hint}
          onClick={() => onPromote(promotable)}
        >
          {t("app.selection.promote")}
        </Button>
      </div>
    </section>
  );
}
