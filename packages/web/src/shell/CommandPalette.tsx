import { useQueryClient } from "@tanstack/react-query";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { type Board, boardKey } from "../api/board.ts";
import { useProjects } from "../api/projects.ts";
import { type MessageKey, t } from "../i18n/index.ts";
import { Button } from "../ui/index.ts";
import {
  COMMAND_EVENT,
  type PaletteItem,
  type ProjectCommand,
  paletteItems,
  SHORTCUTS,
  shortcutOf,
} from "./commands-model.ts";
import { navigate, projectHref, QUESTIONS_HREF, type Route } from "./route.ts";

const VIEW_LABEL: Record<string, MessageKey> = {
  board: "app.view.board",
  graph: "app.view.graph",
  history: "app.view.history",
  activity: "app.view.activity",
  settings: "app.view.settings",
};
const COMMAND_LABEL: Record<ProjectCommand, MessageKey> = {
  "new-task": "palette.newTask",
  ai: "palette.ai",
};

/** What a palette item reads like, in Spanish. */
export function paletteLabel(item: PaletteItem): string {
  switch (item.kind) {
    case "task":
      return `${item.id} · ${item.title}`;
    case "view":
      return t("palette.view", { view: t(VIEW_LABEL[item.view] ?? "app.view.board") });
    case "project":
      return t("palette.project", { name: item.name });
    case "command":
      return t(COMMAND_LABEL[item.command]);
    case "questions":
      return t("palette.questions");
    case "help":
      return t("palette.help");
  }
}

/** Asks the open project page to do something of its own (open the task form, the AI panel). */
export function sendCommand(command: ProjectCommand) {
  window.dispatchEvent(new CustomEvent(COMMAND_EVENT, { detail: command }));
}

/** A modal dialog that opens with showModal(), so focus stays in it and Escape closes it. */
function Modal({
  label,
  onClose,
  className,
  children,
}: {
  label: string;
  onClose: () => void;
  className: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`b-dialog ${className}`}
      aria-label={label}
      onKeyDown={(event) => {
        // Escape belongs to this dialog: it must not also close the task panel behind it.
        if (event.key === "Escape") event.stopPropagation();
      }}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // A click on the backdrop (the dialog itself, outside its content) closes it.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {children}
    </dialog>
  );
}

function Palette({ route, onClose }: { route: Route; onClose: () => void }) {
  const client = useQueryClient();
  const projects = useProjects();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const board =
    route.name === "project" ? client.getQueryData<Board>(boardKey(route.id)) : undefined;
  const items = paletteItems(query, {
    ...(route.name === "project" && board?.status === "ok"
      ? { project: { id: route.id, tasks: board.tasks, readOnly: false } }
      : route.name === "project"
        ? { project: { id: route.id, tasks: [], readOnly: true } }
        : {}),
    projects: (projects.data ?? []).map((p) => ({ id: p.id, name: p.name })),
    label: paletteLabel,
  });
  const current = Math.min(active, Math.max(0, items.length - 1));
  const run = (item: PaletteItem | undefined) => {
    if (!item) return;
    onClose();
    const view = route.name === "project" ? route.view : undefined;
    switch (item.kind) {
      case "task":
        navigate(projectHref(item.project, { ...(view ? { view } : {}), task: item.id }));
        break;
      case "view":
        navigate(projectHref(item.project, { view: item.view }));
        break;
      case "project":
        navigate(projectHref(item.id));
        break;
      case "questions":
        navigate(QUESTIONS_HREF);
        break;
      case "command":
        sendCommand(item.command);
        break;
      case "help":
        window.dispatchEvent(new CustomEvent("konsora:help"));
        break;
    }
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((current + 1) % Math.max(1, items.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current - 1 + items.length) % Math.max(1, items.length));
    } else if (event.key === "Enter") {
      event.preventDefault();
      run(items[current]);
    }
  };
  const optionId = (index: number) => `${listId}-${index}`;
  return (
    <Modal label={t("palette.label")} className="b-palette" onClose={onClose}>
      <input
        className="k-field__control b-palette__input"
        // biome-ignore lint/a11y/noAutofocus: the palette exists to be typed into.
        autoFocus
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={items.length ? optionId(current) : undefined}
        aria-label={t("palette.label")}
        placeholder={t(
          route.name === "project" ? "palette.placeholder" : "palette.placeholder.global",
        )}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={onKey}
      />
      <div id={listId} role="listbox" className="b-palette__list" aria-label={t("palette.results")}>
        {items.length === 0 && <p className="b-palette__empty">{t("palette.none")}</p>}
        {items.map((item, index) => (
          // biome-ignore lint/a11y/useKeyWithClickEvents: the input drives the keyboard (aria-activedescendant).
          <div
            key={`${item.kind}:${paletteLabel(item)}`}
            id={optionId(index)}
            role="option"
            tabIndex={-1}
            aria-selected={index === current}
            className={
              index === current ? "b-palette__item b-palette__item--active" : "b-palette__item"
            }
            onMouseEnter={() => setActive(index)}
            onClick={() => run(item)}
          >
            <span className="b-palette__kind k-label">{t(`palette.kind.${item.kind}`)}</span>
            {paletteLabel(item)}
          </div>
        ))}
      </div>
    </Modal>
  );
}

/** The list of shortcuts (`?`). */
function Help({ onClose }: { onClose: () => void }) {
  return (
    <Modal label={t("keys.title")} className="b-keys" onClose={onClose}>
      <h2 className="k-panel__title">{t("keys.title")}</h2>
      <p className="s-text s-muted">{t("keys.text")}</p>
      <dl className="b-keys__list">
        {SHORTCUTS.map((shortcut) => (
          <div key={shortcut.keys}>
            <dt>
              <kbd>{shortcut.keys}</kbd>
            </dt>
            <dd>{t(shortcut.label)}</dd>
          </div>
        ))}
      </dl>
      <div className="b-dialog__actions">
        <Button onClick={onClose}>{t("keys.close.button")}</Button>
      </div>
    </Modal>
  );
}

/**
 * The command palette (Ctrl+K) and the keyboard shortcuts of the whole app (UI-27). Single-key
 * shortcuts never fire while typing in a field; `?` lists them.
 */
export function CommandPalette({ route }: { route: Route }) {
  const [open, setOpen] = useState<"palette" | "help" | null>(null);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const shortcut = shortcutOf(event, route.name === "project");
      if (!shortcut) return;
      // While a dialog is open, only Ctrl+K (to toggle the palette) gets through.
      if (document.querySelector("dialog[open]") && shortcut.kind !== "palette") return;
      event.preventDefault();
      if (shortcut.kind === "palette") setOpen((now) => (now === "palette" ? null : "palette"));
      else if (shortcut.kind === "help") setOpen("help");
      else if (shortcut.kind === "command") sendCommand(shortcut.command);
      else if (route.name === "project")
        navigate(
          projectHref(route.id, {
            view: shortcut.view,
            task: route.task,
            ...(route.filter ? { filter: route.filter } : {}),
          }),
        );
    };
    const onHelp = () => setOpen("help");
    window.addEventListener("keydown", onKey);
    window.addEventListener("konsora:help", onHelp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("konsora:help", onHelp);
    };
  }, [route]);
  if (open === "palette") return <Palette route={route} onClose={() => setOpen(null)} />;
  if (open === "help") return <Help onClose={() => setOpen(null)} />;
  return null;
}
