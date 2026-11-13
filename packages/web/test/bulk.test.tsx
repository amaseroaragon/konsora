import { applyOp, type Task, type TasksDocument, taskHash } from "@konsora/core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { applyBulk, bulkChanges, labelProblem, normalizeLabel } from "../src/shell/bulk-model.ts";
import { SelectionBar } from "../src/shell/SelectionBar.tsx";

const at = "2026-11-13T10:00:00Z";
const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  title: `Título ${id}`,
  state: "todo",
  group: "BE",
  rank: "a",
  created: { at, by: "human" },
  updated_at: at,
  ...extra,
});
const groups = [
  { id: "BE", name: "Backend" },
  { id: "FE", name: "Frontend" },
];
const doc: TasksDocument = {
  schema: "konsora/5",
  project: { name: "P" },
  groups,
  seq: { BE: 3 },
  tasks: [task("BE-01", { labels: ["ui"] }), task("BE-02"), task("BE-03", { group: "FE" })],
};
const hashed = doc.tasks.map((x) => ({ ...x, hash: taskHash(x) }));

describe("bulk edits of the selection (UI-26)", () => {
  it("turns a group move or a label into one edit per task that core accepts", () => {
    const changes = bulkChanges(doc.tasks[0] as Task, { kind: "group", group: "FE" });
    expect(changes).toEqual({ group: "FE" });
    expect(bulkChanges(doc.tasks[0] as Task, { kind: "label-add", label: "m4" })).toEqual({
      labels: ["ui", "m4"],
    });
    expect(bulkChanges(doc.tasks[0] as Task, { kind: "label-remove", label: "ui" })).toEqual({
      labels: [],
    });
    const applied = applyOp(
      doc,
      { op: "edit", task: "BE-01", changes: { group: "FE", labels: ["ui", "m4"] } },
      { actor: "human", at },
    );
    if (!applied.ok) throw new Error(applied.error.message);
    expect(applied.document.tasks[0]).toMatchObject({ group: "FE", labels: ["ui", "m4"] });
  });

  it("skips tasks that already have the change", () => {
    expect(bulkChanges(doc.tasks[2] as Task, { kind: "group", group: "FE" })).toBeNull();
    expect(bulkChanges(doc.tasks[0] as Task, { kind: "label-add", label: "ui" })).toBeNull();
    expect(bulkChanges(doc.tasks[1] as Task, { kind: "label-remove", label: "ui" })).toBeNull();
  });

  it("checks the label with core's rule", () => {
    expect(normalizeLabel("  M4 ")).toBe("m4");
    expect(labelProblem("m4")).toBeNull();
    expect(labelProblem("")).toMatch(/Escribe/);
    expect(labelProblem("con espacio")).toMatch(/no vale como etiqueta/);
  });

  it("sends one conditioned edit per task and returns the refused ones with their error (ac2)", async () => {
    const sent: unknown[] = [];
    const outcome = await applyBulk(
      hashed,
      ["BE-01", "BE-02", "BE-03"],
      { kind: "group", group: "FE" },
      async (id, hash, changes) => {
        sent.push({ id, hash, changes });
        if (id === "BE-02") throw new Error("conflict");
      },
    );
    expect(sent).toEqual([
      { id: "BE-01", hash: hashed[0]?.hash, changes: { group: "FE" } },
      { id: "BE-02", hash: hashed[1]?.hash, changes: { group: "FE" } },
    ]);
    expect(outcome.changed).toEqual(["BE-01"]);
    expect(outcome.refused.map((r) => r.id)).toEqual(["BE-02"]);
  });

  const bar = (readOnly: boolean) =>
    renderToStaticMarkup(
      <SelectionBar
        ids={["BE-01", "BE-02"]}
        promotable={[]}
        deletable={["BE-01", "BE-02"]}
        readOnly={readOnly}
        onPromote={() => {}}
        onDelete={() => {}}
        onClear={() => {}}
        groups={groups}
        labels={["ui"]}
        onBulk={() => {}}
      />,
    );

  it("offers moving to a group and adding or removing a label, never in read-only (ac1, ac3)", () => {
    const html = bar(false);
    expect(html).toContain("Mover al grupo");
    expect(html).toContain("Añadir etiqueta");
    expect(html).toContain("Quitar etiqueta");
    expect(bar(true)).not.toContain("Mover al grupo");
    expect(bar(true)).not.toContain("Añadir etiqueta");
  });
});
