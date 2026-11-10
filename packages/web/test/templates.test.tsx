import { applyOp, type Op, OpSchema, type TasksDocument, type Template } from "@konsora/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createApi } from "../src/api/client.ts";
import { ApiContext } from "../src/api/projects.ts";
import { TemplateSettings } from "../src/shell/TemplateSettings.tsx";
import {
  type DraftTemplate,
  moveRow,
  parseLabels,
  templatesFrom,
  templatesOp,
  templatesServerErrors,
} from "../src/shell/templates-model.ts";
import { ToastProvider } from "../src/ui/index.ts";

const saved: Template[] = [
  {
    id: "bug",
    name: "Arreglo de bug",
    desc: "Reproduce y arregla.",
    acceptance: [
      { text: "Hay un test que lo reproduce", check: "npm test" },
      { text: "Sin regresiones" },
    ],
    labels: ["bug", "fix"],
    difficulty: "low",
  },
  { id: "doc", name: "Documentación" },
];

const blank = (key: string, extra: Partial<DraftTemplate> = {}): DraftTemplate => ({
  key,
  id: "",
  name: "",
  desc: "",
  criteria: [],
  labels: "",
  difficulty: "",
  ...extra,
});

const plan: TasksDocument = {
  schema: "konsora/2",
  project: { name: "Demo", base_branch: "main" },
  groups: [{ id: "BE", name: "Backend" }],
  seq: {},
  tasks: [],
};

/** Applies the op the form would send, as the daemon does (after validating it like the daemon). */
function apply(op: unknown, templates: Template[] | undefined = saved) {
  const parsed = OpSchema.parse(op) as Op;
  const doc = structuredClone(plan);
  if (templates) doc.project.templates = structuredClone(templates);
  else delete doc.project.templates;
  const result = applyOp(doc, parsed, { actor: "human", at: "2026-11-10T10:00:00Z" });
  if (!result.ok) throw new Error(result.error.message);
  return result.document.project.templates;
}

describe("templates form (UI-22 ac1)", () => {
  it("starts from the plan and sends nothing when nothing changed", () => {
    const draft = templatesFrom(saved);
    expect(draft[0]).toMatchObject({
      id: "bug",
      labels: "bug, fix",
      difficulty: "low",
      criteria: [
        { text: "Hay un test que lo reproduce", check: "npm test" },
        { text: "Sin regresiones", check: "" },
      ],
    });
    expect(templatesOp(draft, saved)).toEqual({ ok: true, op: null });
    expect(parseLabels(" a, b  c,,")).toEqual(["a", "b", "c"]);
  });

  it("creates a template and the op adds it to project.templates", () => {
    const draft = [
      ...templatesFrom(saved),
      blank("n1", {
        id: " feature ",
        name: " Nueva función ",
        desc: "Qué consigue.",
        criteria: [{ key: "c1", text: " Funciona ", check: " npm run check " }],
        labels: "fe, ui",
        difficulty: "medium",
      }),
    ];
    const result = templatesOp(draft, saved);
    expect(result.ok && result.op?.op).toBe("set-templates");
    const after = apply(result.ok ? result.op : null);
    expect(after?.map((t) => t.id)).toEqual(["bug", "doc", "feature"]);
    expect(after?.[2]).toEqual({
      id: "feature",
      name: "Nueva función",
      desc: "Qué consigue.",
      acceptance: [{ text: "Funciona", check: "npm run check" }],
      labels: ["fe", "ui"],
      difficulty: "medium",
    });
  });

  it("edits, reorders and removes templates and criteria", () => {
    const draft = templatesFrom(saved);
    const bug = draft[0] as DraftTemplate;
    draft[0] = {
      ...bug,
      name: "Bug",
      desc: "",
      difficulty: "",
      labels: "bug",
      criteria: bug.criteria.slice(1),
    };
    const reordered = moveRow(draft, 0, 1);
    const result = templatesOp(reordered, saved);
    expect(apply(result.ok ? result.op : null)).toEqual([
      { id: "doc", name: "Documentación" },
      { id: "bug", name: "Bug", acceptance: [{ text: "Sin regresiones" }], labels: ["bug"] },
    ]);

    // Removing them all clears project.templates.
    const none = templatesOp([], saved);
    expect(none).toEqual({ ok: true, op: { op: "set-templates", templates: [] } });
    expect(apply(none.ok ? none.op : null)).toBeUndefined();
  });

  it("posts the op to the project's ops", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const api = createApi("ab".repeat(32), { fetch });
    const result = templatesOp([blank("n", { id: "x", name: "X" })], undefined);
    await api.post("/projects/p/ops", result.ok ? result.op : null);
    expect(calls).toEqual([
      {
        url: "/api/projects/p/ops",
        body: { op: "set-templates", templates: [{ id: "x", name: "X" }] },
      },
    ]);
  });

  it("renders the saved templates with their fields, and nothing editable in read-only mode", () => {
    const render = (readOnly: boolean) =>
      renderToStaticMarkup(
        <ApiContext.Provider value={createApi("ab".repeat(32))}>
          <QueryClientProvider client={new QueryClient()}>
            <ToastProvider>
              <TemplateSettings projectId="p" templates={saved} readOnly={readOnly} />
            </ToastProvider>
          </QueryClientProvider>
        </ApiContext.Provider>,
      );
    const html = render(false);
    expect(html).toContain("Plantillas de tarea");
    expect(html).toContain('value="Arreglo de bug"');
    expect(html).toContain('value="bug, fix"');
    expect(html).toContain('value="npm test"');
    expect(html).toContain("Criterio 2 de la plantilla 1");
    expect(html).toContain(">Añadir plantilla<");
    expect(render(true)).toMatch(/<button type="submit" disabled=""[^>]*>Guardar plantillas</);
  });
});

describe("templates form errors (UI-22 ac2)", () => {
  it("explains each invalid field in Spanish, with the same rules as core", () => {
    const result = templatesOp(
      [
        blank("a", { id: "Bug Fix", name: "", labels: "ok, Malo" }),
        blank("b", {
          id: "doc",
          name: "x".repeat(61),
          criteria: [{ key: "c", text: " ", check: "y".repeat(1001) }],
        }),
        blank("c", { id: "doc", name: "Otra", labels: "a, a" }),
      ],
      saved,
    );
    expect(result.ok).toBe(false);
    expect(result.ok ? {} : result.errors).toEqual({
      "templates.0.id": "Usa minúsculas, números y guiones, empezando por una letra (máximo 31).",
      "templates.0.name": "Escribe un nombre de hasta 60 caracteres.",
      "templates.0.labels": "«Malo» no vale como etiqueta: usa minúsculas, números y guiones.",
      "templates.1.name": "Escribe un nombre de hasta 60 caracteres.",
      "templates.1.criteria.0.text": "Escribe el criterio, de hasta 500 caracteres.",
      "templates.1.criteria.0.check": "El check no puede pasar de 1000 caracteres.",
      "templates.2.id": "Ya hay otra plantilla con el id doc.",
      "templates.2.labels": "La etiqueta «a» está repetida.",
    });
  });

  it("places the daemon's refusals on their fields, in Spanish", () => {
    expect(
      templatesServerErrors({
        code: "invalid",
        message: "set-templates would make the plan invalid: Template bug is defined twice",
        issues: [
          { path: "/project/templates/1/id", code: "duplicate_template_id", message: "x" },
          { path: "/project/templates/0/acceptance/2/text", code: "too_big", message: "x" },
        ],
      }),
    ).toEqual({
      fields: {
        "templates.1.id": "Ya hay otra plantilla con este id.",
        "templates.0.criteria.2.text": "Escribe el criterio, de hasta 500 caracteres.",
      },
      form: null,
    });
    expect(
      templatesServerErrors({
        code: "bad_request",
        message: "Invalid op at templates.0.name: Too big",
      }).fields,
    ).toEqual({ "templates.0.name": "Escribe un nombre de hasta 60 caracteres." });
    expect(templatesServerErrors({ code: "forbidden", message: "x" }).form).toBe(
      "Solo tú, desde Konsora, puedes cambiar los ajustes.",
    );
  });
});
