import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createApi } from "../src/api/client.ts";
import { ApiContext } from "../src/api/projects.ts";
import { changesFrom, draftFrom } from "../src/shell/edit-model.ts";
import { ProjectSettings } from "../src/shell/ProjectSettings.tsx";
import { parseRoute } from "../src/shell/route.ts";
import {
  moveCheck,
  type SettingsDraft,
  serverErrors,
  settingsFrom,
  settingsOp,
} from "../src/shell/settings-model.ts";
import { ToastProvider } from "../src/ui/index.ts";

const project = {
  checks: [
    { id: "lint", run: "npm run lint" },
    { id: "test", run: "npm test", timeout_s: 300 },
  ],
  check_retries: 1,
  setup: { run: "npm ci" },
};

const draft = (extra: Partial<SettingsDraft> = {}): SettingsDraft => ({
  ...settingsFrom(project),
  ...extra,
});

describe("project settings form (UI-17 ac1)", () => {
  it("is a project view, one click from the board", () => {
    expect(parseRoute("#/p/p-1?view=settings")).toMatchObject({
      name: "project",
      view: "settings",
    });
  });

  it("starts from the plan and sends nothing when nothing changed", () => {
    expect(settingsFrom(project)).toEqual({
      checks: [
        { key: "saved-0", id: "lint", run: "npm run lint", timeout: "" },
        { key: "saved-1", id: "test", run: "npm test", timeout: "300" },
      ],
      retries: "1",
      setupRun: "npm ci",
      setupTimeout: "",
    });
    expect(settingsOp(draft(), project)).toEqual({ ok: true, op: null });
  });

  it("adds, edits, reorders and removes checks in one set-checks op with only what changed", () => {
    const edited = draft();
    edited.checks = moveCheck(edited.checks, 1, -1);
    edited.checks.push({ key: "n", id: "e2e", run: " npm run e2e ", timeout: "900" });
    expect(settingsOp(edited, project)).toEqual({
      ok: true,
      op: {
        op: "set-checks",
        checks: [
          { id: "test", run: "npm test", timeout_s: 300 },
          { id: "lint", run: "npm run lint" },
          { id: "e2e", run: "npm run e2e", timeout_s: 900 },
        ],
      },
    });
    const removed = draft({ checks: [] });
    expect(settingsOp(removed, project)).toEqual({
      ok: true,
      op: { op: "set-checks", checks: [] },
    });
    expect(moveCheck(edited.checks, 0, -1)).toEqual(edited.checks);
  });

  it("changes the retries and the setup, and empty means default or none", () => {
    expect(settingsOp(draft({ retries: "" }), project)).toEqual({
      ok: true,
      op: { op: "set-checks", check_retries: null },
    });
    expect(settingsOp(draft({ retries: "0" }), project)).toEqual({
      ok: true,
      op: { op: "set-checks", check_retries: 0 },
    });
    expect(settingsOp(draft({ setupRun: "", setupTimeout: "" }), project)).toEqual({
      ok: true,
      op: { op: "set-checks", setup: null },
    });
    expect(settingsOp(draft({ setupRun: "pnpm i", setupTimeout: "1200" }), project)).toEqual({
      ok: true,
      op: { op: "set-checks", setup: { run: "pnpm i", timeout_s: 1200 } },
    });
  });

  it("validates every field in the form before sending", () => {
    const bad = draft({
      checks: [
        { key: "a", id: "Lint", run: "x", timeout: "" },
        { key: "b", id: "test", run: "", timeout: "0" },
        { key: "c", id: "test", run: "y", timeout: "1.5" },
      ],
      retries: "6",
      setupRun: "",
      setupTimeout: "60",
    });
    const result = settingsOp(bad, project);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.errors).sort()).toEqual([
      "checks.0.id",
      "checks.1.run",
      "checks.1.timeout",
      "checks.2.id",
      "checks.2.timeout",
      "retries",
      "setup.run",
    ]);
    expect(result.errors["checks.2.id"]).toBe("Ya hay otro check con el id test.");
    expect(result.errors.retries).toBe("Un número entero entre 0 y 5.");
  });

  it("renders each field with its label and error, and the actions", () => {
    const client = new QueryClient();
    const html = renderToStaticMarkup(
      <ApiContext.Provider value={createApi("ab".repeat(32))}>
        <QueryClientProvider client={client}>
          <ToastProvider>
            <ProjectSettings projectId="p" project={project} readOnly={false} />
          </ToastProvider>
        </QueryClientProvider>
      </ApiContext.Provider>,
    );
    expect(html).toContain("Id del check 1");
    expect(html).toContain("Comando del check 2");
    expect(html).toContain('value="300"');
    expect(html).toContain("Subir el check 2");
    expect(html).toContain("Añadir check");
    expect(html).toContain("Reintentos");
    expect(html).toContain('value="npm ci"');
    expect(html).toContain("Guardar ajustes");
    const locked = renderToStaticMarkup(
      <ApiContext.Provider value={createApi("ab".repeat(32))}>
        <QueryClientProvider client={client}>
          <ToastProvider>
            <ProjectSettings projectId="p" project={project} readOnly />
          </ToastProvider>
        </QueryClientProvider>
      </ApiContext.Provider>,
    );
    expect(locked).toContain("los ajustes no se pueden cambiar");
  });
});

describe("the daemon's errors next to the field (UI-17 ac3)", () => {
  it("places issues and bad requests on their field, and the rest on the form", () => {
    expect(
      serverErrors({
        code: "invalid",
        message: "set-checks would make the plan invalid",
        issues: [{ path: "/project/checks/1/id", message: "Project check test is defined twice" }],
      }),
    ).toEqual({ fields: { "checks.1.id": "Project check test is defined twice" }, form: null });
    expect(
      serverErrors({
        code: "bad_request",
        message: "Invalid op at check_retries: Too big: expected number to be <=5",
      }),
    ).toEqual({ fields: { retries: "Too big: expected number to be <=5" }, form: null });
    expect(
      serverErrors({ code: "bad_request", message: "Invalid op at setup.timeout_s: Too small" }),
    ).toEqual({ fields: { "setup.timeout": "Too small" }, form: null });
    expect(serverErrors({ code: "forbidden", message: "no" }).form).toBe(
      "Solo tú, desde Konsora, puedes cambiar los ajustes.",
    );
  });
});

describe("a criterion's check in the task editor (UI-17 ac2)", () => {
  const task = {
    id: "BE-01",
    title: "Caché",
    group: "BE",
    acceptance: [
      { id: "ac1", text: "Cachea", check: "npm test -- cache" },
      { id: "ac2", text: "Se lee bien" },
    ],
  };
  const groups = [{ id: "BE" }];

  it("adds and removes the check of a criterion through the edit op", () => {
    const d = draftFrom(task);
    d.acceptance = [
      { id: "ac1", text: "Cachea", check: "" },
      { id: "ac2", text: "Se lee bien", check: "npm run lint" },
    ];
    expect(changesFrom(d, task, groups)).toEqual({
      ok: true,
      empty: false,
      changes: {
        acceptance: [
          { id: "ac1", text: "Cachea" },
          { id: "ac2", text: "Se lee bien", check: "npm run lint" },
        ],
      },
    });
  });

  it("refuses a check longer than core allows", () => {
    const d = draftFrom(task);
    d.acceptance = [{ id: "ac1", text: "Cachea", check: "x".repeat(1001) }];
    expect(changesFrom(d, task, groups)).toMatchObject({ ok: false, field: "acceptance" });
  });
});
