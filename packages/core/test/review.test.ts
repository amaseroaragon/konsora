import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { OpSchema } from "../src/op-schema.ts";
import { applyOp, type Op, type OpContext, type OpResult } from "../src/ops.ts";
import { createRunIdGenerator, type Run, RunSchema } from "../src/run.ts";
import {
  ReviewerSchema,
  reviewerAgent,
  type Task,
  type TaskState,
  type TasksDocument,
} from "../src/schema.ts";
import { validateDocument } from "../src/semantics.ts";
import { canAddRun, integrableRun } from "../src/variants.ts";
import { documentArb } from "./arbitraries.ts";

const at = "2026-11-02T10:00:00Z";
const RUN = "r-01JC8Z3K2QX7M4V9T0B6N5R8PA";
const human: OpContext = { actor: "human", at };
const agent: OpContext = { actor: "agent:claude", at };
const konsora: OpContext = { actor: "konsora", at };
const inRun: OpContext = { ...agent, runTask: "BE-01", run: RUN };
const reviewer: OpContext = { actor: "agent:codex", at, runTask: "BE-01", run: RUN, review: true };

function task(id: string, state: TaskState): Task {
  return {
    id,
    title: id,
    state,
    group: "BE",
    rank: "a",
    created: { at, by: "human" },
    updated_at: at,
  };
}

function doc(...tasks: Task[]): TasksDocument {
  return {
    schema: "konsora/2",
    project: { name: "P", base_branch: "main" },
    groups: [{ id: "BE", name: "Backend" }],
    seq: { BE: 20 },
    tasks,
  };
}

const err = (r: OpResult) => (r.ok ? "ok" : r.error.code);
const review = (
  verdict: "approve" | "changes" = "changes",
  taskId = "BE-01",
  text = "The cache never expires: ac2 does not hold.",
): Op => ({ op: "review", task: taskId, verdict, text });

describe("the agent of a review run (ac1)", () => {
  const base = doc(task("BE-01", "review"), task("BE-02", "todo"));

  it("leaves a review note with its verdict and run, and the task stays as it was", () => {
    const result = applyOp(base, review("changes"), reviewer);
    if (!result.ok) throw new Error(result.error.message);
    const after = result.document.tasks[0] as Task;
    expect(after.state).toBe("review");
    expect(after.notes).toEqual([
      {
        id: "n1",
        at,
        by: "agent:codex",
        kind: "review",
        text: "The cache never expires: ac2 does not hold.",
        run: RUN,
        verdict: "changes",
      },
    ]);
    expect(validateDocument(result.document).ok).toBe(true);
    expect(OpSchema.safeParse(review("approve")).success).toBe(true);
    expect(OpSchema.safeParse({ ...review(), verdict: "accept" } as unknown).success).toBe(false);
  });

  it("can do nothing else: no note, ask, finish, proposal or state change", () => {
    const others: Op[] = [
      { op: "note", task: "BE-01", text: "x" },
      { op: "ask", task: "BE-01", text: "x" },
      { op: "finish", task: "BE-01", summary: "x" },
      { op: "propose", title: "Follow-up", group: "BE" },
      { op: "pause", task: "BE-01" },
      { op: "start", task: "BE-02" },
    ];
    for (const op of others) expect(err(applyOp(base, op, reviewer))).toBe("out_of_scope");
    // Accepting or sending back is the human's, inside a review run or not.
    expect(err(applyOp(base, { op: "accept", task: "BE-01" }, reviewer))).toBe("forbidden");
    expect(err(applyOp(base, { op: "send-back", task: "BE-01", feedback: "x" }, reviewer))).toBe(
      "forbidden",
    );
    expect(err(applyOp(base, review("changes", "BE-02"), reviewer))).toBe("out_of_scope");
    expect(err(applyOp(base, review("changes", "BE-01", "  "), reviewer))).toBe("text_required");
  });

  it("is the only one who can review", () => {
    for (const ctx of [human, konsora, agent, inRun]) {
      expect(err(applyOp(base, review(), ctx))).toBe("forbidden");
    }
  });

  it("a review note always has a verdict, and only it", () => {
    const note = { id: "n1", at, by: "agent:codex", kind: "review", text: "ok" };
    const withNote = (n: object) => doc({ ...task("BE-01", "review"), notes: [n as never] });
    expect(validateDocument(withNote(note)).ok).toBe(false);
    expect(validateDocument(withNote({ ...note, verdict: "approve" })).ok).toBe(true);
    expect(validateDocument(withNote({ ...note, kind: "note", verdict: "approve" })).ok).toBe(
      false,
    );
  });
});

describe("project.reviewer and the readonly profile (ac2)", () => {
  const set = (reviewer: unknown): Op => ({ op: "set-reviewer", reviewer }) as Op;
  const codex = { provider: "codex" as const, model: "gpt-5" };

  it("only the human sets it, and null removes it", () => {
    const base = doc(task("BE-01", "todo"));
    const op = set({ agent: codex, launch: "auto" });
    expect(OpSchema.safeParse(op).success).toBe(true);
    for (const ctx of [agent, konsora, inRun, reviewer]) {
      expect(err(applyOp(base, op, ctx))).toBe("forbidden");
    }
    const result = applyOp(base, op, human);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.document.project.reviewer).toEqual({ agent: codex, launch: "auto" });
    const removed = applyOp(result.document, set(null), human);
    expect(removed.ok && removed.document.project.reviewer).toBeUndefined();
  });

  it("validates the launch mode and always uses the readonly profile", () => {
    expect(ReviewerSchema.safeParse({ agent: codex, launch: "manual" }).success).toBe(true);
    expect(
      ReviewerSchema.safeParse({ agent: { ...codex, permissions: "readonly" }, launch: "auto" })
        .success,
    ).toBe(true);
    expect(ReviewerSchema.safeParse({ agent: codex, launch: "always" }).success).toBe(false);
    expect(OpSchema.safeParse(set({ agent: codex, launch: "always" })).success).toBe(false);
    const writer = set({ agent: { ...codex, permissions: "default" }, launch: "auto" });
    expect(err(applyOp(doc(task("BE-01", "todo")), writer, human))).toBe("invalid");
    expect(reviewerAgent({ agent: codex, launch: "auto" })).toEqual({
      ...codex,
      permissions: "readonly",
    });
  });

  it("a review run in run.json reviews a run, with the readonly profile", () => {
    const nextId = createRunIdGenerator();
    const work: Run = {
      id: nextId(),
      task: "BE-01",
      task_hash: `sha256:${"a".repeat(64)}`,
      agent: { provider: "claude", model: "opus", permissions: "default" },
      state: "succeeded",
    };
    const reviewRun: Run = {
      ...work,
      id: nextId(),
      state: "running",
      kind: "review",
      review_of: work.id,
      agent: reviewerAgent({ agent: codex, launch: "auto" }),
    };
    expect(RunSchema.safeParse(reviewRun).success).toBe(true);
    const { review_of: _, ...lost } = reviewRun;
    expect(RunSchema.safeParse(lost).success).toBe(false);
    expect(RunSchema.safeParse({ ...reviewRun, agent: work.agent }).success).toBe(false);
    expect(RunSchema.safeParse({ ...work, review_of: work.id }).success).toBe(false);
    expect(RunSchema.safeParse({ ...reviewRun, variant_of: reviewRun.id }).success).toBe(false);

    // It never occupies the task nor is integrated; one at a time per reviewed run.
    expect(canAddRun([work, reviewRun], { id: nextId() }).ok).toBe(true);
    const twin = canAddRun([work, reviewRun], { id: nextId(), kind: "review", review_of: work.id });
    expect(twin.ok || twin.error.code).toBe("active_run");
    expect(integrableRun([work, reviewRun])).toEqual({ ok: true, run: work });
  });
});

describe("properties (ac3)", () => {
  const reviewerOps = (ids: string[]): fc.Arbitrary<Op> => {
    const id = fc.constantFrom(...ids, "BE-99");
    const text = fc.constantFrom("x", "", "Looks right.");
    return fc.oneof(
      fc.record({
        op: fc.constant("review" as const),
        task: id,
        verdict: fc.constantFrom("approve" as const, "changes" as const),
        text,
      }),
      fc.record({ op: fc.constant("note" as const), task: id, text }),
      fc.record({ op: fc.constant("ask" as const), task: id, text }),
      fc.record({ op: fc.constant("finish" as const), task: id, summary: text }),
      fc.record({ op: fc.constant("start" as const), task: id }),
      fc.record({ op: fc.constant("pause" as const), task: id }),
      fc.record({ op: fc.constant("accept" as const), task: id }),
      fc.record({ op: fc.constant("send-back" as const), task: id, feedback: text }),
      fc.record({ op: fc.constant("reopen" as const), task: id }),
      fc.record({ op: fc.constant("approve" as const), task: id }),
      fc.record({ op: fc.constant("withdraw" as const), task: id }),
      fc.record({ op: fc.constant("complete" as const), task: id, checks_passed: fc.boolean() }),
      fc.record({ op: fc.constant("set-yolo" as const), task: id, value: fc.boolean() }),
      fc.record({ op: fc.constant("propose" as const), title: fc.constant("t"), group: id }),
      fc.record({
        op: fc.constant("edit" as const),
        task: id,
        changes: fc.constant({ title: "edited" }),
      }),
    ) as fc.Arbitrary<Op>;
  };

  it("no op of a reviewer changes any task's state; it only adds review notes to its task", () => {
    fc.assert(
      fc.property(
        documentArb.chain((d) => {
          const ids = d.tasks.map((t) => t.id);
          return fc.tuple(
            fc.constant(d),
            fc.constantFrom(...ids, "BE-99"),
            fc.array(reviewerOps(ids), { maxLength: 20 }),
          );
        }),
        ([start, runTask, ops]) => {
          const ctx: OpContext = { ...reviewer, runTask };
          let cur = start;
          for (const op of ops) {
            const r = applyOp(cur, op, ctx);
            if (!r.ok) continue;
            expect(op.op).toBe("review");
            expect(r.document.project).toEqual(cur.project);
            expect(r.document.tasks.map((t) => t.id)).toEqual(cur.tasks.map((t) => t.id));
            for (const [i, after] of r.document.tasks.entries()) {
              const before = cur.tasks[i] as Task;
              expect(after.state).toBe(before.state);
              const { notes: notesAfter = [], updated_at: _a, ...restAfter } = after;
              const { notes: notesBefore = [], updated_at: _b, ...restBefore } = before;
              expect(restAfter).toEqual(restBefore);
              const added = notesAfter.slice(notesBefore.length);
              expect(notesAfter.slice(0, notesBefore.length)).toEqual(notesBefore);
              if (after.id !== runTask) expect(added).toEqual([]);
              for (const note of added) expect(note.kind).toBe("review");
            }
            expect(validateDocument(r.document).ok).toBe(true);
            cur = r.document;
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
