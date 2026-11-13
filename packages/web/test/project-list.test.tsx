import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createApi } from "../src/api/client.ts";
import { ApiContext, type ProjectSummary, projectsKey } from "../src/api/projects.ts";
import { ProjectsPage } from "../src/shell/ProjectsPage.tsx";
import { ToastProvider } from "../src/ui/index.ts";

const at = "2026-11-02T10:00:00Z";
const ok = (extra: Partial<Extract<ProjectSummary["plan"], { status: "ok" }>> = {}) => ({
  status: "ok" as const,
  hash: "sha256:x",
  tasks: 7,
  byState: { proposed: 1, todo: 3, doing: 2, done: 1 },
  ready: 2,
  waiting: 0,
  ...extra,
});
const projects: ProjectSummary[] = [
  { id: "p-1", name: "Tiempo", path: "/a", added_at: at, plan: ok({ waiting: 1, lastDone: at }) },
  {
    id: "p-2",
    name: "Facturas",
    path: "/b",
    added_at: at,
    plan: ok({ byState: { proposed: 0, todo: 1, doing: 0, done: 0 }, tasks: 1, ready: 1 }),
  },
  { id: "p-3", name: "Roto", path: "/c", added_at: at, plan: { status: "invalid", message: "x" } },
  { id: "p-4", name: "Vacío", path: "/d", added_at: at, plan: { status: "missing", message: "x" } },
];

const page = () => {
  const client = new QueryClient();
  client.setQueryData(projectsKey, projects);
  return renderToStaticMarkup(
    <ApiContext.Provider value={createApi("ab".repeat(32))}>
      <QueryClientProvider client={client}>
        <ToastProvider>
          <ProjectsPage />
        </ToastProvider>
      </QueryClientProvider>
    </ApiContext.Provider>,
  );
};
const rows = (html: string) => html.split('<li class="s-project').slice(1);

describe("project list summary (UI-14)", () => {
  it("each row shows the counts, the ready tasks, the questions and the last closure", () => {
    const [tiempo, facturas] = rows(page());
    const when = new Date(at).toLocaleString("es", { dateStyle: "short", timeStyle: "short" });
    expect(tiempo).toContain("7 tareas");
    expect(tiempo).toContain("2 en curso");
    expect(tiempo).toContain("2 listas");
    expect(tiempo).toContain("1 pregunta pendiente");
    expect(tiempo).toContain(`Último cierre: ${when}`);
    expect(facturas).toContain("1 tarea");
    expect(facturas).toContain("1 lista");
    expect(facturas).not.toContain("en curso");
    expect(facturas).toContain("Nada cerrado aún");
  });

  it("highlights only the projects with pending questions", () => {
    const html = rows(page());
    expect(html.map((row) => row.startsWith(" s-project--waiting"))).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect(html[1]).not.toContain("k-badge--waiting");
  });

  it("an invalid or missing plan keeps its notice", () => {
    const [, , roto, vacio] = rows(page());
    expect(roto).toContain("s-project__plan--invalid");
    expect(roto).toContain("Plan inválido (solo lectura)");
    expect(roto).not.toContain("s-project__stats");
    expect(vacio).toContain("s-project__plan--missing");
    expect(vacio).toContain("konsora init");
  });
});
