import { useId } from "react";
import { t } from "../i18n/index.ts";
import { Button, Menu, type MenuOption } from "../ui/index.ts";

/** The menu value that takes the selected tasks out of any block. */
export const NO_BLOCK = "\u0000none";

/**
 * How many tasks are selected, which ones, and what can be done with all of them: move them to
 * a block, promote the ideas to todo, or delete them (core still refuses what the human may not
 * do, task by task).
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
  blockTargets = [],
  onMove,
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
  /** Where the movable selected tasks can go: open blocks, and NO_BLOCK. Empty hides the menu. */
  blockTargets?: readonly MenuOption[];
  onMove?: (target: string) => void;
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
        {!readOnly && blockTargets.length > 0 && onMove && (
          <Menu
            caption={t("selection.block")}
            value=""
            options={[{ value: "", label: t("selection.block.pick") }, ...blockTargets]}
            onChange={(value) => {
              if (value) onMove(value);
            }}
          />
        )}
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
