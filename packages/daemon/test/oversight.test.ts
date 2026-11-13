// biome-ignore-all lint/suspicious/noExplicitAny: JSON response bodies are inspected loosely in tests.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseTasksFile,
  serializeDocument,
  type Task,
  type TasksDocument,
  taskHash,
} from "@konsora/core";
import { archiveTasks, mutate } from "@konsora/core/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { detectUnapproved } from "../src/oversight.ts";
import { Registry } from "../src/registry.ts";

const at = "2026-11-02T10:00:00Z";
const t = (id: string, state: Task["state"], extra: Partial<Task> = {}): Task => ({
  id,
  title: `Title ${id}`,
  state,
  group: "BE",
  rank: "a",
  created: { at, by: "human" },
  updated_at: at,
  ...extra,
});
const doc = (...tasks: Task[]): TasksDocument => ({
  schema: "konsora/5",
  project: { name: "P" },
  groups: [{ id: "BE", name: "Backend" }],
  seq: { BE: 9 },
  tasks,
});
const kinds = (before: TasksDocument, after: TasksDocument) =>
  detectUnapproved(before, after, at).map((f) => `${f.task}:${f.kind}`);

describe("detectUnapproved (pure)", () => {
  it.each([
    ["done → todo (reopen)", "done", "todo"],
    ["todo → done without a summary", "todo", "done"],
    ["done → doing", "done", "doing"],
  ] as const)("flags %s", (_name, from, to) => {
    expect(kinds(doc(t("BE-01", from)), doc(t("BE-01", to)))).toEqual(["BE-01:transition"]);
  });

  it.each([
    ["proposed → todo (promote)", "proposed", "todo"],
    ["todo → doing (start)", "todo", "doing"],
    ["doing → todo (pause)", "doing", "todo"],
    ["proposed → doing (promote + start)", "proposed", "doing"],
  ] as const)("lets agents do %s", (_name, from, to) => {
    expect(kinds(doc(t("BE-01", from)), doc(t("BE-01", to)))).toEqual([]);
  });

  it("lets agents reach done only by finishing, with a new summary note", () => {
    const summary = {
      id: "n1",
      at,
      by: "agent:claude" as const,
      kind: "summary" as const,
      text: "ok",
    };
    for (const from of ["doing", "todo"] as const)
      expect(kinds(doc(t("BE-01", from)), doc(t("BE-01", "done", { notes: [summary] })))).toEqual(
        [],
      );
    expect(kinds(doc(t("BE-01", "doing")), doc(t("BE-01", "done")))).toEqual(["BE-01:transition"]);
  });

  it("allows new tasks, notes, edits of unfinished work and deleting unstarted work; flags the rest", () => {
    const note = { id: "n1", at, by: "agent:claude" as const, kind: "note" as const, text: "hi" };
    expect(
      kinds(
        doc(t("BE-01", "todo")),
        doc(
          t("BE-01", "todo", { notes: [note], title: "Revised" }),
          t("BE-02", "proposed"),
          t("BE-03", "todo"),
        ),
      ),
    ).toEqual([]);
    expect(kinds(doc(t("BE-01", "todo")), doc(t("BE-01", "todo"), t("BE-02", "done")))).toEqual([
      "BE-02:created_approved",
    ]);
    expect(kinds(doc(t("BE-01", "done")), doc(t("BE-01", "done", { title: "Hijacked" })))).toEqual([
      "BE-01:edited",
    ]);
    expect(
      kinds(
        doc(t("BE-01", "todo"), t("BE-02", "done", { deps: ["BE-01"] })),
        doc(t("BE-01", "todo"), t("BE-02", "done")),
      ),
    ).toEqual(["BE-02:edited"]);
    expect(kinds(doc(t("BE-01", "todo", { notes: [note] })), doc(t("BE-01", "todo")))).toEqual([
      "BE-01:notes_rewritten",
    ]);
    expect(kinds(doc(t("BE-01", "doing")), doc())).toEqual(["BE-01:deleted"]);
    expect(kinds(doc(t("BE-01", "todo"), t("BE-02", "proposed")), doc())).toEqual([]);
  });

  it("a done task moved to the archive is not a deletion; a started one still is (CORE-18)", () => {
    const archived = (ids: string[], ...tasks: Task[]) => ({ ...doc(...tasks), archived: ids });
    expect(kinds(doc(t("BE-01", "done")), archived(["BE-01"]))).toEqual([]);
    expect(kinds(doc(t("BE-01", "doing")), archived(["BE-01"]))).toEqual(["BE-01:deleted"]);
  });
});

describe("daemon ops and oversight over HTTP", () => {
  const token = "c".repeat(64);
  const port = 4871;
  let data: string;
  let root: string;
  let app: ReturnType<typeof createApp>;
  let id: string;
  const file = () => join(root, ".konsora", "tasks.json");
  const read = () => {
    const r = parseTasksFile(readFileSync(file(), "utf8"));
    if (!r.ok) throw new Error("invalid");
    return r.document;
  };
  const writeByHand = (d: TasksDocument) => writeFileSync(file(), serializeDocument(d));
  const call = async (path: string, body?: unknown) => {
    const res = await app.request(`http://127.0.0.1:${port}/api${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        host: `127.0.0.1:${port}`,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const board = () => call(`/projects/${id}/board`);

  beforeEach(async () => {
    data = mkdtempSync(join(tmpdir(), "konsora-ov-data-"));
    root = mkdtempSync(join(tmpdir(), "konsora-ov-proj-"));
    mkdirSync(join(root, ".konsora"));
    writeByHand(doc(t("BE-01", "proposed"), t("BE-02", "done"), t("BE-03", "todo")));
    app = createApp({ token, port, registry: new Registry(data), now: () => new Date(at) });
    id = (await call("/projects", { path: root })).body.project.id;
  });
  afterEach(() => {
    rmSync(data, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("applies human ops, logs them in approvals.jsonl and does not flag its own writes", async () => {
    await board(); // baseline
    const r = await call(`/projects/${id}/ops`, { op: "promote", task: "BE-01" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      ok: true,
      changed: ["BE-01"],
      tasks: [{ id: "BE-01", state: "todo", hash: expect.any(String) }],
    });
    expect(read().tasks[0]?.state).toBe("todo");
    const ledger = readFileSync(join(data, "projects", id, "approvals.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(ledger).toEqual([
      { at, task: "BE-01", op: "promote", from: "proposed", to: "todo", actor: "human" },
    ]);
    expect((await board()).body.external).toEqual([]);
  });

  it("each UI action (with expect, as the web sends it) round-trips to the file and the ledger", async () => {
    writeByHand(
      doc(
        t("BE-01", "proposed"),
        t("BE-03", "done"),
        t("BE-04", "doing", {
          notes: [{ id: "n1", at, by: "agent:claude", kind: "question", text: "Which TTL?" }],
        }),
        t("BE-05", "doing"),
        t("BE-06", "todo", { deps: ["BE-05"] }),
      ),
    );
    await board(); // baseline: the hand-written file is the trusted starting point
    const hashOf = (task: string) => taskHash(read().tasks.find((x) => x.id === task) as Task);
    const actions = [
      { op: "promote", task: "BE-01", state: "todo" },
      { op: "reopen", task: "BE-03", state: "todo", text: "Found a bug" },
      { op: "answer", task: "BE-04", state: "doing", text: "10 minutes" },
    ];
    for (const { state, ...op } of actions) {
      const r = await call(`/projects/${id}/ops`, {
        ...op,
        expect: { [op.task]: hashOf(op.task) },
      });
      expect(r.status, op.op).toBe(200);
      expect(read().tasks.find((x) => x.id === op.task)?.state, op.op).toBe(state);
    }
    const deleted = await call(`/projects/${id}/ops`, {
      op: "delete",
      task: "BE-05",
      expect: { "BE-05": hashOf("BE-05") },
    });
    expect(deleted.status).toBe(200);
    expect(read().tasks.map((x) => x.id)).not.toContain("BE-05");
    expect(read().tasks.find((x) => x.id === "BE-06")?.deps).toBeUndefined();
    const notes = (task: string) =>
      read()
        .tasks.find((x) => x.id === task)
        ?.notes?.at(-1);
    expect(notes("BE-03")).toMatchObject({ by: "human", kind: "note", text: "Found a bug" });
    expect(notes("BE-04")).toMatchObject({ by: "human", kind: "answer", text: "10 minutes" });
    expect(notes("BE-06")).toMatchObject({ by: "human", kind: "note" });
    const ledger = readFileSync(join(data, "projects", id, "approvals.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(ledger.map((e) => [e.task, e.op, e.from, e.to, e.actor]).sort()).toEqual(
      [
        ["BE-01", "promote", "proposed", "todo", "human"],
        ["BE-03", "reopen", "done", "todo", "human"],
        ["BE-04", "answer", "doing", "doing", "human"],
        ["BE-05", "delete", "doing", undefined, "human"],
        ["BE-06", "delete", "todo", "todo", "human"],
      ].sort(),
    );
    expect((await board()).body.external).toEqual([]);
  });

  it("edits of approved work from the panel are one op each, logged, and unflagged (UI-09)", async () => {
    writeByHand(
      doc(
        t("BE-01", "done"),
        t("BE-02", "doing", { deps: ["BE-01"] }),
        t("BE-03", "todo", { acceptance: [{ id: "ac1", text: "Old" }] }),
      ),
    );
    await board();
    const hashOf = (task: string) => taskHash(read().tasks.find((x) => x.id === task) as Task);
    const edits = [
      {
        op: "edit",
        task: "BE-03",
        changes: {
          title: "New title",
          desc: "# Goal\n\nSome *markdown*",
          labels: ["m4"],
          acceptance: [
            { id: "ac1", text: "Old, reworded" },
            { id: "ac2", text: "New" },
          ],
        },
      },
      { op: "depend", task: "BE-03", on: "BE-02" },
      { op: "undepend", task: "BE-02", on: "BE-01" },
    ];
    for (const op of edits) {
      const before = readFileSync(file(), "utf8");
      const r = await call(`/projects/${id}/ops`, {
        ...op,
        expect: { [op.task]: hashOf(op.task) },
      });
      expect(r.status, op.op).toBe(200);
      expect(r.body.changed, op.op).toEqual([op.task]);
      expect(readFileSync(file(), "utf8"), op.op).not.toBe(before);
    }
    expect(read().tasks.find((x) => x.id === "BE-03")).toMatchObject({
      title: "New title",
      desc: "# Goal\n\nSome *markdown*",
      labels: ["m4"],
      deps: ["BE-02"],
      acceptance: [
        { id: "ac1", text: "Old, reworded" },
        { id: "ac2", text: "New" },
      ],
      state: "todo",
    });
    expect(read().tasks.find((x) => x.id === "BE-02")?.deps).toBeUndefined();
    const ledger = readFileSync(join(data, "projects", id, "approvals.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(ledger.map((e) => [e.task, e.op, e.from, e.to, e.actor])).toEqual([
      ["BE-03", "edit", "todo", "todo", "human"],
      ["BE-03", "depend", "todo", "todo", "human"],
      ["BE-02", "undepend", "doing", "doing", "human"],
    ]);
    expect((await board()).body.external).toEqual([]);
  });

  it("a dependency that would close a cycle is refused and the file stays the same (UI-09)", async () => {
    writeByHand(
      doc(
        t("BE-01", "todo"),
        t("BE-02", "todo", { deps: ["BE-01"] }),
        t("BE-03", "todo", { deps: ["BE-02"] }),
      ),
    );
    await board();
    const before = readFileSync(file(), "utf8");
    const hash = taskHash(read().tasks[0] as Task);
    const r = await call(`/projects/${id}/ops`, {
      op: "depend",
      task: "BE-01",
      on: "BE-03",
      expect: { "BE-01": hash },
    });
    expect([r.status, r.body.error.code]).toEqual([422, "invalid"]);
    expect(r.body.error.message).toMatch(/cycle/);
    expect(readFileSync(file(), "utf8")).toBe(before);
    // Nothing was done, so nothing is logged as the human's.
    expect(existsSync(join(data, "projects", id, "approvals.jsonl"))).toBe(false);
  });

  it("an edit based on an old version is a conflict: nothing is written and the current task comes back (UI-09)", async () => {
    await board();
    const seen = taskHash(read().tasks[2] as Task);
    await mutate(
      root,
      { op: "note", task: "BE-03", text: "meanwhile" },
      { actor: "agent:claude", at },
    );
    const before = readFileSync(file(), "utf8");
    const r = await call(`/projects/${id}/ops`, {
      op: "edit",
      task: "BE-03",
      expect: { "BE-03": seen },
      changes: { title: "Mine" },
    });
    expect([r.status, r.body.error.code]).toEqual([409, "conflict"]);
    expect(r.body.error.current).toMatchObject({ id: "BE-03", title: "Title BE-03" });
    expect(readFileSync(file(), "utf8")).toBe(before);
  });

  it("a reorder (as the board sends it) changes one rank, survives a reload and is not flagged (CORE-11)", async () => {
    writeByHand(
      doc(
        t("BE-01", "todo", { rank: "c" }),
        t("BE-02", "todo", { rank: "i" }),
        t("BE-03", "done", { rank: "x" }),
      ),
    );
    await board(); // baseline
    const r = await call(`/projects/${id}/ops`, { op: "move", task: "BE-02", before: "BE-01" });
    expect(r.status).toBe(200);
    expect(r.body.changed).toEqual(["BE-02"]);
    const ranks = Object.fromEntries(read().tasks.map((x) => [x.id, x.rank]));
    expect(ranks["BE-01"]).toBe("c");
    expect((ranks["BE-02"] as string) < "c").toBe(true);
    // An agent reorders through the store too, and neither write is an external change.
    const agent = await mutate(
      root,
      { op: "move", task: "BE-01", top: true },
      { actor: "agent:claude", at },
    );
    expect(agent.ok).toBe(true);
    const again = await board();
    expect(again.body.external).toEqual([]);
    const order = [...again.body.tasks]
      .sort((a: any, b: any) => (a.rank < b.rank ? -1 : 1))
      .map((x: any) => x.id);
    expect(order.slice(0, 2)).toEqual(["BE-01", "BE-02"]);
    expect((await call(`/projects/${id}/ops`, { op: "move", task: "BE-01" })).status).toBe(422);
  });

  it("demoting to an idea is one op from the UI or an agent, and never an external change (CORE-12)", async () => {
    await board(); // baseline
    const task = (await board()).body.tasks.find((x: any) => x.id === "BE-03");
    const r = await call(`/projects/${id}/ops`, {
      op: "demote",
      task: "BE-03",
      expect: { "BE-03": task.hash },
    });
    expect(r.status).toBe(200);
    expect(read().tasks.find((x) => x.id === "BE-03")?.state).toBe("proposed");
    expect((await call(`/projects/${id}/ops`, { op: "demote", task: "BE-02" })).status).toBe(409);
    // An agent promotes it and demotes it again through the store: still nothing to approve.
    for (const op of ["promote", "demote"] as const)
      expect((await mutate(root, { op, task: "BE-03" }, { actor: "agent:claude", at })).ok).toBe(
        true,
      );
    expect((await board()).body.external).toEqual([]);
    expect(kinds(doc(t("BE-01", "doing")), doc(t("BE-01", "proposed")))).toEqual([]);
    expect(kinds(doc(t("BE-01", "done")), doc(t("BE-01", "proposed")))).toEqual([
      "BE-01:transition",
    ]);
  });

  it("a stale expect hash is refused as a conflict and changes nothing", async () => {
    await board();
    const before = readFileSync(file(), "utf8");
    const r = await call(`/projects/${id}/ops`, {
      op: "reopen",
      task: "BE-02",
      expect: { "BE-02": "sha256:stale" },
    });
    expect([r.status, r.body.error.code]).toEqual([409, "conflict"]);
    expect(readFileSync(file(), "utf8")).toBe(before);
  });

  it("ops act as human: agent-only ops are forbidden over HTTP", async () => {
    const r = await call(`/projects/${id}/ops`, { op: "start", task: "BE-03" });
    expect([r.status, r.body.error.code]).toEqual([403, "forbidden"]);
  });

  it("rejects malformed ops and reports op errors with fitting statuses", async () => {
    expect((await call(`/projects/${id}/ops`, { op: "promote" })).status).toBe(400);
    expect(
      (await call(`/projects/${id}/ops`, { op: "promote", task: "BE-01", state: "done" })).status,
    ).toBe(400);
    expect((await call(`/projects/${id}/ops`, { op: "accept", task: "BE-02" })).status).toBe(400);
    expect((await call(`/projects/${id}/ops`, { op: "promote", task: "BE-03" })).status).toBe(409);
    expect(
      (await call(`/projects/${id}/ops`, { op: "note", task: "BE-03", text: "" })).status,
    ).toBe(422);
    expect((await call(`/projects/${id}/ops`, { op: "promote", task: "BE-99" })).status).toBe(404);
  });

  it("a conflict returns 409 with the current task", async () => {
    const seen = taskHash(read().tasks[2] as Task);
    await mutate(
      root,
      { op: "note", task: "BE-03", text: "meanwhile" },
      { actor: "agent:claude", at },
    );
    const r = await call(`/projects/${id}/ops`, {
      op: "delete",
      task: "BE-03",
      expect: { "BE-03": seen },
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({
      code: "conflict",
      task: "BE-03",
      current: { id: "BE-03", notes: [{ text: "meanwhile" }] },
    });
  });

  it("setting a task to done by hand is reported as an unapproved external change", async () => {
    await board();
    const d = read();
    (d.tasks[2] as Task).state = "done";
    writeByHand(d);
    const flags = (await board()).body.external;
    expect(flags).toEqual([
      expect.objectContaining({
        task: "BE-03",
        kind: "transition",
        from: "todo",
        to: "done",
        message: "todo → done without you (no agent op does that)",
      }),
    ]);
    expect((await board()).body.external).toHaveLength(1); // persists until resolved
  });

  it("a human note from the panel lands in the file, done tasks included, unflagged (UI-12)", async () => {
    await board();
    const r = await call(`/projects/${id}/ops`, {
      op: "note",
      task: "BE-02",
      text: "Revisa también el caso vacío",
    });
    expect(r.status).toBe(200);
    expect(read().tasks[1]?.notes).toEqual([
      { id: "n1", at, by: "human", kind: "note", text: "Revisa también el caso vacío" },
    ]);
    expect(r.body.tasks[0].notes).toHaveLength(1);
    expect((await board()).body.external).toEqual([]);
  });

  it("archiving done tasks is not flagged; the board lists them as archived (CORE-18)", async () => {
    await board();
    const result = await archiveTasks(root, "2026-11-03T00:00:00Z");
    expect(result.ok && result.moved.map((e) => e.id)).toEqual(["BE-02"]);
    const body = (await board()).body;
    expect(body.external).toEqual([]);
    expect(body.plan.archived).toEqual(["BE-02"]);
    expect(body.tasks.map((task: Task) => task.id)).not.toContain("BE-02");
    expect(body.archive).toEqual([expect.objectContaining({ id: "BE-02", state: "done" })]);
    // An unreadable archive leaves the History without them, and says why.
    writeFileSync(join(root, ".konsora", "archive.json"), "{}");
    const broken = (await board()).body;
    expect(broken.archive).toEqual([]);
    expect(broken.archiveError).toContain("archive.json is invalid");
  });

  it("agent changes through the CLI/store are not flagged", async () => {
    await board();
    await mutate(root, { op: "start", task: "BE-03" }, { actor: "agent:claude", at });
    await mutate(
      root,
      { op: "finish", task: "BE-03", summary: "done it" },
      { actor: "agent:claude", at },
    );
    expect((await board()).body.external).toEqual([]);
  });

  it("confirm clears the flag and logs it; the change stays", async () => {
    await board();
    const d = read();
    (d.tasks[1] as Task).state = "todo";
    writeByHand(d);
    await board();
    const r = await call(`/projects/${id}/external/BE-02/confirm`, {});
    expect(r.body).toMatchObject({ ok: true, confirmed: [{ task: "BE-02", kind: "transition" }] });
    expect((await board()).body.external).toEqual([]);
    expect(read().tasks[1]?.state).toBe("todo");
    expect((await call(`/projects/${id}/external`)).body.approvals).toContainEqual(
      expect.objectContaining({ task: "BE-02", op: "confirm:transition" }),
    );
  });

  it("revert restores the version before the first unapproved change", async () => {
    await board();
    const d = read();
    (d.tasks[1] as Task).state = "todo";
    (d.tasks[1] as Task).title = "Edited by hand";
    writeByHand(d);
    await board();
    const r = await call(`/projects/${id}/external/BE-02/revert`, {});
    expect(r.status).toBe(200);
    expect(read().tasks[1]).toMatchObject({ id: "BE-02", state: "done", title: "Title BE-02" });
    expect((await board()).body.external).toEqual([]);
  });

  it("revert of a task created as approved turns it into a proposal; deleted tasks come back", async () => {
    await board();
    writeByHand(doc(t("BE-01", "proposed"), t("BE-03", "todo"), t("BE-04", "done")));
    const flags = (await board()).body.external.map(
      (f: { task: string; kind: string }) => `${f.task}:${f.kind}`,
    );
    expect(flags.sort()).toEqual(["BE-02:deleted", "BE-04:created_approved"]);
    await call(`/projects/${id}/external/BE-04/revert`, {});
    await call(`/projects/${id}/external/BE-02/revert`, {});
    expect(
      read()
        .tasks.map((x) => `${x.id}:${x.state}`)
        .sort(),
    ).toEqual(["BE-01:proposed", "BE-02:done", "BE-03:todo", "BE-04:proposed"]);
  });

  it("an external change made before a UI op is still caught", async () => {
    await board();
    const d = read();
    (d.tasks[2] as Task).state = "done";
    writeByHand(d);
    const r = await call(`/projects/${id}/ops`, { op: "promote", task: "BE-01" });
    expect(r.body.external).toEqual([
      expect.objectContaining({ task: "BE-03", kind: "transition" }),
    ]);
  });

  it("a flag clears by itself when the task leaves the flagged state", async () => {
    await board();
    const d = read();
    (d.tasks[2] as Task).state = "done";
    writeByHand(d);
    await board();
    (d.tasks[2] as Task).state = "todo";
    writeByHand(d);
    expect((await board()).body.external).toEqual([]);
  });
});
