import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EMPTY_ARCHIVE, planArchive } from "../src/archive.ts";
import { deriveFlags, pendingSubgraph } from "../src/graph.ts";
import { completionLog } from "../src/history.ts";
import { applyOp } from "../src/ops.ts";
import type { Task, TasksDocument } from "../src/schema.ts";
import { parseArchiveFile, parseTasksFile, validateDocument } from "../src/semantics.ts";
import { serializeArchive, serializeDocument } from "../src/serialize.ts";
import { ARCHIVE_FILE, archiveTasks, readArchive, readTasks, tasksPath } from "../src/store.ts";

const at = "2026-11-02T10:00:00Z";
const task = (id: string, state: Task["state"], extra: Partial<Task> = {}): Task => ({
  id,
  title: `Task ${id}`,
  state,
  group: "BE",
  rank: id.slice(-2),
  created: { at, by: "agent:claude" },
  updated_at: at,
  ...extra,
});
const finished = (id: string, when: string, extra: Partial<Task> = {}): Task =>
  task(id, "done", {
    updated_at: when,
    notes: [{ id: "n1", at: when, by: "agent:claude", kind: "summary", text: `Did ${id}` }],
    ...extra,
  });
const plan = (): TasksDocument => ({
  schema: "konsora/5",
  project: { name: "P" },
  groups: [{ id: "BE", name: "Backend" }],
  seq: { BE: 5 },
  tasks: [
    finished("BE-01", "2026-10-01T09:00:00Z"),
    finished("BE-02", "2026-10-20T09:00:00Z", { deps: ["BE-01"] }),
    finished("BE-03", "2026-11-05T09:00:00Z"),
    task("BE-04", "todo", { deps: ["BE-01", "BE-02"] }),
    task("BE-05", "todo", { deps: ["BE-03"] }),
  ],
});
const codes = (doc: TasksDocument) => {
  const result = validateDocument(doc);
  return result.ok ? [] : result.issues.map((issue) => issue.code);
};

describe("planArchive (pure)", () => {
  it("moves the done tasks finished before the date, keeping their ids in archived", () => {
    const { document, archive, moved } = planArchive(plan(), EMPTY_ARCHIVE, "2026-11-01T00:00:00Z");
    expect(moved.map((e) => e.id)).toEqual(["BE-02", "BE-01"]);
    expect(document.tasks.map((t) => t.id)).toEqual(["BE-03", "BE-04", "BE-05"]);
    expect(document.archived).toEqual(["BE-01", "BE-02"]);
    expect(archive.tasks.map((t) => t.id)).toEqual(["BE-01", "BE-02"]);
    expect(archive.tasks[1]).toEqual(plan().tasks[1]); // as it was, notes included
    expect(codes(document)).toEqual([]);
  });

  it("nothing old enough leaves both documents as they were", () => {
    const doc = plan();
    const result = planArchive(doc, EMPTY_ARCHIVE, "2026-09-01T00:00:00Z");
    expect(result.moved).toEqual([]);
    expect(result.document).toBe(doc);
    expect(result.archive).toBe(EMPTY_ARCHIVE);
  });

  it("adds to an existing archive", () => {
    const first = planArchive(plan(), EMPTY_ARCHIVE, "2026-10-10T00:00:00Z");
    const second = planArchive(first.document, first.archive, "2026-11-10T00:00:00Z");
    expect(second.document.archived).toEqual(["BE-01", "BE-02", "BE-03"]);
    expect(second.archive.tasks.map((t) => t.id)).toEqual(["BE-01", "BE-02", "BE-03"]);
    expect(second.document.tasks.map((t) => t.id)).toEqual(["BE-04", "BE-05"]);
  });
});

describe("archived ids in the plan", () => {
  const archived = () => planArchive(plan(), EMPTY_ARCHIVE, "2026-11-01T00:00:00Z").document;

  it("a dependency on an archived task counts as done", () => {
    const doc = archived();
    expect(deriveFlags(doc).get("BE-04")).toMatchObject({ blocked: false, ready: true });
    const started = applyOp(doc, { op: "start", task: "BE-04" }, { actor: "agent:claude", at });
    expect(started.ok).toBe(true);
    expect(pendingSubgraph("BE-04", doc)).toEqual(["BE-04"]);
  });

  it("their ids are never reused: seq must cover them, and a live task cannot take one", () => {
    const doc = archived();
    expect(codes({ ...doc, seq: { BE: 1 } })).toContain("seq_behind");
    expect(codes({ ...doc, tasks: [...doc.tasks, task("BE-01", "todo")] })).toContain(
      "duplicate_id",
    );
    expect(codes({ ...doc, archived: ["BE-01", "BE-01", "BE-02"] })).toContain(
      "duplicate_archived",
    );
    expect(codes({ ...doc, archived: ["XX-01"] })).toContain("unknown_id_prefix");
    // A task created after archiving gets the next number.
    const created = applyOp(
      doc,
      { op: "propose", title: "New", group: "BE" },
      { actor: "agent:claude", at },
    );
    expect(created.ok && created.created).toEqual(["BE-06"]);
  });

  it("serializes archived in natural id order, right before the tasks, and omits it when empty", () => {
    const doc = { ...archived(), archived: ["BE-10", "BE-02", "BE-01"], seq: { BE: 10 } };
    const text = serializeDocument(doc);
    expect(text.indexOf('"archived"')).toBeLessThan(text.indexOf('"tasks"'));
    expect(text.indexOf('"seq"')).toBeLessThan(text.indexOf('"archived"'));
    expect(JSON.parse(text).archived).toEqual(["BE-01", "BE-02", "BE-10"]);
    expect(serializeDocument({ ...doc, archived: [] })).not.toContain('"archived"');
    expect(parseTasksFile(text).ok).toBe(true);
  });

  it("the History includes archived tasks, marked as such", () => {
    const { document, archive } = planArchive(plan(), EMPTY_ARCHIVE, "2026-11-01T00:00:00Z");
    expect(completionLog(document, archive.tasks).map((e) => [e.id, e.archived ?? false])).toEqual([
      ["BE-03", false],
      ["BE-02", true],
      ["BE-01", true],
    ]);
  });
});

describe("archive file", () => {
  it("round-trips canonically and refuses tasks that are not done or repeated", () => {
    const { archive } = planArchive(plan(), EMPTY_ARCHIVE, "2026-11-01T00:00:00Z");
    const text = serializeArchive(archive);
    const parsed = parseArchiveFile(text);
    expect(parsed.ok && serializeArchive(parsed.archive)).toBe(text);
    const bad = { ...archive, tasks: [...archive.tasks, archive.tasks[0], task("BE-09", "todo")] };
    const result = parseArchiveFile(JSON.stringify(bad));
    expect(result.ok ? [] : result.issues.map((i) => i.code)).toEqual([
      "duplicate_id",
      "archived_not_done",
    ]);
  });
});

describe("archiveTasks (store)", () => {
  let root: string;
  const archivePath = () => join(root, ".konsora", ARCHIVE_FILE);
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "konsora-archive-"));
    mkdirSync(join(root, ".konsora"));
    writeFileSync(tasksPath(root), serializeDocument(plan()));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("without write only reports what would move", async () => {
    const before = readFileSync(tasksPath(root), "utf8");
    const result = await archiveTasks(root, "2026-11-01T00:00:00Z", { write: false });
    expect(result.ok && result.moved.map((e) => e.id)).toEqual(["BE-02", "BE-01"]);
    expect(readFileSync(tasksPath(root), "utf8")).toBe(before);
    expect(existsSync(archivePath())).toBe(false);
  });

  it("writes the archive and the plan; both stay valid and readable", async () => {
    const result = await archiveTasks(root, "2026-11-01T00:00:00Z");
    expect(result.ok).toBe(true);
    const read = await readTasks(root);
    expect(read.ok && read.document.archived).toEqual(["BE-01", "BE-02"]);
    const archive = await readArchive(root);
    expect(archive.ok && archive.archive.tasks.map((t) => t.id)).toEqual(["BE-01", "BE-02"]);
    // Again with the same date: nothing left to move, nothing written.
    const text = readFileSync(tasksPath(root), "utf8");
    const again = await archiveTasks(root, "2026-11-01T00:00:00Z");
    expect(again.ok && again.moved).toEqual([]);
    expect(readFileSync(tasksPath(root), "utf8")).toBe(text);
  });

  it("an interrupted run (tasks in both files) is finished by running it again", async () => {
    const first = planArchive(plan(), EMPTY_ARCHIVE, "2026-11-01T00:00:00Z");
    writeFileSync(archivePath(), serializeArchive(first.archive)); // the plan write never happened
    const result = await archiveTasks(root, "2026-11-01T00:00:00Z");
    expect(result.ok).toBe(true);
    const archive = await readArchive(root);
    expect(archive.ok && archive.archive.tasks.map((t) => t.id)).toEqual(["BE-01", "BE-02"]);
  });

  it("refuses an invalid archive file and writes nothing", async () => {
    writeFileSync(archivePath(), '{"schema":"konsora-archive/1","tasks":[1]}');
    const before = readFileSync(tasksPath(root), "utf8");
    const result = await archiveTasks(root, "2026-11-01T00:00:00Z");
    expect(result.ok ? null : [result.error.code, result.error.file]).toEqual([
      "invalid",
      "archive",
    ]);
    expect(readFileSync(tasksPath(root), "utf8")).toBe(before);
  });

  it("a missing archive file reads as empty", async () => {
    const read = await readArchive(root);
    expect(read.ok && read.archive.tasks).toEqual([]);
    expect(read.ok && read.text).toBeNull();
  });
});
