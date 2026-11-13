/**
 * The command palette and keyboard shortcuts (UI-27), as a pure model: which key does what, when a
 * key must be left alone (while typing), and what the palette offers for a query.
 */
import type { MessageKey } from "../i18n/index.ts";
import { type ProjectViewName, projectViews } from "./route.ts";

/** What a project page does on request (its own state: the task form, the AI panel). */
export type ProjectCommand = "new-task" | "ai";
export const COMMAND_EVENT = "konsora:command";

export type Shortcut =
  | { kind: "palette" }
  | { kind: "help" }
  | { kind: "command"; command: ProjectCommand }
  | { kind: "view"; view: ProjectViewName };

/** Every shortcut, for the help: the keys as shown and what they do. */
export const SHORTCUTS: readonly { keys: string; label: MessageKey }[] = [
  { keys: "Ctrl K", label: "keys.palette" },
  { keys: "?", label: "keys.help" },
  { keys: "N", label: "keys.newTask" },
  { keys: "I", label: "keys.ai" },
  { keys: "1 – 5", label: "keys.views" },
  { keys: "Esc", label: "keys.close" },
];

type KeyLike = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey"> & {
  target: EventTarget | null;
};

/** Whether the key goes to a field being typed in: then single-key shortcuts stay out of it. */
export function isTyping(target: EventTarget | null): boolean {
  const element = target as (HTMLElement & { isContentEditable?: boolean }) | null;
  const tag = element?.tagName?.toLowerCase();
  return (
    tag === "input" || tag === "textarea" || tag === "select" || Boolean(element?.isContentEditable)
  );
}

/**
 * The shortcut a key press means, or null. Ctrl+K (⌘K on a Mac) works everywhere; the single keys
 * only outside fields and without modifiers, so typing never triggers them.
 */
export function shortcutOf(event: KeyLike, inProject: boolean): Shortcut | null {
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "k")
    return { kind: "palette" };
  if (event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return null;
  if (event.key === "?") return { kind: "help" };
  if (!inProject) return null;
  const key = event.key.toLowerCase();
  if (key === "n") return { kind: "command", command: "new-task" };
  if (key === "i") return { kind: "command", command: "ai" };
  const index = Number(event.key) - 1;
  const view = Number.isInteger(index) ? projectViews[index] : undefined;
  return view ? { kind: "view", view } : null;
}

export type PaletteItem =
  | { kind: "task"; project: string; id: string; title: string }
  | { kind: "view"; project: string; view: ProjectViewName }
  | { kind: "project"; id: string; name: string }
  | { kind: "command"; command: ProjectCommand }
  | { kind: "questions" }
  | { kind: "help" };

export type PaletteContext = {
  /** The open project and its tasks, when on a project page. */
  project?: { id: string; tasks: readonly { id: string; title: string }[]; readOnly: boolean };
  projects: readonly { id: string; name: string }[];
  /** Spanish names, to match the query against what the human reads. */
  label: (item: PaletteItem) => string;
};

/** Lower case without accents, so «diseno» finds «Diseño». */
const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

const matches = (text: string, words: readonly string[]) => {
  const haystack = fold(text);
  return words.every((word) => haystack.includes(word));
};

/**
 * What the palette offers for `query`: tasks of the open project (an id match first), then views,
 * actions and projects. Empty query: the actions and views, no tasks. At most `limit` items.
 */
export function paletteItems(query: string, ctx: PaletteContext, limit = 12): PaletteItem[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const project = ctx.project;
  const others: PaletteItem[] = [
    ...(project
      ? [
          ...(project.readOnly ? [] : [{ kind: "command", command: "new-task" } as const]),
          { kind: "command", command: "ai" } as const,
          ...projectViews.map((view) => ({ kind: "view", project: project.id, view }) as const),
        ]
      : []),
    { kind: "questions" },
    ...ctx.projects
      .filter((p) => p.id !== project?.id)
      .map((p) => ({ kind: "project", id: p.id, name: p.name }) as const),
    { kind: "help" },
  ];
  if (words.length === 0) return others.slice(0, limit);
  const tasks = (project?.tasks ?? [])
    .filter((task) => matches(`${task.id} ${task.title}`, words))
    .map((task) => ({ kind: "task", project: project?.id ?? "", ...task }) as const)
    .sort((a, b) => {
      const q = fold(query.trim());
      const rank = (id: string) => (fold(id) === q ? 0 : fold(id).startsWith(q) ? 1 : 2);
      return rank(a.id) - rank(b.id);
    });
  return [...tasks, ...others.filter((item) => matches(ctx.label(item), words))].slice(0, limit);
}
