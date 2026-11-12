import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  blockers,
  dependentsOf,
  deriveFlags,
  indexTasks,
  isReady,
  isWaiting,
  pendingSubgraph,
  topoOrder,
  transitiveDependents,
  transitiveDeps,
} from "../src/graph.ts";
import type { Note, Task, TaskState } from "../src/schema.ts";
import { documentArb, scramble } from "./arbitraries.ts";

const at = "2026-11-02T10:00:00Z";
function task(id: string, state: TaskState, deps: string[] = [], extra: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    state,
    group: id.split("-")[0] as string,
    ...(deps.length ? { deps } : {}),
    rank: "a0",
    created: { at, by: "human" },
    updated_at: at,
    ...extra,
  };
}
const note = (id: string, kind: Note["kind"]): Note => ({ id, at, by: "human", kind, text: kind });

// A ── B ── D        E (independent)
//  └── C ──┘
const tasks = [
  task("T-01", "done"),
  task("T-02", "doing", ["T-01"]),
  task("T-03", "done", ["T-01"]),
  task("T-04", "todo", ["T-02", "T-03"]),
  task("T-05", "todo"),
  task("T-06", "proposed", ["T-04"]),
];
const doc = { tasks };
const index = indexTasks(doc);
const get = (id: string) => index.get(id) as Task;

describe("blockers / ready", () => {
  it("a dependency in progress still blocks; only done unblocks", () => {
    expect(blockers(get("T-04"), index)).toEqual(["T-02"]);
    expect(isReady(get("T-04"), index)).toBe(false);
  });

  it("todo without deps is ready; other states are never ready or blocked", () => {
    expect(isReady(get("T-05"), index)).toBe(true);
    expect(blockers(get("T-06"), index)).toEqual([]);
    expect(isReady(get("T-06"), index)).toBe(false);
  });

  it("a missing dependency counts as unmet", () => {
    const orphan = task("T-09", "todo", ["T-99"]);
    expect(blockers(orphan, indexTasks({ tasks: [orphan] }))).toEqual(["T-99"]);
  });

  it("property: ready ⇔ todo and every dep done", () => {
    fc.assert(
      fc.property(documentArb, (d) => {
        const idx = indexTasks(d);
        const flags = deriveFlags(d);
        for (const t of d.tasks) {
          const expected =
            t.state === "todo" && (t.deps ?? []).every((id) => idx.get(id)?.state === "done");
          expect(flags.get(t.id)?.ready).toBe(expected);
          expect(isReady(t, idx)).toBe(expected);
          expect(flags.get(t.id)?.blocked).toBe(t.state === "todo" && !expected);
        }
      }),
    );
  });
});

describe("isWaiting", () => {
  it.each([
    [[], false],
    [[note("n1", "question")], true],
    [[note("n1", "question"), note("n2", "note")], true],
    [[note("n1", "question"), note("n2", "answer")], false],
    [[note("n1", "question"), note("n2", "answer"), note("n3", "question")], true],
    [[note("n1", "answer")], false],
  ] as const)("%j → %s", (notes, expected) => {
    expect(isWaiting(task("T-01", "doing", [], { notes: [...notes] }))).toBe(expected);
  });
});

describe("dependencies", () => {
  it("direct and transitive dependencies and dependents", () => {
    expect(dependentsOf("T-01", doc)).toEqual(["T-02", "T-03"]);
    expect([...transitiveDeps("T-06", index)].sort()).toEqual(["T-01", "T-02", "T-03", "T-04"]);
    expect([...transitiveDependents("T-01", doc)].sort()).toEqual(["T-02", "T-03", "T-04", "T-06"]);
    expect(transitiveDeps("T-05", index).size).toBe(0);
  });

  it("terminates on cycles and never includes the start", () => {
    const cyc = indexTasks({
      tasks: [task("T-01", "todo", ["T-02"]), task("T-02", "todo", ["T-01"])],
    });
    expect([...transitiveDeps("T-01", cyc)]).toEqual(["T-02"]);
  });

  it("property: transitive deps are closed under deps", () => {
    fc.assert(
      fc.property(documentArb, (d) => {
        const idx = indexTasks(d);
        for (const t of d.tasks) {
          const all = transitiveDeps(t.id, idx);
          for (const dep of t.deps ?? []) expect(all.has(dep)).toBe(true);
          for (const id of all)
            for (const dep of idx.get(id)?.deps ?? []) expect(all.has(dep)).toBe(true);
        }
      }),
    );
  });
});

describe("topoOrder", () => {
  it("puts dependencies first and breaks ties by rank, then natural id", () => {
    const ranked = [
      task("A-10", "todo", [], { rank: "b" }),
      task("A-02", "todo", [], { rank: "b" }),
      task("A-03", "todo", [], { rank: "a" }),
      task("A-04", "todo", ["A-10"], { rank: "0" }),
    ];
    expect(topoOrder({ tasks: ranked })).toEqual({
      order: ["A-03", "A-02", "A-10", "A-04"],
      cyclic: [],
    });
  });

  it("reports tasks it cannot order because of a cycle", () => {
    const cyc = [
      task("T-01", "todo", ["T-02"]),
      task("T-02", "todo", ["T-01"]),
      task("T-03", "todo"),
    ];
    expect(topoOrder({ tasks: cyc })).toEqual({ order: ["T-03"], cyclic: ["T-01", "T-02"] });
  });

  it("property: a permutation where every dependency comes first", () => {
    fc.assert(
      fc.property(documentArb, (d) => {
        const { order, cyclic } = topoOrder(d);
        expect(cyclic).toEqual([]);
        expect([...order].sort()).toEqual(d.tasks.map((t) => t.id).sort());
        const position = new Map(order.map((id, i) => [id, i]));
        for (const t of d.tasks) {
          for (const dep of t.deps ?? []) {
            expect(position.get(dep) as number).toBeLessThan(position.get(t.id) as number);
          }
        }
      }),
    );
  });

  it("property: independent of the order of the tasks array", () => {
    fc.assert(
      fc.property(documentArb, fc.integer({ min: 1 }), (d, seed) => {
        expect(topoOrder(scramble(d, seed)).order).toEqual(topoOrder(d).order);
      }),
    );
  });
});

describe("pendingSubgraph", () => {
  //  D-01 (done) ── D-02 (todo) ── D-04 (todo) ── D-05 (todo)
  //  D-03 (doing) ────────────────────┘             │
  //  D-06 (done) ── D-07 (proposed) ────────────────┘
  //  D-00 (todo) ── D-06 (behind a done task: not needed)
  const doc = {
    tasks: [
      task("D-00", "todo"),
      task("D-01", "done"),
      task("D-02", "todo", ["D-01"]),
      task("D-03", "doing"),
      task("D-04", "todo", ["D-02", "D-03"]),
      task("D-06", "done", ["D-00"]),
      task("D-07", "proposed", ["D-06"]),
      task("D-05", "todo", ["D-04", "D-07"]),
    ],
  };

  it("is the task plus its unfinished dependencies, dependencies first", () => {
    expect(pendingSubgraph("D-05", doc)).toEqual(["D-02", "D-03", "D-04", "D-07", "D-05"]);
    expect(pendingSubgraph("D-04", doc)).toEqual(["D-02", "D-03", "D-04"]);
  });

  it("does not follow dependencies through a done task", () => {
    expect(pendingSubgraph("D-07", doc)).toEqual(["D-07"]);
    expect(pendingSubgraph("D-05", doc)).not.toContain("D-00");
  });

  it("is just the task when nothing it needs is pending", () => {
    expect(pendingSubgraph("D-02", doc)).toEqual(["D-02"]);
    expect(pendingSubgraph("D-00", doc)).toEqual(["D-00"]);
  });

  it("is empty for a done or unknown task", () => {
    expect(pendingSubgraph("D-01", doc)).toEqual([]);
    expect(pendingSubgraph("X-99", doc)).toEqual([]);
  });

  it("never lists a done task and always closes over pending deps (property)", () => {
    fc.assert(
      fc.property(documentArb, (generated) => {
        const index = indexTasks(generated);
        for (const t of generated.tasks) {
          const sub = pendingSubgraph(t.id, generated);
          const set = new Set(sub);
          for (const id of sub) {
            const member = index.get(id);
            expect(member?.state).not.toBe("done");
            for (const dep of member?.deps ?? [])
              if (index.get(dep) && index.get(dep)?.state !== "done")
                expect(set.has(dep)).toBe(true);
          }
        }
      }),
    );
  });
});
