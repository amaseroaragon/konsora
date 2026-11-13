import { describe, expect, it } from "vitest";
import { completionLog, criteriaEvidence } from "../src/history.ts";
import { parseOp } from "../src/op-schema.ts";
import { applyOp, type Op, type OpContext } from "../src/ops.ts";
import type { Task, TasksDocument } from "../src/schema.ts";
import { parseTasksFile, validateDocument } from "../src/semantics.ts";
import { serializeDocument } from "../src/serialize.ts";

const at = "2026-11-02T10:00:00Z";
const agent: OpContext = { actor: "agent:claude", at };
const task = (extra: Partial<Task> = {}): Task => ({
  id: "BE-01",
  title: "Cache",
  state: "doing",
  group: "BE",
  rank: "a",
  acceptance: [
    { id: "ac1", text: "Una petición repetida no llama al proveedor" },
    { id: "ac2", text: "La caché caduca a los 10 min" },
  ],
  created: { at, by: "human" },
  updated_at: at,
  ...extra,
});
const base = (t: Task = task()): TasksDocument => ({
  schema: "konsora/5",
  project: { name: "P" },
  groups: [{ id: "BE", name: "Backend" }],
  seq: { BE: 1 },
  tasks: [t],
});
const finish = (evidence?: Extract<Op, { op: "finish" }>["evidence"]) =>
  applyOp(
    base(),
    { op: "finish", task: "BE-01", summary: "LRU con TTL", ...(evidence ? { evidence } : {}) },
    agent,
  );

describe("evidence per acceptance criterion (CORE-15)", () => {
  it("finish keeps the evidence on the summary, met by default", () => {
    const r = finish([
      { ac: "ac1", text: "Test cache.test.ts: la 2.ª petición no sale" },
      { ac: "AC2", met: false, text: "El TTL queda para BE-07" },
    ]);
    if (!r.ok) throw new Error(r.error.message);
    const summary = r.document.tasks[0]?.notes?.at(-1);
    expect(summary?.kind).toBe("summary");
    expect(summary?.evidence).toEqual([
      { ac: "ac1", met: true, text: "Test cache.test.ts: la 2.ª petición no sale" },
      { ac: "ac2", met: false, text: "El TTL queda para BE-07" },
    ]);
  });

  it("rejects an unknown criterion, a repeated one and a blank text", () => {
    const unknown = finish([{ ac: "ac9", text: "x" }]);
    expect(!unknown.ok && unknown.error.code).toBe("not_found");
    expect(!unknown.ok && unknown.error.message).toContain("ac1, ac2");
    const twice = finish([
      { ac: "ac1", text: "x" },
      { ac: "ac1", text: "y" },
    ]);
    expect(!twice.ok && twice.error.code).toBe("invalid");
    const blank = finish([{ ac: "ac1", text: "  " }]);
    expect(!blank.ok && blank.error.code).toBe("invalid");
  });

  it("finishing without evidence is still valid", () => {
    const r = finish();
    expect(r.ok && r.document.tasks[0]?.state).toBe("done");
    expect(r.ok && r.document.tasks[0]?.notes?.at(-1)?.evidence).toBeUndefined();
  });

  it("each criterion shows its evidence, its reason, or that it has none", () => {
    const r = finish([{ ac: "ac2", met: false, text: "Pendiente" }]);
    if (!r.ok) throw new Error(r.error.message);
    const done = r.document.tasks[0] as Task;
    expect(criteriaEvidence(done).map((c) => [c.id, c.status, c.evidence])).toEqual([
      ["ac1", "missing", undefined],
      ["ac2", "unmet", "Pendiente"],
    ]);
    expect(completionLog(r.document)[0]).toMatchObject({ unproven: 1, unmet: 1 });
  });

  it("the History marks only closures with criteria lacking evidence", () => {
    const full = finish([
      { ac: "ac1", text: "a" },
      { ac: "ac2", text: "b" },
    ]);
    if (!full.ok) throw new Error(full.error.message);
    const entry = completionLog(full.document)[0];
    expect(entry?.unproven).toBeUndefined();
    expect(entry?.unmet).toBeUndefined();
    const none = finish();
    expect(none.ok && completionLog(none.document)[0]?.unproven).toBe(2);
    // A task without criteria has nothing to prove.
    const plain = applyOp(
      base(task({ acceptance: [] })),
      { op: "finish", task: "BE-01", summary: "ok" },
      agent,
    );
    expect(plain.ok && completionLog(plain.document)[0]?.unproven).toBeUndefined();
  });

  it("validates, serializes in canonical order and round-trips", () => {
    const r = finish([{ ac: "ac1", text: "ok" }]);
    if (!r.ok) throw new Error(r.error.message);
    const text = serializeDocument(r.document);
    expect(text).toContain(
      '"evidence": [\n            {\n              "ac": "ac1",\n              "met": true,',
    );
    const parsed = parseTasksFile(text);
    expect(parsed.ok && serializeDocument(parsed.document)).toBe(text);
    const note = { id: "n1", at, by: "agent:claude", kind: "note" as const, text: "x" };
    const wrongKind = validateDocument(
      base(task({ notes: [{ ...note, evidence: [{ ac: "ac1", met: true, text: "x" }] }] })),
    );
    expect(!wrongKind.ok && wrongKind.issues[0]?.code).toBe("evidence_not_summary");
    const twice = validateDocument(
      base(
        task({
          notes: [
            {
              ...note,
              kind: "summary",
              evidence: [
                { ac: "ac1", met: true, text: "x" },
                { ac: "ac1", met: false, text: "y" },
              ],
            },
          ],
        }),
      ),
    );
    expect(!twice.ok && twice.issues[0]?.code).toBe("duplicate_evidence");
  });

  it("parses finish with evidence from JSON", () => {
    expect(
      parseOp({
        op: "finish",
        task: "BE-01",
        summary: "s",
        evidence: [
          { ac: "ac1", text: "t" },
          { ac: "ac2", met: false, text: "r" },
        ],
      }).ok,
    ).toBe(true);
    expect(
      parseOp({ op: "finish", task: "BE-01", summary: "s", evidence: [{ ac: "ac1" }] }).ok,
    ).toBe(false);
  });
});
