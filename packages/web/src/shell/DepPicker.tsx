import type { TasksDocument } from "@konsora/core";
import { type KeyboardEvent, useId, useMemo, useState } from "react";
import { t } from "../i18n/index.ts";
import { cx } from "../ui/cx.ts";
import { Button, Field, StateBadge } from "../ui/index.ts";
import { dependencyOptions } from "./edit-model.ts";

/**
 * Picks a dependency by id or title (UI-25): a combobox that suggests the valid tasks while typing
 * (ArrowDown/ArrowUp move, Enter picks, Escape closes) and still takes an id typed or pasted as is.
 * `onPick` gets the chosen id, or the typed text when no suggestion is active; it returns whether
 * the text was taken, and then the input clears.
 */
export function DepPicker({
  doc,
  task,
  chosen,
  label,
  hint,
  error,
  busy = false,
  onPick,
  onType,
}: {
  doc: Pick<TasksDocument, "tasks">;
  /** The task that will depend on the pick, or null while creating it. */
  task: string | null;
  /** Already dependencies: not offered again. */
  chosen: readonly string[];
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  busy?: boolean;
  onPick: (text: string) => boolean;
  /** Called on every keystroke, to clear a previous error. */
  onType?: () => void;
}) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const listId = useId();
  const options = useMemo(
    () => dependencyOptions(doc, task, chosen, text),
    [doc, task, chosen, text],
  );
  const expanded = open && options.length > 0;
  const optionId = (index: number) => `${listId}-${index}`;
  const pick = (value: string) => {
    if (!value.trim()) return;
    if (onPick(value)) {
      setText("");
      setActive(-1);
      setOpen(false);
    }
  };
  /** Typed text without an active suggestion: an id or a list of ids as is, else the best match. */
  const resolve = (value: string) => {
    const typed = value.trim().toUpperCase();
    if (typed.includes(",") || doc.tasks.some((x) => x.id === typed)) return value;
    return options[0]?.id ?? value;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!expanded) {
        setOpen(true);
        setActive(event.key === "ArrowDown" ? 0 : options.length - 1);
        return;
      }
      const step = event.key === "ArrowDown" ? 1 : -1;
      const n = options.length;
      setActive((i) => (i < 0 ? (step > 0 ? 0 : n - 1) : (i + step + n) % n));
    } else if (event.key === "Enter") {
      // Never submits the surrounding form: Enter picks the suggestion, or the typed id.
      event.preventDefault();
      const option = expanded ? options[active] : undefined;
      pick(option ? option.id : resolve(text));
    } else if (event.key === "Escape" && expanded) {
      // Closes the list only, not the panel around it.
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      setActive(-1);
    }
  };
  return (
    <div className="b-pick">
      <div className="b-pick__row">
        <Field
          mono
          label={label}
          hint={hint}
          placeholder={t("deps.pick.placeholder")}
          value={text}
          error={error}
          role="combobox"
          autoComplete="off"
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-activedescendant={expanded && active >= 0 ? optionId(active) : undefined}
          onChange={(e) => {
            setText(e.target.value);
            setActive(-1);
            setOpen(true);
            onType?.();
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
        />
        <Button size="sm" variant="secondary" busy={busy} onClick={() => pick(resolve(text))}>
          {t("edit.deps.add")}
        </Button>
      </div>
      <div
        id={listId}
        role="listbox"
        aria-label={t("deps.pick.list")}
        className="b-pick__list"
        hidden={!expanded}
      >
        {options.map((option, index) => (
          <div
            key={option.id}
            id={optionId(index)}
            role="option"
            // The focus stays in the combobox (aria-activedescendant); options are not tab stops.
            tabIndex={-1}
            aria-selected={index === active}
            className={cx("b-pick__option", index === active && "b-pick__option--active")}
            // Keep the focus in the input; pick on press.
            onMouseDown={(event) => {
              event.preventDefault();
              pick(option.id);
            }}
          >
            <span className="k-mono b-pick__id">{option.id}</span>
            <span className="b-pick__title">{option.title}</span>
            <StateBadge kind={option.state} />
          </div>
        ))}
      </div>
    </div>
  );
}
