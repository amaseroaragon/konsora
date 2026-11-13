import { deriveFlags, type Task, type TasksDocument, taskHash } from "@konsora/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { actionBody, type BoardTask } from "../src/api/board.ts";
import { createApi } from "../src/api/client.ts";
import { ApiContext } from "../src/api/projects.ts";
import { type PendingQuestions, questionsKey } from "../src/api/questions.ts";
import { QuestionsLink, QuestionsPage } from "../src/shell/QuestionsPage.tsx";
import { parseRoute, QUESTIONS_HREF } from "../src/shell/route.ts";
import { ToastProvider } from "../src/ui/index.ts";

const at = "2026-11-02T10:00:00Z";
const question = (id: string, text: string, options?: string[]) => ({
  id,
  at,
  by: "agent:claude",
  kind: "question" as const,
  text,
  ...(options ? { options } : {}),
});
const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  title: `Tarea ${id}`,
  state: "doing",
  group: "BE",
  rank: id.slice(-1),
  created: { at, by: "agent:claude" },
  updated_at: at,
  ...extra,
});
function views(tasks: Task[]): BoardTask[] {
  const plan: TasksDocument = {
    schema: "konsora/5",
    project: { name: "P" },
    groups: [{ id: "BE", name: "Backend" }],
    seq: { BE: 9 },
    tasks,
  };
  const flags = deriveFlags(plan);
  return tasks.map(
    (t) => ({ ...t, ...(flags.get(t.id) as object), hash: taskHash(t) }) as BoardTask,
  );
}
const [a1, a2] = views([
  task("BE-01", { notes: [question("n1", "¿Caché en disco o en memoria?", ["Disco", "Memoria"])] }),
  task("BE-02", { notes: [question("n1", "¿Qué TTL?")] }),
]) as [BoardTask, BoardTask];
const [b1] = views([task("BE-05", { notes: [question("n3", "¿Borro el endpoint viejo?")] })]) as [
  BoardTask,
];
const pending: PendingQuestions = {
  total: 3,
  projects: [
    {
      project: { id: "p-aaaaaaaaaaaa", name: "Tiempo" },
      questions: [
        { task: a1, question: a1.notes?.[0] as NonNullable<Task["notes"]>[number] },
        { task: a2, question: a2.notes?.[0] as NonNullable<Task["notes"]>[number] },
      ],
    },
    {
      project: { id: "p-bbbbbbbbbbbb", name: "Facturas" },
      questions: [{ task: b1, question: b1.notes?.[0] as NonNullable<Task["notes"]>[number] }],
    },
  ],
};

const render = (node: React.ReactNode, data?: PendingQuestions) => {
  const client = new QueryClient();
  if (data) client.setQueryData(questionsKey, data);
  return renderToStaticMarkup(
    <ApiContext.Provider value={createApi("ab".repeat(32))}>
      <QueryClientProvider client={client}>
        <ToastProvider>{node}</ToastProvider>
      </QueryClientProvider>
    </ApiContext.Provider>,
  );
};

describe("pending questions of every project (UI-13)", () => {
  it("has its own route", () => {
    expect(parseRoute(QUESTIONS_HREF)).toEqual({ name: "questions" });
    expect(parseRoute("#/questions?x=1")).toEqual({ name: "questions" });
  });

  it("lists them by project, each with its answer form and a link to the task", () => {
    const html = render(<QuestionsPage />, pending);
    const projects = [...html.matchAll(/class="s-questions__name"[^>]*><a[^>]*>([^<]+)</g)].map(
      (m) => m[1],
    );
    expect(projects).toEqual(["Tiempo", "Facturas"]);
    expect(html).toContain("¿Caché en disco o en memoria?");
    expect(html).toContain("¿Qué TTL?");
    expect(html).toContain("¿Borro el endpoint viejo?");
    // The options are answered with one click; every question has its own form.
    expect(html).toMatch(/<button[^>]*>Disco<\/button>/);
    expect(html.match(/<form/g)).toHaveLength(3);
    expect(html).toContain('href="#/p/p-bbbbbbbbbbbb?task=BE-05"');
  });

  it("an answer is the same op as from the task panel", () => {
    expect(actionBody({ task: a2, action: "answer", text: " 10 min " })).toEqual({
      op: "answer",
      task: "BE-02",
      text: "10 min",
      expect: { "BE-02": a2.hash },
    });
  });

  it("says so when nothing is pending", () => {
    const html = render(<QuestionsPage />, { projects: [], total: 0 });
    expect(html).toContain("No hay preguntas pendientes.");
    expect(html).not.toContain("<form");
  });

  it("the navigation counts them, and shows no count without any", () => {
    const html = render(<QuestionsLink current={false} />, pending);
    expect(html).toContain('href="#/questions"');
    expect(html).toContain('aria-label="Preguntas pendientes: 3"');
    expect(html).toContain('<span class="s-nav__count">3</span>');
    const none = render(<QuestionsLink current />, { projects: [], total: 0 });
    expect(none).not.toContain("s-nav__count");
    expect(none).toContain('aria-current="page"');
  });
});
