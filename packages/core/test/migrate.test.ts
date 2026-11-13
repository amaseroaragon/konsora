import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migratePlan, migrateV1, migrateV2, splitCriteria } from "../src/migrate.ts";
import { parseTasksFile } from "../src/semantics.ts";
import { serializeDocument } from "../src/serialize.ts";
import { tasksPath, writeMigration } from "../src/store.ts";

const at = "2026-11-03T09:00:00Z";
const opts = { name: "konsora", at };
const legacy = JSON.parse(
  readFileSync(new URL("./fixtures/v1-legacy-tasks.json", import.meta.url), "utf8"),
);

describe("migrateV1 on the real v1 file from tag legacy-v0", () => {
  const result = migrateV1(legacy, opts);
  if (!result.ok) throw new Error(result.message);
  const { document: doc, report } = result;

  it("produces a valid v3 document with every task", () => {
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
    expect(r.document.tasks.map((t) => t.state)).toEqual(["todo", "done", "proposed"]);
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
      from: "v1",
      history: r.history,
    });
    expect(stale.ok ? null : stale.error.message).toContain("changed since the migration preview");
    writeFileSync(join(root, ".konsora", "tasks.v1.json.bak"), "old");
    const exists = await writeMigration(root, {
      expectedText: original,
      text,
      from: "v1",
      history: r.history,
    });
    expect(exists.ok ? null : exists.error.code).toBe("exists");
    expect(readFileSync(tasksPath(root), "utf8")).toBe(original);
    rmSync(root, { recursive: true });
  });
});

describe("migrateV2 (konsora/2 → konsora/5)", () => {
  const v2 = {
    $schema: "../schema/tasks.v2.schema.json",
    schema: "konsora/2",
    project: {
      name: "P",
      base_branch: "main",
      defaults: { provider: "claude", model: "opus" },
      recommended: { high: { provider: "claude", model: "opus" } },
      setup: { run: "npm ci" },
      checks: [{ id: "test", run: "npm test" }],
      check_retries: 2,
      reviewer: { launch: "auto", agent: { provider: "codex", model: "gpt-5" } },
      templates: [
        { id: "bug", name: "Bug", difficulty: "low", acceptance: [{ text: "T", check: "x" }] },
      ],
      "x-editor": 1,
    },
    groups: [{ id: "BE", name: "Backend" }],
    seq: { BE: 1 },
    tasks: [
      {
        id: "BE-01",
        title: "T",
        state: "review",
        group: "BE",
        rank: "a",
        acceptance: [{ id: "ac1", text: "Works", check: "npm test" }],
        difficulty: "high",
        agent: { provider: "claude", model: "opus" },
        created: { at, by: "human" },
        updated_at: at,
        notes: [
          { id: "n1", at, by: "agent:claude", kind: "summary", text: "Done", run: "r-01JC8Z3K2Q" },
          { id: "n2", at, by: "agent:codex", kind: "review", text: "Fine", verdict: "approve" },
        ],
      },
    ],
  };

  it("drops the run-only fields, keeps the rest and reports what it dropped", () => {
    const result = migrateV2(v2, { at });
    if (!result.ok) throw new Error(result.message);
    const { document: doc, report } = result;
    expect(doc.schema).toBe("konsora/5");
    expect(doc.$schema).toBe("../schema/tasks.v5.schema.json");
    expect(doc.tasks[0]?.state).toBe("done");
    expect(doc.project).toEqual({
      name: "P",
      templates: [{ id: "bug", name: "Bug", acceptance: [{ text: "T" }] }],
      "x-editor": 1,
    });
    expect(doc.tasks[0]).not.toHaveProperty("agent");
    expect(doc.tasks[0]?.difficulty).toBe("high"); // back in CORE-22
    expect(doc.tasks[0]?.acceptance).toEqual([{ id: "ac1", text: "Works" }]);
    expect(doc.tasks[0]?.notes?.map((n) => [n.kind, n.text])).toEqual([
      ["summary", "Done"],
      ["note", "[review: approve] Fine"],
      ["note", "Migrated from review to done: konsora/4 has no review step."],
    ]);
    expect(report).toEqual({
      from: "konsora/2",
      tasks: 1,
      reviewNotes: 1,
      reviewToDone: ["BE-01"],
      blocks: [],
      dropped: {
        "project.base_branch": 1,
        "project.defaults": 1,
        "project.recommended": 1,
        "project.setup": 1,
        "project.checks": 1,
        "project.check_retries": 1,
        "project.reviewer": 1,
        "project.templates[].difficulty": 1,
        "project.templates[].acceptance[].check": 1,
        "tasks[].agent": 1,
        "tasks[].acceptance[].check": 1,
        "tasks[].notes[].run": 1,
        "tasks[].notes[].verdict": 1,
      },
    });
    expect(parseTasksFile(serializeDocument(doc)).ok).toBe(true);
  });

  it("is deterministic and refuses anything that is not konsora/2", () => {
    expect(migrateV2(structuredClone(v2), { at })).toEqual(migrateV2(v2, { at }));
    expect(migrateV2({ schema: "konsora/5" }, { at }).ok).toBe(false);
    expect(migrateV2(legacy, { at }).ok).toBe(false);
  });

  it("writes the v5 plan with a v2 backup and no history file", async () => {
    const root = mkdtempSync(join(tmpdir(), "konsora-mig-"));
    mkdirSync(join(root, ".konsora"));
    const original = JSON.stringify(v2);
    writeFileSync(tasksPath(root), original);
    const r = migrateV2(v2, { at });
    if (!r.ok) throw new Error(r.message);
    const text = serializeDocument(r.document);
    const written = await writeMigration(root, { expectedText: original, text, from: "v2" });
    expect(written.ok && written.history).toBe(undefined);
    expect(readFileSync(join(root, ".konsora", "tasks.v2.json.bak"), "utf8")).toBe(original);
    expect(readFileSync(tasksPath(root), "utf8")).toBe(text);
    rmSync(root, { recursive: true });
  });
});

describe("migratePlan (konsora/3 and konsora/4 → konsora/5)", () => {
  const v3 = {
    schema: "konsora/3",
    project: { name: "P" },
    groups: [{ id: "BE", name: "Backend" }],
    seq: { BE: 3 },
    tasks: [
      {
        id: "BE-01",
        title: "A",
        state: "review",
        group: "BE",
        rank: "a",
        created: { at, by: "human" },
        updated_at: at,
        notes: [{ id: "n1", at, by: "agent:claude", kind: "summary", text: "ok" }],
      },
      {
        id: "BE-02",
        title: "B",
        state: "todo",
        group: "BE",
        rank: "b",
        yolo: true,
        created: { at, by: "human" },
        updated_at: at,
      },
      {
        id: "BE-03",
        title: "C",
        state: "proposed",
        group: "BE",
        rank: "c",
        created: { at, by: "human" },
        updated_at: at,
      },
    ],
  };

  it("moves review to done with a note, drops YOLO and keeps proposals as ideas", () => {
    const r = migratePlan(v3, { at });
    if (!r.ok) throw new Error(r.message);
    expect(r.document.tasks.map((t) => t.state)).toEqual(["done", "todo", "proposed"]);
    expect(r.document.tasks[0]?.notes?.at(-1)).toMatchObject({
      id: "n2",
      by: "konsora",
      kind: "note",
    });
    expect(r.document.tasks[1]).not.toHaveProperty("yolo");
    expect(r.report).toEqual({
      from: "konsora/3",
      tasks: 3,
      dropped: { "tasks[].yolo": 1 },
      reviewNotes: 0,
      reviewToDone: ["BE-01"],
      blocks: [],
    });
    expect(migratePlan({ schema: "konsora/5" }, { at }).ok).toBe(false);
  });

  it("drops the blocks of a v4 plan and each task's block, and reports their branches", () => {
    const v4 = {
      $schema: "../schema/tasks.v4.schema.json",
      schema: "konsora/4",
      project: { name: "P" },
      groups: [{ id: "BE", name: "Backend" }],
      seq: { BE: 2 },
      blocks: [
        {
          id: "cache",
          name: "Cache",
          branch: "konsora/cache",
          base: "main",
          created: { at, by: "human" },
        },
        {
          id: "docs",
          name: "Docs",
          branch: "feat/docs",
          base: "main",
          created: { at, by: "human" },
          merged: { at, by: "human", commit: "a".repeat(40), strategy: "squash" },
        },
      ],
      tasks: [
        {
          id: "BE-01",
          title: "A",
          state: "todo",
          group: "BE",
          rank: "a",
          block: "cache",
          created: { at, by: "human" },
          updated_at: at,
        },
        {
          id: "BE-02",
          title: "B",
          state: "done",
          group: "BE",
          rank: "b",
          block: "docs",
          created: { at, by: "human" },
          updated_at: at,
        },
      ],
    };
    const r = migratePlan(v4, { at });
    if (!r.ok) throw new Error(r.message);
    expect(r.document.schema).toBe("konsora/5");
    expect(r.document.$schema).toBe("../schema/tasks.v5.schema.json");
    expect(r.document).not.toHaveProperty("blocks");
    for (const task of r.document.tasks) expect(task).not.toHaveProperty("block");
    expect(r.document.tasks.map((t) => t.state)).toEqual(["todo", "done"]);
    expect(r.report).toEqual({
      from: "konsora/4",
      tasks: 2,
      dropped: { blocks: 1, "tasks[].block": 2 },
      reviewNotes: 0,
      reviewToDone: [],
      blocks: [
        { id: "cache", name: "Cache", branch: "konsora/cache", merged: false },
        { id: "docs", name: "Docs", branch: "feat/docs", merged: true },
      ],
    });
    expect(parseTasksFile(serializeDocument(r.document)).ok).toBe(true);
  });
});
