import type { Task } from "@konsora/core";
import { describe, expect, it } from "vitest";
import { canRefine, refineMessage } from "../src/shell/refine.ts";

const at = "2026-11-13T10:00:00Z";
const task: Task = {
  id: "UI-31",
  title: "Prueba de humo",
  state: "proposed",
  group: "UI",
  rank: "a",
  desc: "Abrir la UI en un navegador.",
  acceptance: [{ id: "ac1", text: "Se abre sin errores" }],
  deps: ["CLI-11"],
  created: { at, by: "human" },
  updated_at: at,
};

describe("refine with the AI panel (UI-20)", () => {
  it("only for ideas and tasks nobody started, never in read-only (ac3)", () => {
    expect(canRefine({ state: "proposed" }, false)).toBe(true);
    expect(canRefine({ state: "todo" }, false)).toBe(true);
    expect(canRefine({ state: "doing" }, false)).toBe(false);
    expect(canRefine({ state: "done" }, false)).toBe(false);
    expect(canRefine({ state: "todo" }, true)).toBe(false);
  });

  it("the first message carries the task's id and content (ac1)", () => {
    const text = refineMessage(task, "Interfaz web");
    expect(text).toContain("UI-31 («Prueba de humo»)");
    expect(text).toContain("Interfaz web");
    expect(text).toContain("Abrir la UI en un navegador.");
    expect(text).toContain("- ac1: Se abre sin errores");
    expect(text).toContain("CLI-11");
    expect(text).toContain("modo plan");
  });
});
