import type { Task } from "@konsora/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ExternalFlag } from "../src/api/board.ts";
import { createApi } from "../src/api/client.ts";
import { ApiContext } from "../src/api/projects.ts";
import { ExternalChanges } from "../src/shell/External.tsx";
import { clipped, externalDiff, lostContent } from "../src/shell/external-model.ts";
import { ToastProvider } from "../src/ui/index.ts";

const at = "2026-11-13T10:00:00Z";
const before: Task = {
  id: "BE-01",
  title: "Primera",
  state: "done",
  group: "BE",
  rank: "a",
  desc: "Corta",
  labels: ["ui"],
  acceptance: [{ id: "ac1", text: "Se ve" }],
  notes: [{ id: "n1", at, by: "agent:claude", kind: "summary", text: "Hecho" }],
  created: { at, by: "human" },
  updated_at: at,
};

describe("external change, before and after (UI-22)", () => {
  it("lists only the fields that differ, with both values (ac1)", () => {
    const after: Task = {
      ...before,
      state: "todo",
      title: "Otra",
      labels: ["ui", "m4"],
      updated_at: "2026-11-13T11:00:00Z",
    };
    expect(externalDiff(before, after)).toEqual([
      { field: "state", before: "Hecho", after: "Por hacer" },
      { field: "title", before: "Primera", after: "Otra" },
      { field: "labels", before: "ui", after: "ui, m4" },
    ]);
    // Created outside: everything it has is new.
    expect(externalDiff(null, after).map((row) => row.before)).toEqual(
      externalDiff(null, after).map(() => ""),
    );
  });

  it("for a deleted task, shows what would be lost (ac2)", () => {
    const lost = lostContent(before);
    expect(lost.map((row) => row.field)).toEqual([
      "state",
      "title",
      "desc",
      "acceptance",
      "labels",
      "group",
      "notes",
    ]);
    expect(lost.find((row) => row.field === "notes")?.value).toBe("n1 · claude · resumen: Hecho");
  });

  it("cuts long or multi-line text, which can then be unfolded (ac3)", () => {
    expect(clipped("corto")).toBeNull();
    expect(clipped(`${"a".repeat(200)}`)).toHaveLength(120);
    expect(clipped("línea uno\nlínea dos")).toBe("línea uno…");
  });
});

describe("external changes banner (UI-22)", () => {
  const render = (flags: ExternalFlag[], tasks: Task[]) =>
    renderToStaticMarkup(
      <ApiContext.Provider value={createApi("ab".repeat(32))}>
        <QueryClientProvider client={new QueryClient()}>
          <ToastProvider>
            <ExternalChanges projectId="p1" flags={flags} tasks={tasks} readOnly={false} />
          </ToastProvider>
        </QueryClientProvider>
      </ApiContext.Provider>,
    );

  it("shows each change's fields before and now, and a deleted task's content", () => {
    const edited = render(
      [{ task: "BE-01", kind: "edited", message: "", previous: before, detected_at: at }],
      [{ ...before, desc: `${"x".repeat(150)}` }],
    );
    expect(edited).toContain(">Antes<");
    expect(edited).toContain(">Descripción<");
    expect(edited).toContain("<details");
    const deleted = render(
      [
        {
          task: "BE-01",
          kind: "deleted",
          message: "",
          from: "done",
          previous: before,
          detected_at: at,
        },
      ],
      [],
    );
    expect(deleted).toContain("Lo que se perdería");
    expect(deleted).toContain("Primera");
  });
});
