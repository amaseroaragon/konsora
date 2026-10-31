import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyOp, type Op, type OpContext, type OpResult, taskHash } from "../src/ops.ts";
import type { Task, TaskState, TasksDocument } from "../src/schema.ts";
import { validateDocument } from "../src/semantics.ts";
import { documentArb } from "./arbitraries.ts";

const at = "2026-11-02T10:00:00Z";
const human: OpContext = { actor: "human", at };
const agent: OpContext = { actor: "agent:claude", at };
const runner: OpContext = { actor: "konsora", at };

function task(id: string, state: TaskState, deps: string[] = [], extra: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    state,
    group: "BE",
    ...(deps.length ? { deps } : {}),
    rank: "a",
    created: { at, by: "human" },
    updated_at: at,
    ...extra,
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

const ok = (r: OpResult) => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r;
};
const err = (r: OpResult) => (r.ok ? "ok" : r.error.code);
const state = (r: OpResult, id: string) => ok(r).document.tasks.find((t) => t.id === id)?.state;

describe("roles", () => {
  const d = doc(task("BE-01", "proposed"), task("BE-02", "review"), task("BE-03", "done"));

  it.each([
    ["approve", { op: "approve", task: "BE-01" }],
    ["accept", { op: "accept", task: "BE-02" }],
    ["send-back", { op: "send-back", task: "BE-02", feedback: "x" }],
    ["reopen", { op: "reopen", task: "BE-03" }],
    ["set-yolo", { op: "set-yolo", task: "BE-01", value: true }],
    ["answer", { op: "answer", task: "BE-01", text: "x" }],
  ] as [string, Op][])("an agent cannot %s", (_name, op) => {
    expect(err(applyOp(d, op, agent))).toBe("forbidden");
    expect(err(applyOp(d, op, runner))).toBe("forbidden");
  });

  it("humans cannot start, finish or ask: those are agent/runner actions", () => {
    const d2 = doc(task("BE-01", "todo"), task("BE-02", "doing"));
    expect(err(applyOp(d2, { op: "start", task: "BE-01" }, human))).toBe("forbidden");
    expect(err(applyOp(d2, { op: "finish", task: "BE-02", summary: "x" }, human))).toBe(
      "forbidden",
    );
    expect(err(applyOp(d2, { op: "ask", task: "BE-02", text: "?" }, human))).toBe("forbidden");
  });

  it("agents edit and undepend proposals only; humans edit anything", () => {
    const d2 = doc(
      task("BE-01", "todo"),
      task("BE-02", "proposed", ["BE-01"]),
      task("BE-03", "todo", ["BE-01"]),
    );
    expect(err(applyOp(d2, { op: "edit", task: "BE-01", changes: { title: "x" } }, agent))).toBe(
      "forbidden",
    );
    expect(
      ok(applyOp(d2, { op: "edit", task: "BE-02", changes: { title: "New" } }, agent)).document
        .tasks[1]?.title,
    ).toBe("New");
    expect(err(applyOp(d2, { op: "undepend", task: "BE-03", on: "BE-01" }, agent))).toBe(
      "forbidden",
    );
    expect(err(applyOp(d2, { op: "undepend", task: "BE-03", on: "BE-01" }, human))).toBe("ok");
    expect(
      err(applyOp(d2, { op: "edit", task: "BE-01", changes: { title: "Human edit" } }, human)),
    ).toBe("ok");
  });

  it("edit rejects fields outside the whitelist even from untyped JSON", () => {
    const d2 = doc(task("BE-01", "proposed"));
    const sneaky = { op: "edit", task: "BE-01", changes: { state: "done" } } as unknown as Op;
    expect(err(applyOp(d2, sneaky, agent))).toBe("forbidden");
  });

  it("only humans may create a task directly in todo", () => {
    const d2 = doc();
    expect(err(applyOp(d2, { op: "propose", title: "x", group: "BE", state: "todo" }, agent))).toBe(
      "forbidden",
    );
    expect(
      state(applyOp(d2, { op: "propose", title: "x", group: "BE", state: "todo" }, human), "BE-21"),
    ).toBe("todo");
  });
});

describe("transitions", () => {
  it("propose creates the next id from seq (ids never reused) as a proposal", () => {
    const r = ok(
      applyOp(
        doc(task("BE-01", "todo")),
        { op: "propose", title: " Cache ", group: "BE", acceptance: ["fast"] },
        agent,
      ),
    );
    expect(r.created).toEqual(["BE-21"]);
    expect(r.document.seq.BE).toBe(21);
    expect(r.document.tasks[1]).toMatchObject({
      id: "BE-21",
      title: "Cache",
      state: "proposed",
      created: { at, by: "agent:claude" },
      acceptance: [{ id: "ac1", text: "fast" }],
    });
    expect((r.document.tasks[1]?.rank ?? "") > "a").toBe(true);
  });

  it("start on a blocked task is rejected, naming the blockers", () => {
    const r = applyOp(
      doc(task("BE-01", "review"), task("BE-02", "todo", ["BE-01"])),
      { op: "start", task: "BE-02" },
      agent,
    );
    expect(r.ok ? null : r.error).toMatchObject({
      code: "blocked",
      message: "BE-02 is blocked by BE-01",
    });
  });

  it("start → doing; pause → todo; transitions from the wrong state are rejected", () => {
    const d = doc(task("BE-01", "todo"));
    const started = ok(applyOp(d, { op: "start", task: "BE-01", text: "plan" }, agent));
    expect(started.document.tasks[0]?.state).toBe("doing");
    expect(started.document.tasks[0]?.notes?.[0]).toMatchObject({
      kind: "note",
      text: "plan",
      by: "agent:claude",
    });
    expect(err(applyOp(started.document, { op: "start", task: "BE-01" }, agent))).toBe(
      "invalid_transition",
    );
    expect(state(applyOp(started.document, { op: "pause", task: "BE-01" }, agent), "BE-01")).toBe(
      "todo",
    );
  });

  it("finish requires a summary and moves doing → review with a summary note", () => {
    const d = doc(task("BE-01", "doing"));
    expect(err(applyOp(d, { op: "finish", task: "BE-01", summary: "  " }, agent))).toBe(
      "summary_required",
    );
    const r = ok(
      applyOp(
        d,
        { op: "finish", task: "BE-01", summary: "Done it" },
        { ...agent, run: "r-01JC8Z3K2Q" },
      ),
    );
    expect(r.document.tasks[0]?.state).toBe("review");
    expect(r.document.tasks[0]?.notes?.at(-1)).toMatchObject({
      kind: "summary",
      text: "Done it",
      run: "r-01JC8Z3K2Q",
    });
  });

  it("send-back requires feedback and returns review → todo with a feedback note", () => {
    const d = doc(task("BE-01", "review"));
    expect(err(applyOp(d, { op: "send-back", task: "BE-01", feedback: "" }, human))).toBe(
      "feedback_required",
    );
    const r = ok(applyOp(d, { op: "send-back", task: "BE-01", feedback: "Add tests" }, human));
    expect(r.document.tasks[0]?.state).toBe("todo");
    expect(r.document.tasks[0]?.notes?.at(-1)).toMatchObject({ kind: "feedback", by: "human" });
  });

  it("approve, accept and reopen follow the state machine", () => {
    expect(
      state(
        applyOp(doc(task("BE-01", "proposed")), { op: "approve", task: "BE-01" }, human),
        "BE-01",
      ),
    ).toBe("todo");
    expect(
      state(applyOp(doc(task("BE-01", "review")), { op: "accept", task: "BE-01" }, human), "BE-01"),
    ).toBe("done");
    expect(
      state(applyOp(doc(task("BE-01", "done")), { op: "reopen", task: "BE-01" }, human), "BE-01"),
    ).toBe("todo");
    expect(err(applyOp(doc(task("BE-01", "doing")), { op: "accept", task: "BE-01" }, human))).toBe(
      "invalid_transition",
    );
  });

  it("ask needs doing; answer needs an open question", () => {
    const d = doc(task("BE-01", "doing"));
    const asked = ok(applyOp(d, { op: "ask", task: "BE-01", text: "Which DB?" }, agent)).document;
    expect(err(applyOp(d, { op: "answer", task: "BE-01", text: "x" }, human))).toBe("not_waiting");
    const answered = ok(
      applyOp(asked, { op: "answer", task: "BE-01", text: "SQLite" }, human),
    ).document;
    expect(answered.tasks[0]?.notes?.map((n) => n.kind)).toEqual(["question", "answer"]);
    expect(
      err(applyOp(doc(task("BE-01", "todo")), { op: "ask", task: "BE-01", text: "?" }, agent)),
    ).toBe("invalid_transition");
  });

  it("withdraw removes a proposal unless something depends on it", () => {
    const d = doc(task("BE-01", "proposed"), task("BE-02", "proposed", ["BE-01"]));
    expect(err(applyOp(d, { op: "withdraw", task: "BE-01" }, agent))).toBe("has_dependents");
    expect(
      ok(applyOp(d, { op: "withdraw", task: "BE-02" }, agent)).document.tasks.map((t) => t.id),
    ).toEqual(["BE-01"]);
    expect(err(applyOp(doc(task("BE-01", "todo")), { op: "withdraw", task: "BE-01" }, human))).toBe(
      "invalid_transition",
    );
  });

  it("depend rejects cycles and done tasks; adding an existing dep is a no-op", () => {
    const d = doc(task("BE-01", "todo"), task("BE-02", "todo", ["BE-01"]), task("BE-03", "done"));
    expect(err(applyOp(d, { op: "depend", task: "BE-01", on: "BE-02" }, agent))).toBe("invalid");
    expect(err(applyOp(d, { op: "depend", task: "BE-03", on: "BE-01" }, agent))).toBe(
      "invalid_transition",
    );
    expect(ok(applyOp(d, { op: "depend", task: "BE-02", on: "BE-01" }, agent)).changed).toEqual([]);
  });

  it("batch is all-or-nothing and resolves deps by earlier titles", () => {
    const d = doc(task("BE-01", "done"));
    const r = ok(
      applyOp(
        d,
        {
          op: "batch",
          groups: [{ id: "FE", name: "Frontend" }],
          tasks: [
            { title: "API", group: "BE", deps: ["BE-01"] },
            { title: "Screen", group: "FE", deps: ["API"] },
          ],
        },
        agent,
      ),
    );
    expect(r.created).toEqual(["BE-21", "FE-01"]);
    expect(r.document.tasks.find((t) => t.id === "FE-01")?.deps).toEqual(["BE-21"]);
    const bad = applyOp(
      d,
      {
        op: "batch",
        tasks: [
          { title: "A", group: "BE" },
          { title: "B", group: "BE", deps: ["Nope"] },
        ],
      },
      agent,
    );
    expect(err(bad)).toBe("not_found");
    expect(d.tasks).toHaveLength(1); // input untouched
  });

  it("notes get sequential ids and agents cannot write on done tasks", () => {
    const d = doc(task("BE-01", "doing"), task("BE-02", "done"));
    const once = ok(applyOp(d, { op: "note", task: "BE-01", text: "a" }, agent)).document;
    const twice = ok(applyOp(once, { op: "note", task: "BE-01", text: "b" }, agent)).document;
    expect(twice.tasks[0]?.notes?.map((n) => n.id)).toEqual(["n1", "n2"]);
    expect(err(applyOp(d, { op: "note", task: "BE-02", text: "x" }, agent))).toBe(
      "invalid_transition",
    );
    expect(err(applyOp(d, { op: "note", task: "BE-02", text: "x" }, human))).toBe("ok");
  });
});

describe("YOLO", () => {
  const d = doc(
    task("BE-01", "proposed"),
    task("BE-02", "proposed", ["BE-01"]),
    task("BE-03", "proposed", ["BE-02"]),
  );

  it("turning YOLO on approves the chain's proposals", () => {
    const r = ok(applyOp(d, { op: "set-yolo", task: "BE-03", value: true }, human)).document;
    expect(r.tasks.map((t) => t.state)).toEqual(["todo", "todo", "todo"]);
    expect(r.tasks[2]?.yolo).toBe(true);
  });

  it("intermediate tasks finish straight to done; the YOLO task goes to review and YOLO ends", () => {
    let cur = ok(applyOp(d, { op: "set-yolo", task: "BE-03", value: true }, human)).document;
    for (const id of ["BE-01", "BE-02"]) {
      cur = ok(applyOp(cur, { op: "start", task: id }, runner)).document;
      cur = ok(applyOp(cur, { op: "finish", task: id, summary: "ok" }, runner)).document;
      expect(cur.tasks.find((t) => t.id === id)?.state).toBe("done");
    }
    cur = ok(applyOp(cur, { op: "start", task: "BE-03" }, runner)).document;
    cur = ok(applyOp(cur, { op: "finish", task: "BE-03", summary: "ok" }, runner)).document;
    expect(cur.tasks[2]).toMatchObject({ state: "review" });
    expect(cur.tasks[2]?.yolo).toBeUndefined();
  });
});

describe("run scope", () => {
  const d = doc(task("BE-01", "doing"), task("BE-02", "doing"));
  const inRun: OpContext = { ...agent, runTask: "BE-01", run: "r-01JC8Z3K2Q" };

  it("an agent inside a run only acts on its own task, but may propose", () => {
    expect(err(applyOp(d, { op: "note", task: "BE-02", text: "x" }, inRun))).toBe("out_of_scope");
    expect(err(applyOp(d, { op: "finish", task: "BE-02", summary: "x" }, inRun))).toBe(
      "out_of_scope",
    );
    expect(err(applyOp(d, { op: "note", task: "BE-01", text: "x" }, inRun))).toBe("ok");
    expect(err(applyOp(d, { op: "propose", title: "Follow-up", group: "BE" }, inRun))).toBe("ok");
  });
});

describe("preconditions (per-task hashes)", () => {
  const base = doc(task("BE-01", "review"), task("BE-02", "todo"));

  it("an op whose task changed returns conflict with the current task", () => {
    const seen = taskHash(base.tasks[0] as Task);
    const changed = ok(
      applyOp(base, { op: "note", task: "BE-01", text: "meanwhile" }, agent),
    ).document;
    const r = applyOp(changed, { op: "accept", task: "BE-01", expect: { "BE-01": seen } }, human);
    expect(r.ok ? null : r.error).toMatchObject({
      code: "conflict",
      task: "BE-01",
      current: changed.tasks[0],
    });
  });

  it("changes to other tasks do not conflict", () => {
    const seen = taskHash(base.tasks[0] as Task);
    const other = ok(applyOp(base, { op: "start", task: "BE-02" }, agent)).document;
    expect(
      state(
        applyOp(other, { op: "accept", task: "BE-01", expect: { "BE-01": seen } }, human),
        "BE-01",
      ),
    ).toBe("done");
  });

  it("a task that disappeared is a conflict too", () => {
    expect(
      err(applyOp(base, { op: "accept", task: "BE-01", expect: { "BE-09": "sha256:x" } }, human)),
    ).toBe("conflict");
  });
});

describe("properties", () => {
  const agentOps = (ids: string[]): fc.Arbitrary<Op> => {
    const id = fc.constantFrom(...ids, "BE-99");
    const textArb = fc.constantFrom("x", "", "  ", "done");
    return fc.oneof(
      fc.record({
        op: fc.constant("propose" as const),
        title: fc.constant("t"),
        group: fc.constantFrom("BE", "FE", "CORE", "UI", "OPS", "X1"),
      }),
      fc.record({ op: fc.constant("start" as const), task: id }),
      fc.record({ op: fc.constant("pause" as const), task: id }),
      fc.record({ op: fc.constant("finish" as const), task: id, summary: textArb }),
      fc.record({ op: fc.constant("note" as const), task: id, text: textArb }),
      fc.record({ op: fc.constant("ask" as const), task: id, text: textArb }),
      fc.record({ op: fc.constant("withdraw" as const), task: id }),
      fc.record({ op: fc.constant("depend" as const), task: id, on: id }),
      fc.record({ op: fc.constant("undepend" as const), task: id, on: id }),
      fc.record({
        op: fc.constant("edit" as const),
        task: id,
        changes: fc.constant({ title: "edited" }),
      }),
      // Human-only ops must also be refused when an agent tries them.
      fc.record({ op: fc.constant("approve" as const), task: id }),
      fc.record({ op: fc.constant("accept" as const), task: id }),
      fc.record({ op: fc.constant("reopen" as const), task: id }),
      fc.record({ op: fc.constant("set-yolo" as const), task: id, value: fc.boolean() }),
    ) as fc.Arbitrary<Op>;
  };

  const withoutYolo = documentArb.map((d) => ({
    ...d,
    tasks: d.tasks.map(({ yolo: _y, ...t }) => t),
  }));

  it("no sequence of agent ops ever yields proposed→todo or →done, and results stay valid", () => {
    fc.assert(
      fc.property(
        withoutYolo.chain((d) =>
          fc.tuple(fc.constant(d), fc.array(agentOps(d.tasks.map((t) => t.id)), { maxLength: 25 })),
        ),
        fc.constantFrom<OpContext>(agent, runner),
        ([start, ops], ctx) => {
          let cur = start;
          for (const op of ops) {
            const r = applyOp(cur, op, ctx);
            if (!r.ok) continue;
            const before = new Map(cur.tasks.map((t) => [t.id, t.state]));
            for (const t of r.document.tasks) {
              const prev = before.get(t.id);
              if (prev === undefined) expect(t.state).toBe("proposed");
              else {
                expect(prev === "proposed" && t.state === "todo").toBe(false);
                if (prev !== "done") expect(t.state).not.toBe("done");
              }
            }
            expect(validateDocument(r.document).ok).toBe(true);
            cur = r.document;
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("applyOp never mutates its input", () => {
    fc.assert(
      fc.property(
        documentArb.chain((d) => fc.tuple(fc.constant(d), agentOps(d.tasks.map((t) => t.id)))),
        ([d, op]) => {
          const before = JSON.stringify(d);
          applyOp(d, op, agent);
          applyOp(d, op, human);
          expect(JSON.stringify(d)).toBe(before);
        },
      ),
    );
  });
});

describe("restore (human-only revert)", () => {
  it("puts back a previous version, or re-adds a deleted task; agents cannot", () => {
    const original = task("BE-01", "review");
    const changed = doc({ ...original, state: "done", title: "Hand edit" });
    const restored = ok(
      applyOp(changed, { op: "restore", task: "BE-01", version: original }, human),
    ).document;
    expect(restored.tasks[0]).toMatchObject({ state: "review", title: "BE-01", updated_at: at });
    expect(
      ok(applyOp(doc(), { op: "restore", task: "BE-01", version: original }, human)).document.tasks,
    ).toHaveLength(1);
    expect(err(applyOp(changed, { op: "restore", task: "BE-01", version: original }, agent))).toBe(
      "forbidden",
    );
    expect(err(applyOp(changed, { op: "restore", task: "BE-02", version: original }, human))).toBe(
      "invalid",
    );
  });
});
