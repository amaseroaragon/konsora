/** fast-check generators for valid `konsora/4` documents, shared by core property tests. */
import fc from "fast-check";
import type { Note, Task, TasksDocument } from "../src/schema.ts";

const GROUP_IDS = ["BE", "FE", "CORE", "UI", "OPS", "X1"] as const;

/** Small alphabet that still exercises escaping: accents, emoji, quotes, slashes, newlines, braces. */
const CHARS = [
  ..."abcxyzABZ09 -_.",
  "á",
  "ñ",
  "€",
  "😀",
  '"',
  "\\",
  "/",
  "\n",
  "\t",
  "{",
  "}",
  ",",
  ":",
];
const LOWER = [..."0123456789abcdefghijklmnopqrstuvwxyz"];

const text = (max: number) =>
  fc
    .string({ minLength: 1, maxLength: max, unit: fc.constantFrom(...CHARS) })
    .filter((s) => s.trim().length > 0);
const lowerString = (min: number, max: number) =>
  fc.string({ minLength: min, maxLength: max, unit: fc.constantFrom(...LOWER) });

export const timestamp = fc
  .integer({ min: Date.UTC(2020, 0, 1) / 1000, max: Date.UTC(2035, 11, 31) / 1000 })
  .map((s) => new Date(s * 1000).toISOString().replace(".000Z", "Z"));

const actor = fc.constantFrom("human", "konsora", "agent:claude", "agent:codex");

const noteBody = fc.record(
  {
    at: timestamp,
    by: actor,
    kind: fc.constantFrom("note", "question", "answer", "feedback", "summary"),
    text: text(40),
    edited: timestamp,
  },
  { requiredKeys: ["at", "by", "kind", "text"] },
);

/** Everything about a task except its id and deps, which depend on its position. */
const taskSpec = fc.record(
  {
    groupPick: fc.nat(),
    title: text(30),
    state: fc.constantFrom("proposed", "todo", "doing", "done"),
    depPicks: fc.uniqueArray(fc.nat({ max: 11 }), { maxLength: 3 }),
    rank: lowerString(1, 4),
    desc: text(60),
    acceptance: fc.array(text(30), { maxLength: 3 }),
    labels: fc.uniqueArray(lowerString(1, 8), { maxLength: 3 }),
    blockPick: fc.constantFrom(0, 1, 2),
    createdAt: timestamp,
    createdBy: actor,
    updatedAt: timestamp,
    notes: fc.array(noteBody, { maxLength: 3 }),
  },
  {
    requiredKeys: [
      "groupPick",
      "title",
      "state",
      "depPicks",
      "rank",
      "createdAt",
      "createdBy",
      "updatedAt",
    ],
  },
);

const templatesArb = fc.uniqueArray(
  fc.record(
    {
      id: fc.constantFrom("bug", "feature", "spike", "chore"),
      name: text(20),
      desc: text(40),
      acceptance: fc.array(fc.record({ text: text(20) }), { maxLength: 3 }),
      labels: fc.uniqueArray(lowerString(1, 8), { maxLength: 3 }),
    },
    { requiredKeys: ["id", "name"] },
  ),
  { selector: (t) => t.id, maxLength: 3 },
);

/** A valid document: unique ids, deps only on earlier tasks (so acyclic), seq ≥ max id. */
export const documentArb: fc.Arbitrary<TasksDocument> = fc
  .record({
    groups: fc.uniqueArray(fc.constantFrom(...GROUP_IDS), { minLength: 1, maxLength: 4 }),
    specs: fc.array(taskSpec, { maxLength: 12 }),
    seqSlack: fc.integer({ min: 0, max: 3 }),
    withSchemaRef: fc.boolean(),
    templates: templatesArb,
    extension: fc.option(fc.dictionary(fc.constantFrom("x-editor", "x-color"), fc.integer()), {
      nil: undefined,
    }),
  })
  .map(({ groups, specs, seqSlack, withSchemaRef, templates, extension }) => {
    const counters = new Map<string, number>();
    const tasks: Task[] = specs.map((spec) => {
      const group = groups[spec.groupPick % groups.length] as string;
      const n = (counters.get(group) ?? 0) + 1;
      counters.set(group, n);
      const task: Task = {
        id: `${group}-${String(n).padStart(2, "0")}`,
        title: spec.title,
        state: spec.state,
        group,
        rank: spec.rank,
        created: { at: spec.createdAt, by: spec.createdBy },
        updated_at: spec.updatedAt,
      };
      if (spec.desc) task.desc = spec.desc;
      if (spec.acceptance?.length) {
        task.acceptance = spec.acceptance.map((t, j) => ({ id: `ac${j + 1}`, text: t }));
      }
      if (spec.labels?.length) task.labels = spec.labels;
      if (spec.blockPick === 1) task.block = "cache";
      if (spec.notes?.length) {
        task.notes = spec.notes.map((body, j) => ({ id: `n${j + 1}`, ...body }) as Note);
      }
      return task;
    });
    specs.forEach((spec, i) => {
      const earlier = spec.depPicks.filter((d) => d < i);
      if (earlier.length) (tasks[i] as Task).deps = earlier.map((d) => (tasks[d] as Task).id);
    });
    return {
      ...(withSchemaRef ? { $schema: "../schema/tasks.v4.schema.json" } : {}),
      schema: "konsora/4",
      project: {
        name: "Generated",
        ...(templates.length ? { templates } : {}),
      },
      groups: groups.map((id) => ({ id, name: `Group ${id}` })),
      seq: Object.fromEntries(groups.map((g) => [g, (counters.get(g) ?? 0) + seqSlack])),
      ...(tasks.some((t) => t.block)
        ? {
            blocks: [
              {
                id: "cache",
                name: "Cache",
                branch: "konsora/cache",
                base: "main",
                created: { at: "2026-01-01T00:00:00Z", by: "human" },
              },
            ],
          }
        : {}),
      tasks,
      ...extension,
    } as TasksDocument;
  });

/** Same content, non-canonical form: shuffled arrays/keys and empty optionals added. */
export function scramble(doc: TasksDocument, seed: number): TasksDocument {
  let state = seed || 1;
  const rand = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const shuffle = <T>(items: readonly T[]): T[] => {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [out[i], out[j]] = [out[j] as T, out[i] as T];
    }
    return out;
  };
  const shuffleKeys = <T extends object>(obj: T): T =>
    Object.fromEntries(shuffle(Object.entries(obj))) as T;
  return shuffleKeys({
    ...doc,
    project: shuffleKeys({
      ...doc.project,
      templates: doc.project.templates ?? [],
    }),
    seq: shuffleKeys({ ...doc.seq }),
    tasks: shuffle(doc.tasks).map((task) =>
      shuffleKeys({
        ...task,
        deps: task.deps ? shuffle(task.deps) : [],
        labels: task.labels ? shuffle(task.labels) : [],
        notes: task.notes?.map(shuffleKeys) ?? [],
        created: shuffleKeys({ ...task.created }),
        desc: task.desc ?? "",
      }),
    ),
  });
}
