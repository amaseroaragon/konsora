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
    schema: "konsora/5",
    project: { name: "P" },
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
  const d = doc(task("BE-01", "proposed"), task("BE-02", "doing"), task("BE-03", "done"));

  it.each([
    ["reopen", { op: "reopen", task: "BE-03" }],
    ["answer", { op: "answer", task: "BE-01", text: "x" }],
    ["set-templates", { op: "set-templates", templates: [] }],
  ] as [string, Op][])("an agent cannot %s", (_name, op) => {
    expect(err(applyOp(d, op, agent))).toBe("forbidden");
    expect(err(applyOp(d, op, runner))).toBe("forbidden");
  });

  it("humans cannot start, finish or ask: those are the agent's", () => {
    const d2 = doc(task("BE-01", "todo"), task("BE-02", "doing"));
    expect(err(applyOp(d2, { op: "start", task: "BE-01" }, human))).toBe("forbidden");
    expect(err(applyOp(d2, { op: "finish", task: "BE-02", summary: "x" }, human))).toBe(
      "forbidden",
    );
    expect(err(applyOp(d2, { op: "ask", task: "BE-02", text: "?" }, human))).toBe("forbidden");
  });

  it("agents edit and undepend unfinished tasks; only humans change done work", () => {
    const d2 = doc(
      task("BE-01", "done"),
      task("BE-02", "todo", ["BE-01"]),
      task("BE-03", "done", ["BE-01"]),
    );
    expect(err(applyOp(d2, { op: "edit", task: "BE-01", changes: { title: "x" } }, agent))).toBe(
      "forbidden",
    );
    expect(
      ok(applyOp(d2, { op: "edit", task: "BE-02", changes: { title: "New" } }, agent)).document
        .tasks[1]?.title,
    ).toBe("New");
    expect(err(applyOp(d2, { op: "undepend", task: "BE-02", on: "BE-01" }, agent))).toBe("ok");
    expect(err(applyOp(d2, { op: "undepend", task: "BE-03", on: "BE-01" }, agent))).toBe(
      "forbidden",
    );
    expect(
      err(applyOp(d2, { op: "edit", task: "BE-01", changes: { title: "Human edit" } }, human)),
    ).toBe("ok");
  });

  it("edit rejects fields outside the whitelist even from untyped JSON", () => {
    const d2 = doc(task("BE-01", "proposed"));
    const sneaky = { op: "edit", task: "BE-01", changes: { state: "done" } } as unknown as Op;
    expect(err(applyOp(d2, sneaky, agent))).toBe("forbidden");
  });

  it("anyone creates tasks in todo (no approval) or as ideas, and promotes ideas", () => {
    for (const ctx of [agent, human]) {
      expect(state(applyOp(doc(), { op: "propose", title: "x", group: "BE" }, ctx), "BE-21")).toBe(
        "todo",
      );
      const idea = ok(
        applyOp(doc(), { op: "propose", title: "x", group: "BE", state: "proposed" }, ctx),
      ).document;
      expect(idea.tasks[0]?.state).toBe("proposed");
      expect(state(applyOp(idea, { op: "promote", task: "BE-21" }, ctx), "BE-21")).toBe("todo");
    }
  });
});

describe("transitions", () => {
  it("propose creates the next id from seq (ids never reused), in todo", () => {
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
      state: "todo",
      created: { at, by: "agent:claude" },
      acceptance: [{ id: "ac1", text: "fast" }],
    });
    expect((r.document.tasks[1]?.rank ?? "") > "a").toBe(true);
  });

  it("start on a blocked task is rejected, naming the blockers", () => {
    const r = applyOp(
      doc(task("BE-01", "doing"), task("BE-02", "todo", ["BE-01"])),
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

  it("finish requires a summary and moves doing → done with a summary note", () => {
    const d = doc(task("BE-01", "doing"));
    expect(err(applyOp(d, { op: "finish", task: "BE-01", summary: "  " }, agent))).toBe(
      "summary_required",
    );
    const r = ok(applyOp(d, { op: "finish", task: "BE-01", summary: "Done it" }, agent));
    expect(r.document.tasks[0]?.state).toBe("done");
    expect(r.document.tasks[0]?.notes?.at(-1)).toMatchObject({ kind: "summary", text: "Done it" });
  });

  it("promote and reopen follow the state machine", () => {
    expect(
      state(
        applyOp(doc(task("BE-01", "proposed")), { op: "promote", task: "BE-01" }, agent),
        "BE-01",
      ),
    ).toBe("todo");
    expect(
      state(applyOp(doc(task("BE-01", "done")), { op: "reopen", task: "BE-01" }, human), "BE-01"),
    ).toBe("todo");
    expect(err(applyOp(doc(task("BE-01", "todo")), { op: "promote", task: "BE-01" }, human))).toBe(
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

  it("delete removes a task and drops it from its dependents, with a note", () => {
    const d = doc(task("BE-01", "doing"), task("BE-02", "todo", ["BE-01"]), task("BE-03", "todo"));
    const r = ok(applyOp(d, { op: "delete", task: "BE-01" }, human));
    expect(r.document.tasks.map((t) => t.id)).toEqual(["BE-02", "BE-03"]);
    expect(r.document.tasks[0]?.deps).toBeUndefined();
    expect(r.document.tasks[0]?.notes?.at(-1)?.text).toBe("Dependency BE-01 (BE-01) was deleted.");
    expect(r.changed.sort()).toEqual(["BE-01", "BE-02"]);
    expect(r.document.seq.BE).toBe(20); // the id is never reused
  });

  it("agents only delete tasks nobody started; humans delete any", () => {
    const d = doc(task("BE-01", "proposed"), task("BE-02", "todo"), task("BE-03", "doing"));
    expect(err(applyOp(d, { op: "delete", task: "BE-01" }, agent))).toBe("ok");
    expect(err(applyOp(d, { op: "delete", task: "BE-02" }, agent))).toBe("ok");
    expect(err(applyOp(d, { op: "delete", task: "BE-03" }, agent))).toBe("forbidden");
    expect(err(applyOp(d, { op: "delete", task: "BE-03" }, human))).toBe("ok");
    expect(err(applyOp(d, { op: "delete", task: "BE-09" }, human))).toBe("not_found");
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

  it("batch creates a task with idea: true as an idea and the rest in todo", () => {
    const d = doc(task("BE-01", "done"));
    const r = ok(
      applyOp(
        d,
        {
          op: "batch",
          tasks: [
            { title: "Now", group: "BE" },
            { title: "Maybe later", group: "BE", idea: true, deps: ["Now"] },
            { title: "Also now", group: "BE", idea: false },
          ],
        },
        agent,
      ),
    );
    expect(r.document.tasks.slice(1).map((t) => [t.title, t.state])).toEqual([
      ["Now", "todo"],
      ["Maybe later", "proposed"],
      ["Also now", "todo"],
    ]);
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

describe("move (CORE-11)", () => {
  const d = doc(
    task("BE-01", "todo", [], { rank: "c" }),
    task("BE-02", "todo", [], { rank: "i" }),
    task("BE-03", "todo", [], { rank: "r" }),
    task("BE-04", "done", [], { rank: "x" }),
  );
  const order = (r: OpResult) =>
    [...ok(r).document.tasks].sort((a, b) => (a.rank < b.rank ? -1 : 1)).map((t) => t.id);

  it("places a task right before or after another one, or first of all", () => {
    expect(order(applyOp(d, { op: "move", task: "BE-03", before: "BE-01" }, agent))).toEqual([
      "BE-03",
      "BE-01",
      "BE-02",
      "BE-04",
    ]);
    expect(order(applyOp(d, { op: "move", task: "BE-03", before: "BE-02" }, human))).toEqual([
      "BE-01",
      "BE-03",
      "BE-02",
      "BE-04",
    ]);
    expect(order(applyOp(d, { op: "move", task: "BE-01", after: "BE-02" }, agent))).toEqual([
      "BE-02",
      "BE-01",
      "BE-03",
      "BE-04",
    ]);
    expect(order(applyOp(d, { op: "move", task: "BE-01", after: "BE-04" }, agent))).toEqual([
      "BE-02",
      "BE-03",
      "BE-04",
      "BE-01",
    ]);
    expect(order(applyOp(d, { op: "move", task: "BE-03", top: true }, agent))).toEqual([
      "BE-03",
      "BE-01",
      "BE-02",
      "BE-04",
    ]);
  });

  it("changes only the rank of the moved task", () => {
    const r = ok(applyOp(d, { op: "move", task: "BE-03", before: "BE-02" }, agent));
    expect(r.changed).toEqual(["BE-03"]);
    for (const id of ["BE-01", "BE-02", "BE-04"])
      expect(r.document.tasks.find((t) => t.id === id)).toEqual(d.tasks.find((t) => t.id === id));
    const moved = r.document.tasks.find((t) => t.id === "BE-03") as Task;
    expect({ ...moved, rank: "r" }).toEqual(d.tasks[2]);
  });

  it("is a no-op when the task is already there", () => {
    for (const op of [
      { op: "move", task: "BE-01", before: "BE-02" },
      { op: "move", task: "BE-02", after: "BE-01" },
      { op: "move", task: "BE-01", top: true },
    ] as Op[]) {
      const r = ok(applyOp(d, op, agent));
      expect(r.changed).toEqual([]);
      expect(r.document).toEqual(d);
    }
  });

  it("needs exactly one placement, another task as anchor, and an existing one", () => {
    expect(err(applyOp(d, { op: "move", task: "BE-01" }, agent))).toBe("invalid");
    expect(err(applyOp(d, { op: "move", task: "BE-01", before: "BE-02", top: true }, agent))).toBe(
      "invalid",
    );
    expect(err(applyOp(d, { op: "move", task: "BE-01", before: "BE-01" }, agent))).toBe("invalid");
    expect(err(applyOp(d, { op: "move", task: "BE-01", after: "BE-99" }, agent))).toBe("not_found");
  });

  it("agents cannot reorder finished work; humans can", () => {
    expect(err(applyOp(d, { op: "move", task: "BE-04", top: true }, agent))).toBe("forbidden");
    expect(order(applyOp(d, { op: "move", task: "BE-04", top: true }, human))[0]).toBe("BE-04");
  });

  it("with tied ranks it still lands on the asked side of the anchor", () => {
    const tied = doc(
      task("BE-01", "todo", [], { rank: "i" }),
      task("BE-02", "todo", [], { rank: "i" }),
      task("BE-03", "todo", [], { rank: "r" }),
    );
    const r = ok(applyOp(tied, { op: "move", task: "BE-03", before: "BE-02" }, agent));
    const rank = (id: string) => r.document.tasks.find((t) => t.id === id)?.rank as string;
    expect(rank("BE-03") < rank("BE-02")).toBe(true);
    expect(validateDocument(r.document).ok).toBe(true);
  });

  it("any sequence of moves keeps the plan valid and the other ranks untouched", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            task: fc.constantFrom("BE-01", "BE-02", "BE-03", "BE-04"),
            anchor: fc.constantFrom("BE-01", "BE-02", "BE-03", "BE-04"),
            how: fc.constantFrom("before", "after", "top"),
          }),
          { maxLength: 30 },
        ),
        (moves) => {
          let current = d;
          for (const { task: id, anchor, how } of moves) {
            if (how !== "top" && anchor === id) continue;
            const op: Op =
              how === "top"
                ? { op: "move", task: id, top: true }
                : how === "before"
                  ? { op: "move", task: id, before: anchor }
                  : { op: "move", task: id, after: anchor };
            const r = ok(applyOp(current, op, human));
            expect(validateDocument(r.document).ok).toBe(true);
            const sorted = [...r.document.tasks].sort((a, b) => (a.rank < b.rank ? -1 : 1));
            const ids = sorted.map((t) => t.id);
            if (how === "top") expect(ids[0]).toBe(id);
            else if (how === "before") expect(ids.indexOf(id)).toBe(ids.indexOf(anchor) - 1);
            else expect(ids.indexOf(id)).toBe(ids.indexOf(anchor) + 1);
            current = r.document;
          }
        },
      ),
    );
  });
});

describe("preconditions (per-task hashes)", () => {
  const base = doc(task("BE-01", "proposed"), task("BE-02", "todo"));

  it("an op whose task changed returns conflict with the current task", () => {
    const seen = taskHash(base.tasks[0] as Task);
    const changed = ok(
      applyOp(base, { op: "note", task: "BE-01", text: "meanwhile" }, agent),
    ).document;
    const r = applyOp(changed, { op: "promote", task: "BE-01", expect: { "BE-01": seen } }, human);
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
        applyOp(other, { op: "promote", task: "BE-01", expect: { "BE-01": seen } }, human),
        "BE-01",
      ),
    ).toBe("todo");
  });

  it("a task that disappeared is a conflict too", () => {
    expect(
      err(applyOp(base, { op: "promote", task: "BE-01", expect: { "BE-09": "sha256:x" } }, human)),
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
      fc.record({ op: fc.constant("delete" as const), task: id }),
      fc.record({ op: fc.constant("promote" as const), task: id }),
      fc.record({ op: fc.constant("depend" as const), task: id, on: id }),
      fc.record({ op: fc.constant("undepend" as const), task: id, on: id }),
      fc.record({
        op: fc.constant("edit" as const),
        task: id,
        changes: fc.constant({ title: "edited" }),
      }),
      // Human-only ops must also be refused when an agent tries them.
      fc.record({ op: fc.constant("reopen" as const), task: id }),
      fc.record({ op: fc.constant("answer" as const), task: id, text: fc.constant("x") }),
      fc.record({
        op: fc.constant("set-templates" as const),
        templates: fc.constant([{ id: "bug", name: "Bug" }]),
      }),
    ) as fc.Arbitrary<Op>;
  };

  it("agents never touch done work and reach done only by finishing; results stay valid", () => {
    fc.assert(
      fc.property(
        documentArb.chain((d) =>
          fc.tuple(fc.constant(d), fc.array(agentOps(d.tasks.map((t) => t.id)), { maxLength: 25 })),
        ),
        fc.constantFrom<OpContext>(agent, runner),
        ([start, ops], ctx) => {
          let cur = start;
          for (const op of ops) {
            const r = applyOp(cur, op, ctx);
            if (!r.ok) continue;
            const before = new Map(cur.tasks.map((t) => [t.id, t]));
            for (const t of r.document.tasks) {
              const prev = before.get(t.id);
              if (prev === undefined) expect(t.state).toBe("todo");
              else if (prev.state === "done") expect(t).toEqual(prev);
              else if (t.state === "done") expect([prev.state, op.op]).toEqual(["doing", "finish"]);
            }
            for (const prev of cur.tasks.filter((t) => t.state === "done"))
              expect(r.document.tasks.some((t) => t.id === prev.id)).toBe(true);
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
    const original = task("BE-01", "todo");
    const changed = doc({ ...original, state: "done", title: "Hand edit" });
    const restored = ok(
      applyOp(changed, { op: "restore", task: "BE-01", version: original }, human),
    ).document;
    expect(restored.tasks[0]).toMatchObject({ state: "todo", title: "BE-01", updated_at: at });
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

describe("templates (CORE-10)", () => {
  const bug = {
    id: "bug",
    name: "Bug fix",
    desc: "Reproduce, fix and cover with a test.",
    acceptance: [{ text: "A test reproduces the bug" }, { text: "Fixed" }],
    labels: ["bug", "fix"],
  };
  const base = doc(task("BE-01", "todo"));
  const withTemplates = ok(
    applyOp(base, { op: "set-templates", templates: [bug] }, human),
  ).document;

  it("set-templates is the human's only, replaces them all and [] removes them", () => {
    const op: Op = { op: "set-templates", templates: [bug] };
    expect(err(applyOp(base, op, agent))).toBe("forbidden");
    expect(err(applyOp(base, op, runner))).toBe("forbidden");
    expect(withTemplates.project.templates).toEqual([bug]);
    const other = { id: "spike", name: "Spike" };
    expect(
      ok(applyOp(withTemplates, { op: "set-templates", templates: [other] }, human)).document
        .project.templates,
    ).toEqual([other]);
    expect(
      ok(applyOp(withTemplates, { op: "set-templates", templates: [] }, human)).document.project,
    ).not.toHaveProperty("templates");
  });

  it("set-templates validates unique ids and the templates' fields", () => {
    const dup = applyOp(
      base,
      { op: "set-templates", templates: [bug, { ...bug, name: "Other" }] },
      human,
    );
    expect(err(dup)).toBe("invalid");
    expect(dup.ok ? [] : dup.error.issues?.map((i) => i.code)).toContain("duplicate_template_id");
    const badId = {
      op: "set-templates",
      templates: [{ id: "Bug Fix", name: "x" }],
    } as unknown as Op;
    expect(err(applyOp(base, badId, human))).toBe("invalid");
    const badLabels = { ...bug, labels: ["bug", "bug"] };
    expect(err(applyOp(base, { op: "set-templates", templates: [badLabels] }, human))).toBe(
      "invalid",
    );
  });

  it("propose with a template takes its values; explicit ones complete or replace them", () => {
    const plain = ok(
      applyOp(
        withTemplates,
        { op: "propose", title: "Crash", group: "BE", template: "bug" },
        agent,
      ),
    ).document.tasks.at(-1);
    expect(plain).toMatchObject({
      desc: bug.desc,
      acceptance: [
        { id: "ac1", text: "A test reproduces the bug" },
        { id: "ac2", text: "Fixed" },
      ],
      labels: ["bug", "fix"],
    });
    const mixed = ok(
      applyOp(
        withTemplates,
        {
          op: "propose",
          title: "Crash",
          group: "BE",
          template: "bug",
          desc: "Own description",
          acceptance: ["No regression"],
          labels: ["fix", "ui"],
        },
        agent,
      ),
    ).document.tasks.at(-1);
    expect(mixed).toMatchObject({
      desc: "Own description",
      acceptance: [
        { id: "ac1", text: "A test reproduces the bug" },
        { id: "ac2", text: "Fixed" },
        { id: "ac3", text: "No regression" },
      ],
      labels: ["bug", "fix", "ui"],
    });
  });

  it("batch tasks can each use a template", () => {
    const batch = ok(
      applyOp(
        withTemplates,
        {
          op: "batch",
          tasks: [
            { title: "A", group: "BE", template: "bug" },
            { title: "B", group: "BE", acceptance: ["Own"] },
          ],
        },
        agent,
      ),
    ).document;
    expect(batch.tasks.map((t) => t.acceptance?.length ?? 0)).toEqual([0, 2, 1]);
    expect(batch.tasks[2]?.labels).toBeUndefined();
  });

  it("an unknown template is refused with its own code and writes nothing", () => {
    const r = applyOp(
      withTemplates,
      { op: "propose", title: "X", group: "BE", template: "feature" },
      agent,
    );
    expect(err(r)).toBe("unknown_template");
    expect(r.ok ? "" : r.error.message).toBe('Template "feature" does not exist');
    const b = applyOp(
      withTemplates,
      {
        op: "batch",
        tasks: [
          { title: "A", group: "BE" },
          { title: "B", group: "BE", template: "nope" },
        ],
      },
      agent,
    );
    expect(err(b)).toBe("unknown_template");
    expect(
      err(applyOp(base, { op: "propose", title: "X", group: "BE", template: "bug" }, agent)),
    ).toBe("unknown_template");
  });
});

describe("planning sessions (CLI-05)", () => {
  const planner: OpContext = { ...agent, plan: true };
  const d = doc(task("BE-01", "todo"), task("BE-02", "proposed"), task("BE-03", "doing"));

  it("lets the agent create, revise and delete tasks nobody started", () => {
    const allowed: Op[] = [
      { op: "propose", title: "N", group: "BE" },
      { op: "batch", tasks: [{ title: "N", group: "BE" }] },
      { op: "edit", task: "BE-01", changes: { title: "Better" } },
      { op: "edit", task: "BE-02", changes: { title: "Better" } },
      { op: "depend", task: "BE-02", on: "BE-01" },
      { op: "promote", task: "BE-02" },
      { op: "delete", task: "BE-02" },
    ];
    for (const op of allowed) expect(err(applyOp(d, op, planner)), op.op).toBe("ok");
  });

  it("refuses everything else, and any change to started work", () => {
    const refused: Op[] = [
      { op: "start", task: "BE-01" },
      { op: "note", task: "BE-02", text: "x" },
      { op: "ask", task: "BE-03", text: "x" },
      { op: "finish", task: "BE-03", summary: "x" },
      { op: "pause", task: "BE-03" },
      { op: "add-group", id: "OPS", name: "Ops" },
      { op: "edit", task: "BE-03", changes: { title: "Hijack" } },
      { op: "delete", task: "BE-03" },
    ];
    for (const op of refused) expect(err(applyOp(d, op, planner)), op.op).toBe("out_of_scope");
    const r = applyOp(d, { op: "start", task: "BE-01" }, planner);
    expect(r.ok ? "" : r.error.message).toContain("planning session");
  });

  it("does not limit humans", () => {
    expect(err(applyOp(d, { op: "reopen", task: "BE-03" }, { ...human, plan: true }))).toBe(
      "invalid_transition",
    );
    expect(err(applyOp(d, { op: "delete", task: "BE-03" }, { ...human, plan: true }))).toBe("ok");
  });
});
