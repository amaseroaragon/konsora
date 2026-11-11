// biome-ignore-all lint/suspicious/noExplicitAny: fixtures are mutated into deliberately invalid shapes.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findDuplicateKeys, MAX_DOCUMENT_BYTES, parseJsonText } from "../src/json-text.ts";
import type { Task, TasksDocument } from "../src/schema.ts";
import { parseTasksFile, validateDocument, validateSemantics } from "../src/semantics.ts";

const at = "2026-11-02T10:00:00Z";
function task(id: string, deps: string[] = [], extra: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    state: "todo",
    group: id.split("-")[0] as string,
    ...(deps.length ? { deps } : {}),
    rank: "a0",
    created: { at, by: "human" },
    updated_at: at,
    ...extra,
  };
}

function doc(): TasksDocument {
  return {
    schema: "konsora/4",
    project: { name: "Demo" },
    groups: [
      { id: "BE", name: "Backend" },
      { id: "FE", name: "Frontend" },
    ],
    seq: { BE: 3, FE: 1 },
    tasks: [
      task("BE-01"),
      task("BE-02", ["BE-01"]),
      task("BE-03", ["BE-02"]),
      task("FE-01", ["BE-02"]),
    ],
  };
}

function issuesAfter(mutate: (d: any) => void) {
  const d = structuredClone(doc()) as any;
  mutate(d);
  return validateSemantics(d);
}

describe("validateSemantics", () => {
  it("accepts a consistent document", () => {
    expect(validateSemantics(doc())).toEqual([]);
  });

  it("accepts this repository's backlog", () => {
    const text = readFileSync(new URL("../../../.konsora/tasks.json", import.meta.url), "utf8");
    const result = parseTasksFile(text);
    expect(result.ok ? [] : result.issues).toEqual([]);
  });

  it.each([
    [
      "duplicate group",
      (d: any) => d.groups.push({ id: "BE", name: "Again" }),
      "/groups/2/id",
      "duplicate_group",
    ],
    ["seq for unknown group", (d: any) => (d.seq.OPS = 0), "/seq/OPS", "seq_unknown_group"],
    ["duplicate task id", (d: any) => d.tasks.push(task("BE-01")), "/tasks/4/id", "duplicate_id"],
    [
      "task in unknown group",
      (d: any) => (d.tasks[0].group = "OPS"),
      "/tasks/0/group",
      "unknown_group",
    ],
    [
      "id prefix is not a group",
      (d: any) => d.tasks.push(task("OPS-01", [], { group: "BE" })),
      "/tasks/4/id",
      "unknown_id_prefix",
    ],
    ["seq behind highest id", (d: any) => (d.seq.BE = 2), "/seq/BE", "seq_behind"],
    ["seq missing for used group", (d: any) => delete d.seq.FE, "/seq", "seq_missing"],
    [
      "self dependency",
      (d: any) => (d.tasks[0].deps = ["BE-01"]),
      "/tasks/0/deps/0",
      "self_dependency",
    ],
    [
      "unknown dependency",
      (d: any) => (d.tasks[0].deps = ["BE-99"]),
      "/tasks/0/deps/0",
      "unknown_dependency",
    ],
    [
      "duplicate dependency",
      (d: any) => (d.tasks[2].deps = ["BE-02", "BE-02"]),
      "/tasks/2/deps/1",
      "duplicate_dependency",
    ],
    [
      "duplicate label",
      (d: any) => (d.tasks[0].labels = ["ui", "ui"]),
      "/tasks/0/labels/1",
      "duplicate_label",
    ],
    [
      "duplicate acceptance id",
      (d: any) =>
        (d.tasks[0].acceptance = [
          { id: "ac1", text: "a" },
          { id: "ac1", text: "b" },
        ]),
      "/tasks/0/acceptance/1/id",
      "duplicate_acceptance_id",
    ],
    [
      "duplicate note id",
      (d: any) =>
        (d.tasks[0].notes = [
          { id: "n1", at, by: "human", kind: "note", text: "a" },
          { id: "n1", at, by: "human", kind: "note", text: "b" },
        ]),
      "/tasks/0/notes/1/id",
      "duplicate_note_id",
    ],
    [
      "task in an unknown block",
      (d: any) => Object.assign(d.tasks[0], { block: "nope" }),
      "/tasks/0/block",
      "unknown_block",
    ],
    ["two-task cycle", (d: any) => (d.tasks[0].deps = ["BE-02"]), "/tasks/0/deps", "cycle"],
  ])("rejects %s", (_name, mutate, path, code) => {
    expect(issuesAfter(mutate)).toContainEqual(expect.objectContaining({ path, code }));
  });

  it("names the tasks of a cycle in order and reports it once", () => {
    const issues = issuesAfter((d) => (d.tasks[0].deps = ["BE-03"]));
    const cycles = issues.filter((i) => i.code === "cycle");
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.message).toBe("Dependency cycle: BE-01 → BE-03 → BE-02 → BE-01");
  });

  it("reports independent cycles separately and ignores tasks that only lead into them", () => {
    const issues = issuesAfter((d) => {
      d.tasks[0].deps = ["BE-02"]; // BE-01 ⇄ BE-02
      d.tasks.push(task("FE-02", ["FE-03"]), task("FE-03", ["FE-02"]));
      d.seq.FE = 3;
    });
    const messages = issues.filter((i) => i.code === "cycle").map((i) => i.message);
    expect(messages).toEqual([
      "Dependency cycle: BE-01 → BE-02 → BE-01",
      "Dependency cycle: FE-02 → FE-03 → FE-02",
    ]);
  });

  it("handles a 5000-task chain without recursion limits", () => {
    const tasks = Array.from({ length: 5000 }, (_, i) =>
      task(
        `BE-${String(i + 1).padStart(4, "0")}`,
        i === 0 ? [] : [`BE-${String(i).padStart(4, "0")}`],
      ),
    );
    const d = { ...doc(), seq: { BE: 5000 }, tasks };
    expect(validateSemantics(d)).toEqual([]);
    (tasks[0] as Task).deps = ["BE-5000"];
    expect(validateSemantics(d).filter((i) => i.code === "cycle")).toHaveLength(1);
  });

  it("validates a 2000-task document (structure + semantics) in < 200 ms", () => {
    const tasks = Array.from({ length: 2000 }, (_, i) => {
      const n = i + 1;
      const deps = [n - 1, n - 7, n - 31]
        .filter((m) => m >= 1)
        .map((m) => `BE-${String(m).padStart(4, "0")}`);
      return task(`BE-${String(n).padStart(4, "0")}`, deps, {
        desc: "Lorem ".repeat(40),
        acceptance: [{ id: "ac1", text: "Works" }],
        notes: [{ id: "n1", at, by: "agent:claude", kind: "note", text: "Progress" }],
      });
    });
    const value = JSON.parse(JSON.stringify({ ...doc(), seq: { BE: 2000, FE: 0 }, tasks }));
    validateDocument(value); // warm up the JIT
    const start = performance.now();
    const result = validateDocument(value);
    const elapsed = performance.now() - start;
    expect(result.ok).toBe(true);
    expect(elapsed).toBeLessThan(200);
  });
});

describe("parseJsonText / parseTasksFile", () => {
  it("rejects duplicate keys with their JSON Pointer", () => {
    const result = parseJsonText('{"a": 1, "b": {"c": [{"d": 1, "d": 2}]}, "a": 3}');
    expect(result.ok ? [] : result.issues.map((i) => [i.path, i.code])).toEqual([
      ["/b/c/0/d", "duplicate_key"],
      ["/a", "duplicate_key"],
    ]);
  });

  it("is not fooled by braces, commas or quotes inside strings", () => {
    expect(findDuplicateKeys('{"a": "x,\\"}{y", "b": ["{", ","], "c": {"a": 1}}')).toEqual([]);
  });

  it("rejects invalid JSON, invalid UTF-8 and oversized files", () => {
    const code = (r: ReturnType<typeof parseJsonText>) => (r.ok ? "ok" : r.issues[0]?.code);
    expect(code(parseJsonText("{ nope"))).toBe("invalid_json");
    expect(code(parseJsonText(new Uint8Array([0x7b, 0xff, 0x7d])))).toBe("invalid_utf8");
    expect(code(parseJsonText(new Uint8Array(MAX_DOCUMENT_BYTES + 1)))).toBe("too_large");
  });

  it("accepts a UTF-8 BOM", () => {
    expect(parseJsonText('﻿{"a": 1}')).toEqual({ ok: true, value: { a: 1 } });
  });

  it("runs structure before semantics and stops at structural errors", () => {
    const result = parseTasksFile(JSON.stringify({ ...doc(), extra: true, seq: { BE: 0, FE: 0 } }));
    expect(result.ok ? [] : result.issues.map((i) => i.code)).toEqual(["unrecognized_keys"]);
  });
});
