// biome-ignore-all lint/suspicious/noExplicitAny: fixtures are mutated into deliberately invalid shapes.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { tasksJsonSchema, tasksJsonSchemaText } from "../src/json-schema.ts";
import { type TasksDocument, toPointer, validateStructure } from "../src/schema.ts";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

function valid(): TasksDocument {
  return {
    schema: "konsora/5",
    project: { name: "Demo" },
    groups: [{ id: "BE", name: "Backend" }],
    seq: { BE: 1 },
    tasks: [
      {
        id: "BE-01",
        title: "Proxy forecast endpoint",
        state: "todo",
        group: "BE",
        rank: "a0",
        created: { at: "2026-11-02T10:00:00Z", by: "human" },
        updated_at: "2026-11-02T10:00:00Z",
      },
    ],
  };
}

/** Applies a mutation to a fresh valid document and returns the issues. */
function issuesAfter(mutate: (doc: Record<string, any>) => void) {
  const doc = structuredClone(valid()) as Record<string, any>;
  mutate(doc);
  const result = validateStructure(doc);
  return result.ok ? [] : result.issues;
}

describe("validateStructure", () => {
  it("accepts a minimal document", () => {
    expect(validateStructure(valid())).toEqual({ ok: true, document: valid() });
  });

  it("accepts the example in docs/esquema-tareas.md", () => {
    const markdown = read("docs/esquema-tareas.md");
    const example = /```json\n([\s\S]*?)\n```/.exec(markdown)?.[1];
    expect(example).toBeDefined();
    const result = validateStructure(JSON.parse(example as string));
    expect(result.ok ? [] : result.issues).toEqual([]);
  });

  it("accepts this repository's .konsora/tasks.json", () => {
    const result = validateStructure(JSON.parse(read(".konsora/tasks.json")));
    expect(result.ok ? [] : result.issues).toEqual([]);
  });

  it("keeps x-* extension keys untouched", () => {
    const doc = { ...valid(), "x-editor": { zoom: 2 } };
    doc.tasks[0] = { ...doc.tasks[0], "x-color": "red" } as never;
    const result = validateStructure(doc);
    expect(result.ok && result.document).toMatchObject({ "x-editor": { zoom: 2 } });
    expect(result.ok && result.document.tasks[0]).toMatchObject({ "x-color": "red" });
  });

  it("does not mutate or reorder the input", () => {
    const doc = valid();
    const before = JSON.stringify(doc);
    validateStructure(doc);
    expect(JSON.stringify(doc)).toBe(before);
  });

  it.each([
    ["unknown root key", (d: any) => (d.extra = 1), "/extra"],
    ["unknown task key", (d: any) => (d.tasks[0].status = "todo"), "/tasks/0/status"],
    ["wrong schema version", (d: any) => (d.schema = "konsora/1"), "/schema"],
    ["no groups", (d: any) => (d.groups = []), "/groups"],
    ["lowercase group id", (d: any) => (d.groups[0].id = "be"), "/groups/0/id"],
    ["group id too long", (d: any) => (d.groups[0].id = "BACKEND"), "/groups/0/id"],
    ["task id without number", (d: any) => (d.tasks[0].id = "BE-X"), "/tasks/0/id"],
    ["task id with one digit", (d: any) => (d.tasks[0].id = "BE-1"), "/tasks/0/id"],
    ["blank title", (d: any) => (d.tasks[0].title = "   "), "/tasks/0/title"],
    ["title too long", (d: any) => (d.tasks[0].title = "x".repeat(121)), "/tasks/0/title"],
    ["v1 state name", (d: any) => (d.tasks[0].state = "pending"), "/tasks/0/state"],
    ["derived state stored", (d: any) => (d.tasks[0].state = "blocked"), "/tasks/0/state"],
    ["uppercase rank", (d: any) => (d.tasks[0].rank = "A0"), "/tasks/0/rank"],
    ["dep with bad id", (d: any) => (d.tasks[0].deps = ["be-01"]), "/tasks/0/deps/0"],
    ["yolo from v3", (d: any) => (d.tasks[0].yolo = true), "/tasks/0/yolo"],
    ["review state from v3", (d: any) => (d.tasks[0].state = "review"), "/tasks/0/state"],
    ["label with spaces", (d: any) => (d.tasks[0].labels = ["needs review"]), "/tasks/0/labels/0"],
    [
      "local timestamp",
      (d: any) => (d.tasks[0].updated_at = "2026-11-02T10:00:00+01:00"),
      "/tasks/0/updated_at",
    ],
    [
      "timestamp with ms",
      (d: any) => (d.tasks[0].updated_at = "2026-11-02T10:00:00.120Z"),
      "/tasks/0/updated_at",
    ],
    [
      "impossible date",
      (d: any) => (d.tasks[0].created.at = "2026-02-30T10:00:00Z"),
      "/tasks/0/created/at",
    ],
    ["unknown actor", (d: any) => (d.tasks[0].created.by = "claude"), "/tasks/0/created/by"],
    [
      "run-only task field from v2",
      (d: any) => (d.tasks[0].agent = { provider: "claude", model: "x" }),
      "/tasks/0/agent",
    ],
    [
      "acceptance id",
      (d: any) => (d.tasks[0].acceptance = [{ id: "1", text: "x" }]),
      "/tasks/0/acceptance/0/id",
    ],
    [
      "note kind",
      (d: any) =>
        (d.tasks[0].notes = [
          { id: "n1", at: "2026-11-02T10:00:00Z", by: "human", kind: "comment", text: "x" },
        ]),
      "/tasks/0/notes/0/kind",
    ],
    ["negative seq", (d: any) => (d.seq.BE = -1), "/seq/BE"],
    ["fractional seq", (d: any) => (d.seq.BE = 1.5), "/seq/BE"],
    [
      "run-only field from v2",
      (d: any) => (d.project.checks = [{ id: "test", run: "npm test" }]),
      "/project/checks",
    ],
  ])("rejects %s at its JSON Pointer", (_name, mutate, path) => {
    const issues = issuesAfter(mutate);
    expect(issues.map((issue) => issue.path)).toContain(path);
    for (const issue of issues) expect(issue.message.length).toBeGreaterThan(0);
  });

  it("rejects non-objects without throwing", () => {
    for (const value of [null, 42, "x", [], undefined]) {
      expect(validateStructure(value).ok).toBe(false);
    }
  });
});

describe("toPointer", () => {
  it("escapes ~ and / as RFC 6901 requires", () => {
    expect(toPointer(["tasks", 0, "a/b~c"])).toBe("/tasks/0/a~1b~0c");
    expect(toPointer([])).toBe("");
  });
});

describe("JSON Schema", () => {
  it("committed schema/tasks.v5.schema.json is up to date (run `npm run schema`)", () => {
    expect(read("schema/tasks.v5.schema.json")).toBe(tasksJsonSchemaText());
  });

  it("only allows x-* extension keys on every object", () => {
    const objects: Record<string, unknown>[] = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === "object") {
        const obj = node as Record<string, unknown>;
        if (obj.type === "object" && obj.properties) objects.push(obj);
        Object.values(obj).forEach(walk);
      }
    };
    walk(tasksJsonSchema());
    expect(objects.length).toBeGreaterThanOrEqual(9);
    for (const obj of objects) {
      expect(obj.additionalProperties).toBe(false);
      expect(obj.patternProperties).toEqual({ "^x-": {} });
    }
  });
});
