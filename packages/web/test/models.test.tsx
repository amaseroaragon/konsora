import { deriveFlags, type Task, type TasksDocument, taskHash } from "@konsora/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BoardTask } from "../src/api/board.ts";
import { createApi } from "../src/api/client.ts";
import { ApiContext } from "../src/api/projects.ts";
import { draftFromModels, ModelSettings, modelsFromDraft } from "../src/shell/ModelSettings.tsx";
import { TaskPanel } from "../src/shell/TaskPanel.tsx";
import { ToastProvider } from "../src/ui/index.ts";

const at = "2026-11-02T10:00:00Z";
const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  title: `Tarea ${id}`,
  state: "todo",
  group: "BE",
  rank: id.slice(-1),
  created: { at, by: "human" },
  updated_at: at,
  ...extra,
});
const doc: TasksDocument = {
  schema: "konsora/5",
  project: { name: "P", models: { high: "Opus, esfuerzo alto", low: "Haiku" } },
  groups: [{ id: "BE", name: "Backend" }],
  seq: { BE: 3 },
  tasks: [
    task("BE-01", { difficulty: "high" }),
    task("BE-02", { difficulty: "medium" }),
    task("BE-03"),
  ],
};
const flags = deriveFlags(doc);
const wrap = (node: ReactNode) =>
  renderToStaticMarkup(
    <ApiContext.Provider value={createApi("ab".repeat(32))}>
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>{node}</ToastProvider>
      </QueryClientProvider>
    </ApiContext.Provider>,
  );
const panel = (id: string) => {
  const t = doc.tasks.find((x) => x.id === id) as Task;
  return wrap(
    <TaskPanel
      projectId="p"
      task={{ ...t, ...(flags.get(id) as object), hash: taskHash(t) } as BoardTask}
      doc={doc}
      groupName="Backend"
      external={[]}
      readOnly={false}
      onClose={() => {}}
      onOpen={() => {}}
    />,
  );
};

describe("recommended model per difficulty (CORE-23)", () => {
  it("the task panel shows it next to the difficulty", () => {
    const html = panel("BE-01");
    expect(html).toContain("Modelo recomendado: Opus, esfuerzo alto");
    expect(html.indexOf("Modelo recomendado")).toBeGreaterThan(html.indexOf("k-difficulty"));
  });

  it("shows nothing without a model for that level or without a difficulty", () => {
    expect(panel("BE-02")).not.toContain("Modelo recomendado");
    expect(panel("BE-03")).not.toContain("Modelo recomendado");
  });

  it("Ajustes has a field per level with the saved values", () => {
    const html = wrap(<ModelSettings projectId="p" models={doc.project.models} readOnly={false} />);
    expect(html).toContain("Modelo recomendado por dificultad");
    expect(html).toContain('value="Haiku"');
    expect(html).toContain('value="Opus, esfuerzo alto"');
    expect(html.match(/<input/g)).toHaveLength(3);
    expect(html).toContain("Dificultad media");
  });

  it("builds set-models from the form: define, change and remove a level", () => {
    const saved = draftFromModels(doc.project.models);
    expect(saved).toEqual({ low: "Haiku", medium: "", high: "Opus, esfuerzo alto" });
    expect(modelsFromDraft({ ...saved, medium: " Sonnet " })).toEqual({
      low: "Haiku",
      medium: "Sonnet",
      high: "Opus, esfuerzo alto",
    });
    expect(modelsFromDraft({ ...saved, low: "" })).toEqual({ high: "Opus, esfuerzo alto" });
    expect(modelsFromDraft({ low: "", medium: "", high: "" })).toEqual({});
  });
});
