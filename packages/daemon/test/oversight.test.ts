// biome-ignore-all lint/suspicious/noExplicitAny: JSON response bodies are inspected loosely in tests.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseTasksFile,
  serializeDocument,
  type Task,
  type TasksDocument,
  taskHash,
} from "@konsora/core";
import { mutate } from "@konsora/core/store";
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
  schema: "konsora/2",
  project: { name: "P", base_branch: "main" },
  groups: [{ id: "BE", name: "Backend" }],
  seq: { BE: 9 },
  tasks,
});
const kinds = (before: TasksDocument, after: TasksDocument) =>
  detectUnapproved(before, after, at).map((f) => `${f.task}:${f.kind}`);

describe("detectUnapproved (pure)", () => {
  it.each([
    ["proposed → todo (approve)", "proposed", "todo"],
    ["review → done (accept)", "review", "done"],
    ["doing → done (skipping review)", "doing", "done"],
    ["review → todo (send back)", "review", "todo"],
    ["done → todo (reopen)", "done", "todo"],
  ] as const)("flags %s", (_name, from, to) => {
    expect(kinds(doc(t("BE-01", from)), doc(t("BE-01", to)))).toEqual(["BE-01:transition"]);
  });

  it.each([
    ["todo → doing (start)", "todo", "doing"],
    ["doing → review (finish)", "doing", "review"],
    ["doing → todo (pause)", "doing", "todo"],
  ] as const)("lets agents do %s", (_name, from, to) => {
    expect(kinds(doc(t("BE-01", from)), doc(t("BE-01", to)))).toEqual([]);
  });

  it("allows new proposals, appended notes and added deps; flags the rest", () => {
    const note = { id: "n1", at, by: "agent:claude" as const, kind: "note" as const, text: "hi" };
    expect(
      kinds(
        doc(t("BE-01", "todo")),
        doc(t("BE-01", "todo", { notes: [note], deps: [] }), t("BE-02", "proposed")),
      ),
    ).toEqual([]);
    expect(kinds(doc(t("BE-01", "todo")), doc(t("BE-01", "todo"), t("BE-02", "todo")))).toEqual([
      "BE-02:created_approved",
    ]);
    expect(kinds(doc(t("BE-01", "todo")), doc(t("BE-01", "todo", { title: "Hijacked" })))).toEqual([
      "BE-01:edited",
    ]);
    expect(
      kinds(doc(t("BE-01", "proposed")), doc(t("BE-01", "proposed", { title: "Revised" }))),
    ).toEqual([]);
    expect(
      kinds(
        doc(t("BE-01", "todo"), t("BE-02", "todo", { deps: ["BE-01"] })),
        doc(t("BE-01", "todo"), t("BE-02", "todo")),
      ),
    ).toEqual(["BE-02:edited"]);
    expect(kinds(doc(t("BE-01", "todo", { notes: [note] })), doc(t("BE-01", "todo")))).toEqual([
      "BE-01:notes_rewritten",
    ]);
    expect(kinds(doc(t("BE-01", "todo")), doc())).toEqual(["BE-01:deleted"]);
    expect(kinds(doc(t("BE-01", "proposed")), doc())).toEqual([]); // withdrawing a proposal is fine
    expect(kinds(doc(t("BE-01", "todo")), doc(t("BE-01", "todo", { yolo: true })))).toEqual([
      "BE-01:edited",
    ]);
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
    writeByHand(doc(t("BE-01", "proposed"), t("BE-02", "review"), t("BE-03", "todo")));
    app = createApp({ token, port, registry: new Registry(data), now: () => new Date(at) });
    id = (await call("/projects", { path: root })).body.project.id;
  });
  afterEach(() => {
    rmSync(data, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("applies human ops, logs them in approvals.jsonl and does not flag its own writes", async () => {
    await board(); // baseline
    const r = await call(`/projects/${id}/ops`, { op: "approve", task: "BE-01" });
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
      { at, task: "BE-01", op: "approve", from: "proposed", to: "todo", actor: "human" },
    ]);
    expect((await board()).body.external).toEqual([]);
  });

  it("ops act as human: agent-only ops are forbidden over HTTP", async () => {
    const r = await call(`/projects/${id}/ops`, { op: "start", task: "BE-03" });
    expect([r.status, r.body.error.code]).toEqual([403, "forbidden"]);
  });

  it("rejects malformed ops and reports op errors with fitting statuses", async () => {
    expect((await call(`/projects/${id}/ops`, { op: "approve" })).status).toBe(400);
    expect(
      (await call(`/projects/${id}/ops`, { op: "approve", task: "BE-01", state: "done" })).status,
    ).toBe(400);
    expect((await call(`/projects/${id}/ops`, { op: "accept", task: "BE-03" })).status).toBe(409);
    expect(
      (await call(`/projects/${id}/ops`, { op: "send-back", task: "BE-02", feedback: "" })).status,
    ).toBe(422);
    expect((await call(`/projects/${id}/ops`, { op: "approve", task: "BE-99" })).status).toBe(404);
  });

  it("a conflict returns 409 with the current task", async () => {
    const seen = taskHash(read().tasks[1] as Task);
    await mutate(
      root,
      { op: "note", task: "BE-02", text: "meanwhile" },
      { actor: "agent:claude", at },
    );
    const r = await call(`/projects/${id}/ops`, {
      op: "accept",
      task: "BE-02",
      expect: { "BE-02": seen },
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({
      code: "conflict",
      task: "BE-02",
      current: { id: "BE-02", notes: [{ text: "meanwhile" }] },
    });
  });

  it("setting a task to done by hand is reported as an unapproved external change", async () => {
    await board();
    const d = read();
    (d.tasks[1] as Task).state = "done";
    writeByHand(d);
    const flags = (await board()).body.external;
    expect(flags).toEqual([
      expect.objectContaining({
        task: "BE-02",
        kind: "transition",
        from: "review",
        to: "done",
        message: "review → done without your approval",
      }),
    ]);
    expect((await board()).body.external).toHaveLength(1); // persists until resolved
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
    (d.tasks[0] as Task).state = "todo";
    writeByHand(d);
    await board();
    const r = await call(`/projects/${id}/external/BE-01/confirm`, {});
    expect(r.body).toMatchObject({ ok: true, confirmed: [{ task: "BE-01", kind: "transition" }] });
    expect((await board()).body.external).toEqual([]);
    expect(read().tasks[0]?.state).toBe("todo");
    expect((await call(`/projects/${id}/external`)).body.approvals).toContainEqual(
      expect.objectContaining({ task: "BE-01", op: "confirm:transition" }),
    );
  });

  it("revert restores the version before the first unapproved change", async () => {
    await board();
    const d = read();
    (d.tasks[1] as Task).state = "done";
    (d.tasks[1] as Task).title = "Edited by hand";
    writeByHand(d);
    await board();
    const r = await call(`/projects/${id}/external/BE-02/revert`, {});
    expect(r.status).toBe(200);
    expect(read().tasks[1]).toMatchObject({ id: "BE-02", state: "review", title: "Title BE-02" });
    expect((await board()).body.external).toEqual([]);
  });

  it("revert of a task created as approved turns it into a proposal; deleted tasks come back", async () => {
    await board();
    writeByHand(doc(t("BE-01", "proposed"), t("BE-02", "review"), t("BE-04", "todo")));
    const flags = (await board()).body.external.map(
      (f: { task: string; kind: string }) => `${f.task}:${f.kind}`,
    );
    expect(flags.sort()).toEqual(["BE-03:deleted", "BE-04:created_approved"]);
    await call(`/projects/${id}/external/BE-04/revert`, {});
    await call(`/projects/${id}/external/BE-03/revert`, {});
    expect(
      read()
        .tasks.map((x) => `${x.id}:${x.state}`)
        .sort(),
    ).toEqual(["BE-01:proposed", "BE-02:review", "BE-03:todo", "BE-04:proposed"]);
  });

  it("an external change made before a UI op is still caught", async () => {
    await board();
    const d = read();
    (d.tasks[1] as Task).state = "done";
    writeByHand(d);
    const r = await call(`/projects/${id}/ops`, { op: "approve", task: "BE-01" });
    expect(r.body.external).toEqual([
      expect.objectContaining({ task: "BE-02", kind: "transition" }),
    ]);
  });

  it("a flag clears by itself when the task leaves the flagged state", async () => {
    await board();
    const d = read();
    (d.tasks[1] as Task).state = "done";
    writeByHand(d);
    await board();
    (d.tasks[1] as Task).state = "review";
    writeByHand(d);
    expect((await board()).body.external).toEqual([]);
  });
});
