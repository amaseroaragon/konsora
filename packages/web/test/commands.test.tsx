import { describe, expect, it } from "vitest";
import { paletteLabel } from "../src/shell/CommandPalette.tsx";
import {
  isTyping,
  type PaletteContext,
  paletteItems,
  shortcutOf,
} from "../src/shell/commands-model.ts";

const key = (
  k: string,
  extra: { ctrl?: boolean; meta?: boolean; alt?: boolean; tag?: string } = {},
) => ({
  key: k,
  ctrlKey: extra.ctrl ?? false,
  metaKey: extra.meta ?? false,
  altKey: extra.alt ?? false,
  target: (extra.tag
    ? { tagName: extra.tag.toUpperCase() }
    : { tagName: "BODY" }) as unknown as EventTarget,
});

const ctx = (readOnly = false): PaletteContext => ({
  project: {
    id: "p-1",
    readOnly,
    tasks: [
      { id: "UI-12", title: "Notas humanas" },
      { id: "UI-01", title: "Diseño del tablero" },
      { id: "CORE-01", title: "Esquema" },
    ],
  },
  projects: [
    { id: "p-1", name: "Konsora" },
    { id: "p-2", name: "Weather" },
  ],
  label: paletteLabel,
});

describe("shortcuts (UI-27)", () => {
  it("Ctrl+K and ⌘K open the palette, even inside a field", () => {
    expect(shortcutOf(key("k", { ctrl: true }), false)).toEqual({ kind: "palette" });
    expect(shortcutOf(key("K", { meta: true, tag: "input" }), true)).toEqual({ kind: "palette" });
  });

  it("single keys act only outside fields and without modifiers", () => {
    expect(shortcutOf(key("n"), true)).toEqual({ kind: "command", command: "new-task" });
    expect(shortcutOf(key("i"), true)).toEqual({ kind: "command", command: "ai" });
    expect(shortcutOf(key("2"), true)).toEqual({ kind: "view", view: "graph" });
    expect(shortcutOf(key("4"), true)).toEqual({ kind: "view", view: "activity" });
    expect(shortcutOf(key("?"), false)).toEqual({ kind: "help" });
    for (const tag of ["input", "textarea", "select"])
      expect(shortcutOf(key("n", { tag }), true)).toBeNull();
    expect(shortcutOf(key("n", { ctrl: true }), true)).toBeNull();
    expect(shortcutOf(key("9"), true)).toBeNull();
    // Project shortcuts need a project.
    expect(shortcutOf(key("n"), false)).toBeNull();
    expect(isTyping({ tagName: "DIV", isContentEditable: true } as unknown as EventTarget)).toBe(
      true,
    );
  });
});

describe("command palette (UI-27)", () => {
  it("finds tasks by id or title, an exact id first, and opens them", () => {
    const items = paletteItems("ui-1", ctx());
    expect(items[0]).toEqual({ kind: "task", project: "p-1", id: "UI-12", title: "Notas humanas" });
    expect(paletteItems("diseno", ctx())[0]).toMatchObject({ kind: "task", id: "UI-01" });
    expect(paletteItems("ui-01", ctx())[0]).toMatchObject({ id: "UI-01" });
  });

  it("offers views, other projects, a new task and the AI panel", () => {
    const empty = paletteItems("", ctx());
    expect(empty.map((i) => i.kind)).toContain("view");
    expect(empty).toContainEqual({ kind: "command", command: "new-task" });
    expect(empty).toContainEqual({ kind: "command", command: "ai" });
    expect(empty).toContainEqual({ kind: "project", id: "p-2", name: "Weather" });
    expect(empty.some((i) => i.kind === "task")).toBe(false);
    expect(paletteItems("grafo", ctx())).toEqual([{ kind: "view", project: "p-1", view: "graph" }]);
    expect(paletteItems("weather", ctx())).toEqual([
      { kind: "project", id: "p-2", name: "Weather" },
    ]);
    expect(paletteItems("panel de ia", ctx())).toEqual([{ kind: "command", command: "ai" }]);
    expect(paletteItems("atajos", ctx())).toEqual([{ kind: "help" }]);
  });

  it("does not offer creating a task on a read-only plan, nor project items outside one", () => {
    expect(paletteItems("", ctx(true))).not.toContainEqual({
      kind: "command",
      command: "new-task",
    });
    const global = paletteItems("", {
      projects: [{ id: "p-2", name: "Weather" }],
      label: paletteLabel,
    });
    expect(global.map((i) => i.kind)).toEqual(["questions", "project", "help"]);
  });
});
