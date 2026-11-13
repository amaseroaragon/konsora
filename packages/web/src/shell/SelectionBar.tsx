import { useId, useState } from "react";
import { t } from "../i18n/index.ts";
import { Button, Field } from "../ui/index.ts";
import { type BulkChange, labelProblem, normalizeLabel } from "./bulk-model.ts";

/**
 * How many tasks are selected, which ones, and what can be done with all of them: promote the
 * ideas to todo, delete them, move them to a group or add or remove a label (core still refuses
 * what the human may not do, task by task).
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
  groups,
  labels,
  onBulk,
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
  /** The plan's groups, to move the selection to one. */
  groups: readonly { id: string; name: string }[];
  /** Labels the plan uses, suggested while typing. */
  labels: readonly string[];
  onBulk: (change: BulkChange) => void;
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
      {!readOnly && <BulkControls groups={groups} labels={labels} busy={busy} onBulk={onBulk} />}
    </section>
  );
}

/** Move the selection to a group, or add or remove one label on all of it (UI-26). */
function BulkControls({
  groups,
  labels,
  busy,
  onBulk,
}: {
  groups: readonly { id: string; name: string }[];
  labels: readonly string[];
  busy: boolean;
  onBulk: (change: BulkChange) => void;
}) {
  const groupId = useId();
  const listId = useId();
  const [group, setGroup] = useState(groups[0]?.id ?? "");
  const [label, setLabel] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const runLabel = (kind: "label-add" | "label-remove") => {
    const value = normalizeLabel(label);
    const why = labelProblem(value);
    if (why) {
      setProblem(why);
      return;
    }
    onBulk({ kind, label: value });
    setLabel("");
  };
  return (
    <div className="b-selection__bulk">
      <div className="b-selection__group">
        <div className="k-field">
          <label htmlFor={groupId} className="k-field__label">
            {t("bulk.group")}
          </label>
          <select
            id={groupId}
            className="k-field__control"
            value={group}
            onChange={(e) => setGroup(e.target.value)}
          >
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.id} · {g.name}
              </option>
            ))}
          </select>
        </div>
        <Button
          size="sm"
          variant="secondary"
          busy={busy}
          disabled={!group}
          onClick={() => onBulk({ kind: "group", group })}
        >
          {t("bulk.group.run")}
        </Button>
      </div>
      <div className="b-selection__label">
        <Field
          mono
          label={t("bulk.label")}
          list={listId}
          value={label}
          error={problem ?? undefined}
          onChange={(e) => {
            setLabel(e.target.value);
            setProblem(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              runLabel("label-add");
            }
          }}
        />
        <datalist id={listId}>
          {labels.map((l) => (
            <option key={l} value={l} />
          ))}
        </datalist>
        <Button size="sm" variant="secondary" busy={busy} onClick={() => runLabel("label-add")}>
          {t("bulk.label.add")}
        </Button>
        <Button size="sm" variant="ghost" busy={busy} onClick={() => runLabel("label-remove")}>
          {t("bulk.label.remove")}
        </Button>
      </div>
    </div>
  );
}
