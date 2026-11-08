import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Task, TasksDocument } from "../src/schema.ts";
import { parseTasksFile, validateDocument } from "../src/semantics.ts";
import { canonicalize, compareTaskIds, serializeDocument } from "../src/serialize.ts";
import { documentArb, scramble } from "./arbitraries.ts";

const parse = (text: string): TasksDocument => {
  const result = parseTasksFile(text);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.document;
};

describe("generators", () => {
  it("only produce valid documents", () => {
    fc.assert(
      fc.property(documentArb, (doc) => {
        const result = validateDocument(doc);
        expect(result.ok ? [] : result.issues).toEqual([]);
      }),
    );
  });
});

describe("serializeDocument", () => {
  it("round-trips: serialize(parse(x)) === x for canonical text", () => {
    fc.assert(
      fc.property(documentArb, (doc) => {
        const text = serializeDocument(doc);
        expect(serializeDocument(parse(text))).toBe(text);
      }),
    );
  });

  it("is independent of key order, array order of tasks/deps/labels and empty optionals", () => {
    fc.assert(
      fc.property(documentArb, fc.integer({ min: 1 }), (doc, seed) => {
        expect(serializeDocument(scramble(doc, seed))).toBe(serializeDocument(doc));
      }),
    );
  });

  it("preserves meaning: canonical form equals the input up to ordering", () => {
    fc.assert(
      fc.property(documentArb, (doc) => {
        const canonical = canonicalize(doc);
        const byId = (d: TasksDocument) =>
          Object.fromEntries(
            d.tasks.map((t) => [
              t.id,
              {
                ...t,
                deps: [...(t.deps ?? [])].sort(),
                labels: [...(t.labels ?? [])].sort(),
              },
            ]),
          );
        expect(byId(canonical)).toEqual(byId(doc));
        expect(canonical.groups).toEqual(doc.groups);
      }),
    );
  });

  it("writes LF, 2-space indentation, a trailing newline and no BOM", () => {
    fc.assert(
      fc.property(documentArb, (doc) => {
        const text = serializeDocument(doc);
        expect(text.endsWith("}\n")).toBe(true);
        expect(text).not.toMatch(/\r|\t|^﻿/);
        expect(text.split("\n")[1]).toMatch(/^ {2}"/);
      }),
    );
  });

  it("adding a task (seq already ahead) changes one contiguous block of lines", () => {
    fc.assert(
      fc.property(documentArb, (doc) => {
        const group = doc.groups[0]?.id as string;
        const next = (doc.seq[group] ?? 0) + 1;
        const withSeq: TasksDocument = { ...doc, seq: { ...doc.seq, [group]: next } };
        const added: Task = {
          id: `${group}-${String(next).padStart(2, "0")}`,
          title: "Added task",
          state: "proposed",
          group,
          rank: "zz",
          created: { at: "2030-01-01T00:00:00Z", by: "agent:claude" },
          updated_at: "2030-01-01T00:00:00Z",
        };
        const before = serializeDocument(withSeq).split("\n");
        const after = serializeDocument({ ...withSeq, tasks: [...withSeq.tasks, added] }).split(
          "\n",
        );
        let prefix = 0;
        while (before[prefix] === after[prefix]) prefix++;
        let suffix = 0;
        while (
          suffix < before.length - prefix &&
          before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
        ) {
          suffix++;
        }
        const removed = before.slice(prefix, before.length - suffix);
        // At most the previous closing brace gains a comma; everything else is inserted.
        expect(removed.length).toBeLessThanOrEqual(1);
        expect(after.length - before.length).toBeGreaterThan(5);
      }),
    );
  });

  it("orders tasks by group order then id number, deps naturally, labels alphabetically", () => {
    const doc = parse(
      JSON.stringify({
        schema: "konsora/2",
        project: { name: "P", base_branch: "main" },
        groups: [
          { id: "UI", name: "UI" },
          { id: "BE", name: "BE" },
        ],
        seq: { BE: 100, UI: 2 },
        tasks: [
          {
            id: "BE-100",
            title: "c",
            state: "todo",
            group: "BE",
            rank: "a",
            created: { at: "2030-01-01T00:00:00Z", by: "human" },
            updated_at: "2030-01-01T00:00:00Z",
          },
          {
            id: "BE-99",
            title: "b",
            state: "todo",
            group: "BE",
            rank: "a",
            created: { at: "2030-01-01T00:00:00Z", by: "human" },
            updated_at: "2030-01-01T00:00:00Z",
          },
          {
            id: "UI-02",
            title: "a",
            state: "todo",
            group: "UI",
            deps: ["BE-100", "BE-99", "UI-01"],
            labels: ["zeta", "alpha"],
            rank: "a",
            created: { at: "2030-01-01T00:00:00Z", by: "human" },
            updated_at: "2030-01-01T00:00:00Z",
          },
          {
            id: "UI-01",
            title: "a",
            state: "todo",
            group: "UI",
            rank: "a",
            created: { at: "2030-01-01T00:00:00Z", by: "human" },
            updated_at: "2030-01-01T00:00:00Z",
          },
        ],
      }),
    );
    const canonical = canonicalize(doc);
    expect(canonical.tasks.map((t) => t.id)).toEqual(["UI-01", "UI-02", "BE-99", "BE-100"]);
    expect(canonical.tasks[1]?.deps).toEqual(["BE-99", "BE-100", "UI-01"]);
    expect(canonical.tasks[1]?.labels).toEqual(["alpha", "zeta"]);
    expect(Object.keys(canonical.seq)).toEqual(["UI", "BE"]);
  });

  it("puts x-* keys after known keys, alphabetically", () => {
    const doc = { "x-b": 1, ...parse(serializeDocument(minimal())), "x-a": 2 } as TasksDocument;
    expect(Object.keys(canonicalize(doc)).slice(-2)).toEqual(["x-a", "x-b"]);
  });

  it("this repository's backlog serializes to a valid document with the same tasks", () => {
    const text = readFileSync(new URL("../../../.konsora/tasks.json", import.meta.url), "utf8");
    const doc = parse(text);
    const canonical = parse(serializeDocument(doc));
    expect(canonical.tasks.map((t) => t.id).sort()).toEqual(doc.tasks.map((t) => t.id).sort());
  });
});

describe("compareTaskIds", () => {
  it("compares prefixes first, then numbers naturally", () => {
    expect(["BE-100", "BE-99", "AB-03", "BE-01"].sort(compareTaskIds)).toEqual([
      "AB-03",
      "BE-01",
      "BE-99",
      "BE-100",
    ]);
  });
});

function minimal(): TasksDocument {
  return {
    schema: "konsora/2",
    project: { name: "P", base_branch: "main" },
    groups: [{ id: "BE", name: "BE" }],
    seq: { BE: 0 },
    tasks: [],
  };
}

describe("difficulty and project.recommended (CORE-09)", () => {
  it("are written in canonical order", () => {
    const at = "2030-01-01T00:00:00Z";
    const text = serializeDocument({
      schema: "konsora/2",
      project: {
        recommended: {
          high: { model: "opus", provider: "claude", effort: "high" },
          low: { provider: "claude", model: "haiku" },
        },
        name: "P",
        base_branch: "main",
        defaults: { provider: "claude", model: "sonnet" },
      },
      groups: [{ id: "BE", name: "BE" }],
      seq: { BE: 1 },
      tasks: [
        {
          agent: { provider: "claude", model: "x" },
          difficulty: "medium",
          labels: ["a"],
          id: "BE-01",
          title: "t",
          state: "todo",
          group: "BE",
          rank: "a",
          created: { at, by: "human" },
          updated_at: at,
        },
      ],
    } as TasksDocument);
    const doc = JSON.parse(text);
    expect(Object.keys(doc.project)).toEqual(["name", "base_branch", "defaults", "recommended"]);
    expect(Object.keys(doc.project.recommended)).toEqual(["low", "high"]);
    expect(Object.keys(doc.project.recommended.high)).toEqual(["provider", "model", "effort"]);
    const keys = Object.keys(doc.tasks[0]);
    expect(keys.slice(keys.indexOf("labels"), keys.indexOf("agent") + 1)).toEqual([
      "labels",
      "difficulty",
      "agent",
    ]);
    expect(parse(text)).toBeTruthy();
  });
});

describe("project.templates (CORE-10)", () => {
  it("keep their order and criteria order, with keys and labels in canonical order", () => {
    const text = serializeDocument({
      schema: "konsora/2",
      project: {
        templates: [
          {
            difficulty: "low",
            labels: ["z", "a"],
            acceptance: [{ check: "npm test", text: "Second" }, { text: "First" }],
            name: "Zeta",
            id: "zeta",
          },
          { name: "Alpha", id: "alpha", acceptance: [], labels: [] },
        ],
        name: "P",
        base_branch: "main",
      },
      groups: [{ id: "BE", name: "BE" }],
      seq: { BE: 0 },
      tasks: [],
    } as unknown as TasksDocument);
    const doc = JSON.parse(text);
    expect(Object.keys(doc.project)).toEqual(["name", "base_branch", "templates"]);
    expect(doc.project.templates).toEqual([
      {
        id: "zeta",
        name: "Zeta",
        acceptance: [{ text: "Second", check: "npm test" }, { text: "First" }],
        labels: ["a", "z"],
        difficulty: "low",
      },
      { id: "alpha", name: "Alpha" },
    ]);
    expect(Object.keys(doc.project.templates[0])).toEqual([
      "id",
      "name",
      "acceptance",
      "labels",
      "difficulty",
    ]);
    expect(Object.keys(doc.project.templates[0].acceptance[0])).toEqual(["text", "check"]);
    expect(parse(text)).toBeTruthy();
  });
});

describe("reviewer and review notes (CORE-13, RUN-29)", () => {
  it("keeps project.reviewer and a review note's verdict through serialization", () => {
    const at = "2026-11-02T10:00:00Z";
    const doc: TasksDocument = {
      schema: "konsora/2",
      project: {
        name: "P",
        base_branch: "main",
        reviewer: { launch: "auto", agent: { model: "gpt-5", provider: "codex" } },
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
          created: { at, by: "human" },
          updated_at: at,
          notes: [
            {
              id: "n1",
              at,
              by: "agent:codex",
              kind: "review",
              text: "ok",
              run: "r-01JC8Z3K2Q",
              verdict: "approve",
            },
          ],
        },
      ],
    };
    const text = serializeDocument(doc);
    const back = JSON.parse(text) as TasksDocument;
    expect(back.project.reviewer).toEqual({
      agent: { provider: "codex", model: "gpt-5" },
      launch: "auto",
    });
    expect(Object.keys(back.project.reviewer ?? {})).toEqual(["agent", "launch"]);
    expect(back.tasks[0]?.notes?.[0]).toEqual(doc.tasks[0]?.notes?.[0]);
    expect(validateDocument(back).ok).toBe(true);
    expect(serializeDocument(back)).toBe(text);
  });
});
