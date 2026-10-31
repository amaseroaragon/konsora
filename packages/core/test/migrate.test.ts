import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrateV1, splitCriteria } from "../src/migrate.ts";
import { parseTasksFile } from "../src/semantics.ts";
import { serializeDocument } from "../src/serialize.ts";
import { tasksPath, writeMigration } from "../src/store.ts";

const at = "2026-11-03T09:00:00Z";
const opts = { name: "konsora", baseBranch: "main", at };
const legacy = JSON.parse(
  readFileSync(new URL("./fixtures/v1-legacy-tasks.json", import.meta.url), "utf8"),
);

describe("migrateV1 on the real v1 file from tag legacy-v0", () => {
  const result = migrateV1(legacy, opts);
  if (!result.ok) throw new Error(result.message);
  const { document: doc, report } = result;

  it("produces a valid v2 document with every task", () => {
    expect(parseTasksFile(serializeDocument(doc)).ok).toBe(true);
    expect(doc.tasks).toHaveLength(legacy.tasks.length);
    expect(doc.groups).toEqual([{ id: "K", name: "K" }]);
    expect(doc.seq).toEqual({ K: 48 });
  });

  it("maps states (done → done, pending → todo) and keeps ids and dependencies", () => {
    expect(report.states).toEqual({
      "done→done": { from: "done", to: "done", count: 4 },
      "pending→todo": { from: "pending", to: "todo", count: 25 },
    });
    expect(doc.tasks.find((t) => t.id === "K-032")).toMatchObject({
      state: "done",
      deps: ["K-031"],
    });
    expect(doc.tasks.find((t) => t.id === "K-020")).toMatchObject({
      state: "todo",
      deps: ["K-019"],
    });
    expect(report.renumbered).toEqual([]);
  });

  it("strips the redundant id prefix from titles and keeps descriptions", () => {
    const k031 = doc.tasks.find((t) => t.id === "K-031");
    expect(k031?.title).toBe("Retirar chats, proveedores y ejecución del MVP");
    expect(k031?.desc).toContain("Eliminar vistas/componentes de conversaciones");
  });

  it("turns paragraphs of criteria into acceptance items", () => {
    expect(
      doc.tasks.find((t) => t.id === "K-032")?.acceptance?.map((a) => a.text.slice(0, 11)),
    ).toEqual(["Aceptación:", "Pruebas: se"]);
  });

  it("orders ranks by v1 sort_order", () => {
    const byRank = [...doc.tasks].sort((a, b) => (a.rank < b.rank ? -1 : 1)).map((t) => t.id);
    const bySortOrder = [...legacy.tasks]
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((t: { id: string }) => t.id);
    expect(byRank).toEqual(bySortOrder);
  });
});

describe("migrateV1 edge cases", () => {
  const v1 = (tasks: unknown[], extra: Record<string, unknown> = {}) => ({
    schema_version: 1,
    tasks,
    ...extra,
  });
  const task = (o: Record<string, unknown>) => ({ title: "T", status: "pending", ...o });

  it("in_progress becomes todo with a note; in_review and proposal map too", () => {
    const r = migrateV1(
      v1([
        task({ id: "A-01", status: "in_progress" }),
        task({ id: "A-02", status: "in_review" }),
        task({ id: "A-03", status: "proposal" }),
      ]),
      opts,
    );
    if (!r.ok) throw new Error(r.message);
    expect(r.document.tasks.map((t) => t.state)).toEqual(["todo", "review", "proposed"]);
    expect(r.document.tasks[0]?.notes?.[0]).toMatchObject({
      by: "konsora",
      text: expect.stringContaining("in_progress"),
    });
  });

  it("renumbers ids that are not GROUP-NN into group T, remapping deps and noting the old id", () => {
    const r = migrateV1(
      v1([task({ id: "3f2a-uuid" }), task({ id: "other", dependencies: ["3f2a-uuid"] })]),
      opts,
    );
    if (!r.ok) throw new Error(r.message);
    expect(r.report.renumbered).toEqual([
      { from: "3f2a-uuid", to: "T-01" },
      { from: "other", to: "T-02" },
    ]);
    expect(r.document.tasks[1]).toMatchObject({ id: "T-02", deps: ["T-01"] });
    expect(r.document.tasks[0]?.notes?.[0]?.text).toBe("Migrated from v1 id 3f2a-uuid.");
  });

  it("keeps criteria longer than 500 chars losslessly in the description", () => {
    const long = "x".repeat(600);
    const r = migrateV1(
      v1([task({ id: "A-01", description: "Desc", acceptance_criteria: long })]),
      opts,
    );
    if (!r.ok) throw new Error(r.message);
    expect(r.document.tasks[0]?.acceptance).toBeUndefined();
    expect(r.document.tasks[0]?.desc).toBe(`Desc\n\n## Acceptance criteria (v1)\n\n${long}`);
    expect(r.report.criteriaInDescription).toEqual(["A-01"]);
  });

  it("moves attempts, activity and reviews to the history unchanged", () => {
    const attempts = [{ id: "a1", status: "failed" }];
    const r = migrateV1(
      v1([task({ id: "A-01" })], { attempts, activity: [{ id: 1 }], reviews: [] }),
      opts,
    );
    if (!r.ok) throw new Error(r.message);
    expect(r.history).toMatchObject({ attempts, activity: [{ id: 1 }], reviews: [] });
    expect(r.report.history).toEqual({ attempts: 1, activity: 1, reviews: 0 });
  });

  it("rejects input that is not v1", () => {
    expect(migrateV1({ schema_version: 2 }, opts).ok).toBe(false);
    expect(migrateV1(v1([{ id: "A-01" }]), opts).ok).toBe(false);
  });
});

describe("splitCriteria", () => {
  it("splits bullets (joining wrapped lines) or paragraphs", () => {
    expect(splitCriteria("- one\n  continued\n- two\n3) three")).toEqual([
      "one continued",
      "two",
      "three",
    ]);
    expect(splitCriteria("First para\nwrapped.\n\nSecond.")).toEqual([
      "First para wrapped.",
      "Second.",
    ]);
    expect(splitCriteria("  ")).toEqual([]);
  });
});

describe("writeMigration", () => {
  it("refuses when the file changed since the preview, or a backup already exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "konsora-mig-"));
    mkdirSync(join(root, ".konsora"));
    const original = JSON.stringify(legacy);
    writeFileSync(tasksPath(root), original);
    const r = migrateV1(legacy, opts);
    if (!r.ok) throw new Error(r.message);
    const text = serializeDocument(r.document);
    const stale = await writeMigration(root, {
      expectedText: `${original} `,
      text,
      history: r.history,
    });
    expect(stale.ok ? null : stale.error.message).toContain("changed since the migration preview");
    writeFileSync(join(root, ".konsora", "tasks.v1.json.bak"), "old");
    const exists = await writeMigration(root, { expectedText: original, text, history: r.history });
    expect(exists.ok ? null : exists.error.code).toBe("exists");
    expect(readFileSync(tasksPath(root), "utf8")).toBe(original);
    rmSync(root, { recursive: true });
  });
});
